import { describe, expect, it } from 'vitest';
import { ApiError, checkIfMatch, decodeCursor, etagOf, parseDryRun, parseLimit, toPage, withIdempotency, type IdempotencyStore } from '../packages/platform/src/http/conventions';

const memStore = (): IdempotencyStore => {
  const m = new Map<string, { bodyHash: string; response: unknown }>();
  return { get: async (k) => m.get(k), put: async (k, v) => void m.set(k, v) };
};

describe('API conventions', () => {
  it('pages with an opaque cursor', () => {
    const page = toPage([1, 2, 3], 2, (n) => ({ after: n }));
    expect(page.items).toEqual([1, 2]);
    expect(decodeCursor(page.next_cursor!)).toEqual({ after: 2 });
    expect(toPage([1], 2, (n) => n).next_cursor).toBeNull();
  });
  it('rejects bad limits and cursors with 422', () => {
    expect(() => parseLimit('0')).toThrow(ApiError);
    expect(() => decodeCursor('!!')).toThrow(/Invalid cursor/);
    expect(parseLimit(undefined)).toBe(50);
  });
  it('If-Match: 428 when missing, 412 when stale', () => {
    const cur = etagOf('a', 2);
    expect(() => checkIfMatch(undefined, cur)).toThrow(expect.objectContaining({ status: 428 }));
    expect(() => checkIfMatch(etagOf('a', 1), cur)).toThrow(expect.objectContaining({ status: 412 }));
    expect(() => checkIfMatch(cur, cur)).not.toThrow();
  });
  it('idempotency replays, and refuses a changed body', async () => {
    const s = memStore();
    let runs = 0;
    const run = async () => ({ n: ++runs });
    expect(await withIdempotency(s, 'key-12345', { a: 1 }, run)).toEqual({ n: 1 });
    expect(await withIdempotency(s, 'key-12345', { a: 1 }, run)).toEqual({ n: 1 });
    await expect(withIdempotency(s, 'key-12345', { a: 2 }, run)).rejects.toMatchObject({ code: 'idempotency_mismatch' });
    await expect(withIdempotency(s, undefined, {}, run)).rejects.toMatchObject({ status: 422 });
    expect(runs).toBe(1);
  });
  it('parses dry_run', () => {
    expect(parseDryRun('true')).toBe(true);
    expect(parseDryRun(undefined)).toBe(false);
  });
  it('renders problems that satisfy the contract', async () => {
    const { loadSpec, checkResponse } = await import('../packages/contracts/src/index');
    const body = new ApiError('forbidden', 'no role').toProblem('abc');
    expect(checkResponse(loadSpec(), '/v1/health', 'get', 403, body)).toEqual([]);
  });
});
