import type { Connector, ConnectorQuery, ReadPage, SourceRecord } from '@dmc/contracts';

/**
 * BigQuery connector (S2). Reads governance tables (ServiceNow applications, DQ Hub results, DSTORM schedules, DataVisa records) that other
 * teams land in BigQuery. Metadata only (rule 8): a job reads those tables, never the business data they describe.
 *
 * The connector is written over `BigQueryClientPort`, so tests and local runs need no Google library. The real client is in `bigquery-google.ts`
 * and loads `@google-cloud/bigquery` only when a connection is used (ADR 0025).
 *
 * Connection config: `{ project, dataset, location?, auth?: 'adc' | 'key', secretRef?, maxBytesBilled? }`.
 *   `auth` is `adc` (application default credentials: workload identity on the cluster) unless set to `key`, in which case `secretRef` names the
 *   secret that holds a service-account key. A secret never appears in config, in YAML, in an error or in a log line.
 * Job query: one read-only SELECT (or WITH ... SELECT) over tables of the connection's `project.dataset`, written with backticks:
 *   SELECT sys_id, name FROM `${project}.${dataset}.apps` WHERE @since IS NULL OR sys_updated_on > @since
 * `@since` is the only parameter; the connector binds it (a TIMESTAMP, null on a full run or a first run), the query text is never built from values.
 */
export interface BigQueryConfig {
  project: string;
  dataset: string;
  location?: string;
  auth?: 'adc' | 'key';
  /** only with auth 'key': the secret that holds the service-account key */
  secretRef?: string;
  /** a query that would scan more than this is refused by BigQuery */
  maxBytesBilled?: number;
}

export type BigQueryParam = { type: 'TIMESTAMP' | 'STRING'; value: string | null };
export interface BigQueryRequest {
  query: string;
  params: Record<string, BigQueryParam>;
  location?: string;
  maxBytesBilled?: number;
}
export interface BigQueryRunRequest extends BigQueryRequest {
  pageSize: number;
  /** null for the first page; otherwise the token the previous page returned (opaque: the adapter may keep the job id in it) */
  pageToken: string | null;
}
export interface BigQueryPage { rows: SourceRecord[]; nextPageToken: string | null }

/** What the connector needs from BigQuery. Rows are plain JSON values (timestamps as ISO strings, numerics as strings). */
export interface BigQueryClientPort {
  /** runs a parameterised query and returns one page of rows */
  runQuery(req: BigQueryRunRequest): Promise<BigQueryPage>;
  /** validates a query and its access without running it (no rows are read, nothing is billed) */
  dryRun(req: BigQueryRequest): Promise<{ bytesProcessed: number | null }>;
}

export interface BigQueryDeps {
  /** builds the client for a connection; the secret, if any, is resolved inside it and never leaves it */
  clientFor(config: BigQueryConfig): Promise<BigQueryClientPort>;
  /** progress lines (counts and names, never the query parameters, rows or secrets) */
  log?: (message: string, fields: Record<string, unknown>) => void;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const DATASET = /^[A-Za-z0-9_]{1,1024}$/;

export function parseBigQueryConfig(config: Record<string, unknown>): BigQueryConfig {
  const c = config as Partial<BigQueryConfig> & Record<string, unknown>;
  if (typeof c.project !== 'string' || !PROJECT.test(c.project)) throw new Error('BigQuery connection needs a valid project id');
  if (typeof c.dataset !== 'string' || !DATASET.test(c.dataset)) throw new Error('BigQuery connection needs a valid dataset name');
  const auth = c.auth ?? 'adc';
  if (auth !== 'adc' && auth !== 'key') throw new Error('BigQuery auth must be adc or key');
  if (auth === 'key' && (typeof c.secretRef !== 'string' || !c.secretRef)) throw new Error('BigQuery auth key needs a secretRef');
  if (c.maxBytesBilled !== undefined && (typeof c.maxBytesBilled !== 'number' || !(c.maxBytesBilled > 0))) throw new Error('BigQuery maxBytesBilled must be a positive number');
  return { project: c.project, dataset: c.dataset, auth, ...(typeof c.location === 'string' ? { location: c.location } : {}), ...(typeof c.secretRef === 'string' ? { secretRef: c.secretRef } : {}), ...(c.maxBytesBilled !== undefined ? { maxBytesBilled: c.maxBytesBilled } : {}) };
}

const FORBIDDEN = ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE', 'CALL', 'EXECUTE', 'EXPORT', 'LOAD', 'BEGIN', 'DECLARE', 'SET', 'RAISE', 'ASSERT', 'COMMIT', 'ROLLBACK', 'EXTERNAL_QUERY'];

/** One masked copy of the query: string literals emptied, backticked names listed. Returns the problem when the text has a comment or an unterminated literal. */
function scan(sql: string): { code: string; quoted: string[]; semicolons: number[] } | string {
  let code = ''; const quoted: string[] = []; const semicolons: number[] = [];
  for (let i = 0; i < sql.length;) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-' || ch === '#' || ch === '/' && sql[i + 1] === '*') return 'comments are not allowed in a job query';
    if (ch === '`') {
      const end = sql.indexOf('`', i + 1);
      if (end < 0) return 'unterminated backtick name';
      quoted.push(sql.slice(i + 1, end)); code += '`_`'; i = end + 1; continue;
    }
    if (ch === "'" || ch === '"') {
      const triple = sql.startsWith(ch.repeat(3), i);
      const q = triple ? ch.repeat(3) : ch;
      let j = i + q.length; let closed = false;
      while (j < sql.length) {
        if (sql[j] === '\\') { j += 2; continue; }
        if (sql.startsWith(q, j)) { closed = true; j += q.length; break; }
        j++;
      }
      if (!closed) return 'unterminated string literal';
      code += "''"; i = j; continue;
    }
    if (ch === ';') semicolons.push(code.length);
    code += ch; i++;
  }
  return { code, quoted, semicolons };
}

