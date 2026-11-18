import type { IdempotencyStore, Queryable } from '@dmc/platform';

/** Idempotency keys kept in the catalog schema. Entries are kept for the retention window, then removed by `purge`. */
export class PostgresIdempotency implements IdempotencyStore {
  constructor(private readonly connect: () => Promise<Queryable & { release(): void }>) {}
  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.connect();
    try { return await fn(c); } finally { c.release(); }
  }
  get(key: string) {
    return this.withDb(async (db) => {
      const r = await db.query<{ body_hash: string; response: unknown }>('select body_hash, response from catalog.idempotency_key where key = $1', [key]);
      return r.rows[0] ? { bodyHash: r.rows[0].body_hash, response: r.rows[0].response } : undefined;
    });
  }
  put(key: string, entry: { bodyHash: string; response: unknown }) {
    return this.withDb(async (db) => {
      await db.query('insert into catalog.idempotency_key (key, body_hash, response) values ($1,$2,$3::jsonb) on conflict (key) do nothing', [key, entry.bodyHash, JSON.stringify(entry.response ?? null)]);
    });
  }
  async purge(olderThanDays = 7): Promise<number> {
    return this.withDb(async (db) => (await db.query('delete from catalog.idempotency_key where created_at < now() - make_interval(days => $1)', [olderThanDays])).rowCount ?? 0);
  }
}
