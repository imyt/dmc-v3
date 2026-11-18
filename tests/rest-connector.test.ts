import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal } from '../packages/contracts/src/index';
import { migrateModule, provisionModule } from '../packages/platform/src/index';
import { SyncService, compileJob, resolveJob, restConnector } from '../packages/connectors/src/index';

const APPS = Array.from({ length: 5 }, (_, i) => ({ id: `a${i + 1}`, name: `App ${i + 1}`, updated: `2026-01-0${i + 1}` }));
let server: Server; let base = '';
const seen: { url: string; auth?: string; key?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    seen.push({ url: req.url!, auth: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined });
    const send = (code: number, body: unknown, extra: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };
    const since = u.searchParams.get('since');
    const rows = since ? APPS.filter((a) => a.updated > since) : APPS;
    if (u.pathname === '/offset') { const o = Number(u.searchParams.get('offset')); const l = Number(u.searchParams.get('limit')); return send(200, { data: { items: rows.slice(o, o + l) } }); }
    if (u.pathname === '/page') { const p = Number(u.searchParams.get('page')); const s = Number(u.searchParams.get('page_size')); return send(200, rows.slice((p - 1) * s, p * s)); }
    if (u.pathname === '/cursor') { const c = Number(u.searchParams.get('after') ?? 0); const s = 2; const next = c + s < rows.length ? String(c + s) : null; return send(200, { items: rows.slice(c, c + s), meta: { next } }); }
    if (u.pathname === '/link') { const c = Number(u.searchParams.get('c') ?? 0); const more = c + 2 < rows.length; return send(200, { items: rows.slice(c, c + 2) }, more ? { link: `</link?c=${c + 2}>; rel="next"` } : {}); }
    if (u.pathname === '/evil') return send(200, { items: [] }, { link: '<http://other.example/x>; rel="next"' });
    if (u.pathname === '/down') return send(503, { error: 'busy' }, { 'retry-after': '7' });
    if (u.pathname === '/shape') return send(200, { nothing: true });
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const secrets = { async resolveSecret(ref: string) { if (ref !== 'sm/rest') throw new Error('no such secret'); return 'S3CRET'; } };
const conn = (extra: Record<string, unknown>) => ({ baseUrl: base, allowInsecure: true, secretRef: 'sm/rest', ...extra });
const readAll = async (config: Record<string, unknown>, text: string, pageSize = 2, since: string | null = null, cursorField?: string) => {
  const c = restConnector(secrets);
  const out: Record<string, unknown>[] = []; let cursor: string | null = null; let pages = 0; let high: string | null = null;
  for (;;) {
    const p = await c.read(config, { text, pageSize, cursorField }, cursor, since); pages++;
    out.push(...p.records); high = p.highWater ?? high;
    if (p.done) break;
    cursor = p.nextCursor;
  }
  return { ids: out.map((r) => r.id), pages, high };
};

describe('S4: REST connector', () => {
  it('pages by offset, by page number, by cursor and by Link header, and reads every record once', async () => {
    expect((await readAll(conn({ recordsPath: 'data.items', paging: { style: 'offset' } }), '/offset')).ids).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect((await readAll(conn({ paging: { style: 'page' } }), '/page')).ids).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect((await readAll(conn({ recordsPath: 'items', paging: { style: 'cursor', cursorParam: 'after', nextCursorPath: 'meta.next' } }), '/cursor')).ids).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    const link = await readAll(conn({ recordsPath: 'items', paging: { style: 'link' } }), '/link');
    expect(link).toMatchObject({ ids: ['a1', 'a2', 'a3', 'a4', 'a5'], pages: 3 });
  });

  it('incremental: sends the last high-water mark and reports the new one', async () => {
    const r = await readAll(conn({ paging: { style: 'page' }, sinceParam: 'since' }), '/page', 10, '2026-01-03', 'updated');
    expect(r).toMatchObject({ ids: ['a4', 'a5'], high: '2026-01-05' });
  });

  it('authenticates with the secret from the store: bearer, basic and header', async () => {
    seen.length = 0;
    await readAll(conn({ auth: { type: 'bearer' }, paging: { style: 'page' } }), '/page');
    await readAll(conn({ auth: { type: 'basic', username: 'svc' }, paging: { style: 'page' } }), '/page');
    await readAll(conn({ auth: { type: 'header', header: 'X-API-Key' }, paging: { style: 'page' } }), '/page');
    expect(seen[0]!.auth).toBe('Bearer S3CRET');
    expect(seen.find((s) => s.auth?.startsWith('Basic'))!.auth).toBe(`Basic ${Buffer.from('svc:S3CRET').toString('base64')}`);
    expect(seen.at(-1)!.key).toBe('S3CRET');
  });

  it('errors say where and what, without the secret or the query string; a 503 carries Retry-After', async () => {
    await expect(readAll(conn({ auth: { type: 'bearer' } }), '/down?token=x')).rejects.toThrow(/\/down answered 503 \(retry after 7s\)/);
    await expect(readAll(conn({ auth: { type: 'bearer' } }), '/down?token=x')).rejects.not.toThrow(/S3CRET|token=x/);
    await expect(readAll(conn({ recordsPath: 'items' }), '/shape')).rejects.toThrow(/no list of records at "items"/);
  });

  it('refuses http without allowInsecure, a next link on another host, and a query that points elsewhere', async () => {
    await expect(readAll({ baseUrl: base, secretRef: 'sm/rest' }, '/page')).rejects.toThrow(/must use https/);
    await expect(readAll(conn({ recordsPath: 'items', paging: { style: 'link' } }), '/evil')).rejects.toThrow(/another host/);
    await expect(readAll(conn({}), 'http://other.example/page')).rejects.toThrow(/another host/);
  });

  it('test() checks the connection without reading data', async () => {
    const c = restConnector(secrets);
    expect(await c.test(conn({ auth: { type: 'bearer' } }))).toEqual({ ok: true });
    expect((await c.test({ baseUrl: 'https://x.example', secretRef: 'nope', auth: { type: 'bearer' } })).ok).toBe(false);
  });
});

describe('S4: a job over the REST connector', () => {
  it('syncs a fixture API into signals', async () => {
    const pgServer = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-rest-')), user: 'postgres', password: 'pw', port: 54345, persistent: false });
    await pgServer.initialise(); await pgServer.start();
    const admin = new pg.Client({ host: 'localhost', port: 54345, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
    try {
      await provisionModule(admin, 'connectors', { password: 'con' });
      await migrateModule(admin, 'connectors', join(import.meta.dirname, '../packages/connectors/migrations'));
      await admin.query('grant all on all tables in schema connectors to dmc_connectors');
      await admin.query('grant all on all sequences in schema connectors to dmc_connectors');
      const db = new pg.Client({ host: 'localhost', port: 54345, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await db.connect();
      const signals: Signal[] = [];
      const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
      const svc = new SyncService({ connectors: { rest: restConnector(secrets) }, signals: { async submit(x) { signals.push(...x); } }, exceptions, sleep: async () => {} });
      await svc.upsertConnection(db, { name: 'cmdb', environment: 'local', type: 'rest', secretRef: 'sm/rest', config: { baseUrl: base, allowInsecure: true, auth: { type: 'bearer' }, paging: { style: 'page' } } });
      const job = compileJob(`
job: cmdb-apps
connection: cmdb
schedule: "0 3 * * *"
source: { query: "/page", mode: full, page_size: 2 }
target: { type: Application, key: id, map: { name: name } }
`);
      await svc.installJob(db, resolveJob(job, { connections: { cmdb: { secret: 'sm/rest' } }, jobs: {} }, 'local'));
      const r = await svc.run(db, 'cmdb-apps', 'local');
      expect(r).toMatchObject({ status: 'succeeded' });
      expect(signals.map((s) => s.subjectRef).sort()).toEqual(['Application:a1', 'Application:a2', 'Application:a3', 'Application:a4', 'Application:a5']);
      expect(signals[0]!.asset).toMatchObject({ name: expect.stringMatching(/^App /) });
      await db.end();
    } finally { try { await admin.end(); } finally { await pgServer.stop(); } }
  }, 120_000);
});