/**
 * Accepts only a read-only query over the connection's `project.dataset`; returns the problems (empty when it is acceptable).
 * Refused: more than one statement, comments, anything but SELECT/WITH at the start, write/DDL/script keywords, `@@` system variables,
 * positional `?` parameters, parameters other than `@since`, and any table outside `project.dataset` (every table is written in backticks).
 */
export function checkBigQueryText(text: string, cfg: Pick<BigQueryConfig, 'project' | 'dataset'>): string[] {
  const s = scan(text);
  if (typeof s === 'string') return [s];
  const problems: string[] = [];
  const { code, quoted, semicolons } = s;
  const trimmed = code.trim();
  if (!trimmed) return ['the query is empty'];
  const semi = semicolons.filter((p) => code.slice(p + 1).trim() !== '');
  if (semi.length || semicolons.length > 1) problems.push('only one statement is allowed');
  const first = /^[A-Za-z_]+/.exec(trimmed)?.[0]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') problems.push('the query must be a SELECT');
  for (const w of FORBIDDEN) if (new RegExp(`\\b${w}\\b`, 'i').test(code)) problems.push(`${w} is not allowed in a read-only query`);
  if (code.includes('@@')) problems.push('system variables are not allowed');
  if (code.includes('?')) problems.push('use the named parameter @since, not positional parameters');
  for (const m of code.matchAll(/@([A-Za-z_]\w*)/g)) if (m[1] !== 'since') problems.push(`unknown parameter @${m[1]} (only @since is bound)`);
  const prefix = `${cfg.project}.${cfg.dataset}.`;
  for (const q of quoted) if (!q.startsWith(prefix) || q.length === prefix.length) problems.push(`table \`${q}\` is outside ${cfg.project}.${cfg.dataset}`);
  if (/(?<![\w`.])[A-Za-z_][\w-]*\.[A-Za-z_]\w*\.[A-Za-z_]\w*/.test(code)) problems.push('write table names in backticks as `project.dataset.table`');
  const ctes = new Set([...code.matchAll(/(?:\bWITH|,)\s*([A-Za-z_]\w*)\s+AS\s*\(/gi)].map((m) => m[1]!.toLowerCase()));
  for (const m of code.matchAll(/\b(?:FROM|JOIN)\s+([^\s(`,]+)/gi)) {
    const name = m[1]!;
    if (/^UNNEST$/i.test(name) || ctes.has(name.toLowerCase())) continue;
    problems.push(`table ${name} must be written in backticks as \`${cfg.project}.${cfg.dataset}.table\``);
  }
  return [...new Set(problems)];
}

const highWaterOf = (records: SourceRecord[], field: string | undefined): string | null =>
  field ? records.reduce<string | null>((m, r) => { const v = r[field]; return v === undefined || v === null ? m : m === null || String(v) > m ? String(v) : m; }, null) : null;

export function bigQueryConnector(deps: BigQueryDeps): Connector {
  const failure = (what: string, e: unknown): Error => new Error(`BigQuery ${what} failed: ${(e as Error).message}`);

  const request = (cfg: BigQueryConfig, query: string, since: string | null | undefined): BigQueryRequest => ({
    query,
    params: /@since\b/.test(query) ? { since: { type: 'TIMESTAMP', value: since ?? null } } : {},
    ...(cfg.location ? { location: cfg.location } : {}),
    ...(cfg.maxBytesBilled ? { maxBytesBilled: cfg.maxBytesBilled } : {}),
  });

  return {
    async test(config) {
      try {
        const cfg = parseBigQueryConfig(config);
        const probe = `SELECT table_name FROM \`${cfg.project}.${cfg.dataset}.INFORMATION_SCHEMA.TABLES\` LIMIT 1`;
        const bad = checkBigQueryText(probe, cfg);
        if (bad.length) return { ok: false, message: bad.join('; ') };
        await (await deps.clientFor(cfg)).dryRun(request(cfg, probe, null));
        return { ok: true };
      } catch (e) { return { ok: false, message: (e as Error).message }; }
    },

    async read(config, q: ConnectorQuery, pageCursor, since): Promise<ReadPage> {
      const cfg = parseBigQueryConfig(config);
      const problems = checkBigQueryText(q.text, cfg);
      if (problems.length) throw new Error(`Job query refused: ${problems.join('; ')}`);
      const client = await deps.clientFor(cfg);
      let page: BigQueryPage;
      try { page = await client.runQuery({ ...request(cfg, q.text, since), pageSize: q.pageSize, pageToken: pageCursor }); }
      catch (e) { throw failure(`read of ${cfg.project}.${cfg.dataset}`, e); }
      deps.log?.('bigquery page read', { project: cfg.project, dataset: cfg.dataset, rows: page.rows.length, more: page.nextPageToken !== null, incremental: since !== null });
      return { records: page.rows, nextCursor: page.nextPageToken, done: page.nextPageToken === null, highWater: highWaterOf(page.rows, q.cursorField) };
    },
  };
}
