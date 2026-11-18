import type { Connector, ConnectorQuery, ReadPage, SourceRecord } from '@dmc/contracts';

/** How a connection to a REST API is described (the connection's `config`). Secrets are never in it: `secretRef` is resolved at run time. */
export interface RestConfig {
  baseUrl: string;
  /** http is refused unless this is set (local development only) */
  allowInsecure?: boolean;
  auth?: { type: 'bearer' } | { type: 'basic'; username: string } | { type: 'header'; header: string };
  headers?: Record<string, string>;
  /** where the records are in the response body, as a dotted path; omit when the body is the array */
  recordsPath?: string;
  paging?:
    | { style: 'offset'; offsetParam?: string; limitParam?: string }
    | { style: 'page'; pageParam?: string; sizeParam?: string; firstPage?: number }
    | { style: 'cursor'; cursorParam: string; nextCursorPath: string; limitParam?: string }
    | { style: 'link' };
  /** query parameter that carries the last high-water mark on incremental runs */
  sinceParam?: string;
  timeoutMs?: number;
}

export interface RestDeps {
  /** turns a secret reference into the secret (from the secret store). Never logged. */
  resolveSecret(ref: string): Promise<string>;
  fetch?: typeof fetch;
}

const at = (v: unknown, path: string | undefined): unknown => (path ? path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), v) : v);

const parse = (config: Record<string, unknown>): RestConfig => {
  const c = config as unknown as RestConfig & { secretRef?: string };
  if (typeof c.baseUrl !== 'string') throw new Error('REST connection needs baseUrl');
  const u = new URL(c.baseUrl);
  if (u.protocol !== 'https:' && !(c.allowInsecure && u.protocol === 'http:')) throw new Error('REST connections must use https');
  return c;
};

/** A generic REST connector: auth, paging, incremental reads. A job's `query` is a path with its fixed query string, for example `/v1/apps?status=live`. */
export function restConnector(deps: RestDeps): Connector {
  const doFetch = deps.fetch ?? fetch;

  async function headers(cfg: RestConfig, secretRef: string | undefined): Promise<Record<string, string>> {
    const h: Record<string, string> = { accept: 'application/json', ...(cfg.headers ?? {}) };
    if (cfg.auth) {
      if (!secretRef) throw new Error('REST connection has auth but no secretRef');
      const secret = await deps.resolveSecret(secretRef);
      if (cfg.auth.type === 'bearer') h.authorization = `Bearer ${secret}`;
      else if (cfg.auth.type === 'basic') h.authorization = `Basic ${Buffer.from(`${cfg.auth.username}:${secret}`).toString('base64')}`;
      else h[cfg.auth.header.toLowerCase()] = secret;
    }
    return h;
  }

  /** Never put the secret or the full URL with parameters in an error: say what failed and where it stopped. */
  async function get(cfg: RestConfig, url: URL, h: Record<string, string>): Promise<{ body: unknown; link: string | undefined }> {
    const res = await doFetch(url, { headers: h, redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000) });
    if (!res.ok) {
      const retry = res.headers.get('retry-after');
      throw new Error(`${url.origin}${url.pathname} answered ${res.status}${retry ? ` (retry after ${retry}s)` : ''}`);
    }
    const link = /<([^>]+)>;\s*rel="?next"?/.exec(res.headers.get('link') ?? '')?.[1];
    return { body: await res.json(), link };
  }

  return {
    async test(config) {
      try {
        const cfg = parse(config);
        const h = await headers(cfg, (config as { secretRef?: string }).secretRef);
        const res = await doFetch(new URL(cfg.baseUrl), { headers: h, redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000) });
        return res.status < 500 && res.status !== 401 && res.status !== 403 ? { ok: true } : { ok: false, message: `The API answered ${res.status}` };
      } catch (e) { return { ok: false, message: (e as Error).message }; }
    },

    async read(config, q: ConnectorQuery, pageCursor, since): Promise<ReadPage> {
      const cfg = parse(config);
      const h = await headers(cfg, (config as { secretRef?: string }).secretRef);
      const base = new URL(cfg.baseUrl);
      const paging = cfg.paging;
      let url: URL;
      if (paging?.style === 'link' && pageCursor) {
        url = new URL(pageCursor, base);
        if (url.origin !== base.origin) throw new Error('The API sent a next link on another host; refusing to follow it');
      } else {
        const rel = q.text.startsWith('/') ? q.text.slice(1) : q.text;
        url = new URL(rel, base.href.endsWith('/') ? base.href : `${base.href}/`);
        if (url.origin !== base.origin) throw new Error('The job query points at another host');
        if (since && cfg.sinceParam) url.searchParams.set(cfg.sinceParam, since);
        if (paging?.style === 'offset') {
          url.searchParams.set(paging.limitParam ?? 'limit', String(q.pageSize));
          url.searchParams.set(paging.offsetParam ?? 'offset', pageCursor ?? '0');
        } else if (paging?.style === 'page') {
          url.searchParams.set(paging.sizeParam ?? 'page_size', String(q.pageSize));
          url.searchParams.set(paging.pageParam ?? 'page', pageCursor ?? String(paging.firstPage ?? 1));
        } else if (paging?.style === 'cursor') {
          if (paging.limitParam) url.searchParams.set(paging.limitParam, String(q.pageSize));
          if (pageCursor) url.searchParams.set(paging.cursorParam, pageCursor);
        }
      }

      const { body, link } = await get(cfg, url, h);
      const found = at(body, cfg.recordsPath);
      if (!Array.isArray(found)) throw new Error(`The API response has no list of records at "${cfg.recordsPath ?? '(body)'}"`);
      const records = found as SourceRecord[];

      let nextCursor: string | null = null;
      let done = true;
      if (paging?.style === 'offset') { nextCursor = String(Number(pageCursor ?? 0) + records.length); done = records.length < q.pageSize; }
      else if (paging?.style === 'page') { nextCursor = String(Number(pageCursor ?? paging.firstPage ?? 1) + 1); done = records.length < q.pageSize; }
      else if (paging?.style === 'cursor') { const n = at(body, paging.nextCursorPath); nextCursor = n === null || n === undefined || n === '' ? null : String(n); done = nextCursor === null; }
      else if (paging?.style === 'link') { nextCursor = link ?? null; done = !link; }

      const highWater = q.cursorField
        ? records.reduce<string | null>((m, r) => { const v = r[q.cursorField!]; return v === undefined || v === null ? m : m === null || String(v) > m ? String(v) : m; }, null)
        : null;
      return { records, nextCursor, done, highWater };
    },
  };
}
