import { readFileSync } from 'node:fs';
import type { SourceRecord } from '@dmc/contracts';
import type { BigQueryClientPort, BigQueryConfig, BigQueryPage, BigQueryRequest, BigQueryRunRequest } from './bigquery.js';

/** Recorded rows by `project.dataset`, then table: the shape of `sync/fixtures/bigquery/*.json`. */
export type BigQueryFixture = Record<string, Record<string, SourceRecord[]>>;

export const loadBigQueryFixture = (file: string): BigQueryFixture => JSON.parse(readFileSync(file, 'utf8')) as BigQueryFixture;

export interface FixtureBigQuery {
  /** pass to `bigQueryConnector({ clientFor })` */
  clientFor(config: BigQueryConfig): Promise<BigQueryClientPort>;
  /** every request the connector made, as BigQuery would have received it (query text and bound parameters) */
  requests: (BigQueryRequest & { pageToken?: string | null; pageSize?: number })[];
}

/**
 * A BigQuery stand-in for tests and local runs: serves the recorded rows of the table the query names (`project.dataset.table`) and understands
 * only what the job queries use: the table in FROM, and a watermark written `<column> > @since` (rows at or before it are left out).
 * It pages by offset. It does not run SQL; a query that names a table the fixture does not hold fails as BigQuery's "not found" would.
 * With auth 'key' it calls `resolveSecret` like the real client does, so a missing secret fails the same way; the secret is never kept.
 */
export function fixtureBigQuery(data: BigQueryFixture, deps: { resolveSecret?(ref: string): Promise<string> } = {}): FixtureBigQuery {
  const requests: FixtureBigQuery['requests'] = [];
  const table = (query: string): { dataset: string; name: string } => {
    const m = /\bFROM\s+`([^`]+)`/i.exec(query);
    const parts = m?.[1]?.split('.') ?? [];
    if (parts.length !== 3) throw new Error('fixture: the query names no project.dataset.table');
    return { dataset: `${parts[0]}.${parts[1]}`, name: parts[2]! };
  };
  const rowsOf = (req: BigQueryRequest): SourceRecord[] => {
    const t = table(req.query);
    const tables = data[t.dataset];
    if (!tables) throw new Error(`Not found: Dataset ${t.dataset}`);
    const rows = tables[t.name];
    if (!rows) throw new Error(`Not found: Table ${t.dataset}.${t.name}`);
    const since = req.params.since?.value ?? null;
    const col = /\b(\w+)\s*>\s*@since\b/i.exec(req.query)?.[1];
    return since && col ? rows.filter((r) => String(r[col] ?? '') > since) : rows;
  };
  return {
    requests,
    async clientFor(config) {
      if (config.auth === 'key') await deps.resolveSecret?.(config.secretRef!);
      return {
        async runQuery(req: BigQueryRunRequest): Promise<BigQueryPage> {
          requests.push({ query: req.query, params: req.params, pageToken: req.pageToken, pageSize: req.pageSize });
          const rows = rowsOf(req);
          const at = req.pageToken === null ? 0 : Number(req.pageToken);
          if (!Number.isInteger(at) || at < 0) throw new Error('fixture: bad page token');
          const next = at + req.pageSize;
          return { rows: rows.slice(at, next).map((r) => ({ ...r })), nextPageToken: next < rows.length ? String(next) : null };
        },
        async dryRun(req) {
          requests.push({ query: req.query, params: req.params });
          const dataset = /`([^`.]+\.[^`.]+)\./.exec(req.query)?.[1];
          if (!dataset || !data[dataset]) throw new Error(`Not found: Dataset ${dataset ?? '(none)'}`);
          return { bytesProcessed: 0 };
        },
      };
    },
  };
}
