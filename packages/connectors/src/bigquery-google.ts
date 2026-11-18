import type { SourceRecord } from '@dmc/contracts';
import type { BigQueryClientPort, BigQueryConfig, BigQueryPage, BigQueryParam, BigQueryRequest, BigQueryRunRequest } from './bigquery.js';

/**
 * The real BigQuery client (S2, ADR 0025). It is the only file that touches `@google-cloud/bigquery`, and it loads the package lazily, on the first
 * connection that uses it, so the package need not be installed for typecheck, tests or a worker that has no BigQuery job configured.
 * The package is typed here by the small local interface below; nothing outside this file sees a Google type.
 *
 * Auth: `adc` (default) uses application default credentials, which on the cluster means workload identity. `key` reads a service-account key from the
 * secret store through `resolveSecret(secretRef)`. The key is held only for the call and is redacted from any error text.
 * Not exercised by the test suite: it needs the package and a real project (the human step in ADR 0025).
 */

/** The part of `@google-cloud/bigquery` this adapter uses. */
interface GJob {
  id?: string;
  location?: string;
  metadata?: { statistics?: { totalBytesProcessed?: string } };
  getQueryResults(opts: { maxResults: number; pageToken?: string; autoPaginate: false }): Promise<[unknown[], { pageToken?: string } | null | undefined, unknown]>;
}
interface GBigQuery {
  createQueryJob(opts: {
    query: string; params?: Record<string, unknown>; types?: Record<string, string>; useLegacySql: false;
    location?: string; maximumBytesBilled?: string; dryRun?: boolean;
  }): Promise<[GJob, unknown]>;
  job(id: string, opts?: { location?: string }): GJob;
}
interface GModule { BigQuery: new (opts: { projectId: string; location?: string; credentials?: unknown }) => GBigQuery }

export interface GoogleBigQueryDeps {
  /** turns a secret reference into the secret (from the secret store). Never logged. */
  resolveSecret(ref: string): Promise<string>;
  /** replaces the library loader (tests of this file only) */
  load?: () => Promise<GModule>;
}

/** The specifier is a variable on purpose: a literal would make bundlers resolve (and fail on) a package that is not installed yet. */
const PACKAGE = '@google-cloud/bigquery';
const loadLibrary = async (): Promise<GModule> => {
  try { return (await import(/* @vite-ignore */ PACKAGE)) as GModule; }
  catch { throw new Error(`The BigQuery client library (${PACKAGE}) could not be loaded; it is a dependency of @dmc/connectors (ADR 0025), so check the install or the image`); }
};

/** Rows as plain JSON: timestamps, dates and numerics come back from the library as objects. */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return typeof v === 'bigint' ? v.toString() : v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  if (Array.isArray(v)) return v.map(plain);
  const o = v as Record<string, unknown>;
  if (typeof o.toFixed === 'function') return String(v); // Big.js numeric
  if (typeof o.value === 'string' && Object.keys(o).length === 1) return o.value; // BigQueryTimestamp, BigQueryDate, BigQueryDatetime, BigQueryTime
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
}

const TOKEN = '|';

export function googleBigQuery(deps: GoogleBigQueryDeps): { clientFor(config: BigQueryConfig): Promise<BigQueryClientPort> } {
  return {
    async clientFor(cfg) {
      const lib = await (deps.load ?? loadLibrary)();
      let secret: string | undefined; let credentials: unknown;
      if (cfg.auth === 'key') {
        secret = await deps.resolveSecret(cfg.secretRef!);
        try { credentials = JSON.parse(secret); } catch { throw new Error('The BigQuery secret is not a service-account key (JSON)'); }
      }
      const bq = new lib.BigQuery({ projectId: cfg.project, ...(cfg.location ? { location: cfg.location } : {}), ...(credentials ? { credentials } : {}) });
      const redact = (e: unknown): Error => new Error(secret ? (e as Error).message.split(secret).join('[redacted]') : (e as Error).message);
      const job = (req: BigQueryRequest, dryRun: boolean) => bq.createQueryJob({
        query: req.query, useLegacySql: false, ...(dryRun ? { dryRun: true } : {}),
        params: Object.fromEntries(Object.entries(req.params).map(([k, p]: [string, BigQueryParam]) => [k, p.value])),
        types: Object.fromEntries(Object.entries(req.params).map(([k, p]) => [k, p.type])),
        ...(req.location ? { location: req.location } : {}),
        ...(req.maxBytesBilled ? { maximumBytesBilled: String(req.maxBytesBilled) } : {}),
      });
      return {
        async runQuery(req: BigQueryRunRequest): Promise<BigQueryPage> {
          try {
            let j: GJob; let pageToken: string | undefined;
            if (req.pageToken === null) [j] = await job(req, false);
            else {
              const [id, location, token] = req.pageToken.split(TOKEN);
              if (!id || token === undefined) throw new Error('bad page token');
              j = bq.job(id, location ? { location } : undefined); pageToken = token;
            }
            const [rows, next] = await j.getQueryResults({ maxResults: req.pageSize, autoPaginate: false, ...(pageToken ? { pageToken } : {}) });
            return {
              rows: rows.map((r) => plain(r) as SourceRecord),
              nextPageToken: next?.pageToken ? [j.id, j.location ?? req.location ?? '', next.pageToken].join(TOKEN) : null,
            };
          } catch (e) { throw redact(e); }
        },
        async dryRun(req) {
          try {
            const [j] = await job(req, true);
            const n = Number(j.metadata?.statistics?.totalBytesProcessed);
            return { bytesProcessed: Number.isFinite(n) ? n : null };
          } catch (e) { throw redact(e); }
        },
      };
    },
  };
}
