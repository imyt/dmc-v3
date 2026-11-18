import { createHash } from 'node:crypto';

export type ProblemCode =
  | 'validation_failed' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict'
  | 'precondition_failed' | 'precondition_required' | 'idempotency_mismatch' | 'rate_limited' | 'internal';

const STATUS: Record<ProblemCode, number> = {
  validation_failed: 422, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409,
  precondition_failed: 412, precondition_required: 428, idempotency_mismatch: 422, rate_limited: 429, internal: 500,
};

/** Throw this from handlers; the HTTP layer renders it as application/problem+json. */
export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ProblemCode, readonly detail?: string, readonly errors?: { path: string; message: string }[]) {
    super(detail ?? code);
    this.status = STATUS[code];
  }
  toProblem(traceId?: string) {
    return {
      type: `https://dmc.internal/problems/${this.code}`,
      title: this.code.replace(/_/g, ' '),
      status: this.status,
      code: this.code,
      ...(this.detail && { detail: this.detail }),
      ...(this.errors && { errors: this.errors }),
      ...(traceId && { trace_id: traceId }),
    };
  }
}

export interface Page<T> { items: T[]; next_cursor: string | null }

export const encodeCursor = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');

export function decodeCursor<T = unknown>(c: string | undefined): T | undefined {
  if (!c) return undefined;
  try { return JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as T; }
  catch { throw new ApiError('validation_failed', 'Invalid cursor', [{ path: 'cursor', message: 'not a valid cursor' }]); }
}

export function parseLimit(raw: unknown, max = 200, def = 50): number {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new ApiError('validation_failed', `limit must be 1..${max}`, [{ path: 'limit', message: `must be an integer from 1 to ${max}` }]);
  return n;
}

/** Fetch limit+1 rows, pass them here: returns the page and a cursor when more rows exist. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => unknown): Page<T> {
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? encodeCursor(cursorOf(items[items.length - 1]!)) : null };
}

export const parseDryRun = (raw: unknown): boolean => raw === true || raw === 'true' || raw === '1';

/** ETag for an object version: weak validator over id and version. */
export const etagOf = (id: string, version: number): string => `W/"${id}-${version}"`;

/** Updates must carry If-Match. Missing → 428; stale → 412. */
export function checkIfMatch(header: string | undefined, current: string): void {
  if (!header) throw new ApiError('precondition_required', 'If-Match header is required');
  if (header !== current && header !== '*') throw new ApiError('precondition_failed', 'Object changed since it was read');
}

export interface IdempotencyStore {
  get(key: string): Promise<{ bodyHash: string; response: unknown } | undefined>;
  put(key: string, entry: { bodyHash: string; response: unknown }): Promise<void>;
}

export const hashBody = (body: unknown): string => createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** Same key + same body → stored response; same key + different body → 422; new key → run and store. */
export async function withIdempotency<T>(store: IdempotencyStore, key: string | undefined, body: unknown, run: () => Promise<T>): Promise<T> {
  if (!key || key.length < 8) throw new ApiError('validation_failed', 'Idempotency-Key header is required (8-128 chars)');
  const bodyHash = hashBody(body);
  const seen = await store.get(key);
  if (seen) {
    if (seen.bodyHash !== bodyHash) throw new ApiError('idempotency_mismatch', 'Key was used with a different request body');
    return seen.response as T;
  }
  const response = await run();
  await store.put(key, { bodyHash, response });
  return response;
}
