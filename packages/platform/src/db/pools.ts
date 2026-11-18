import pg from 'pg';
import { passwordFor, type AppConfig, type ModuleName } from '../config';
import { roleFor } from './provision';
import type { Queryable } from './types';

export interface Connection extends Queryable { release(): void }

/** A pool as one module's own role: it can see only that module's schema. */
export function modulePool(cfg: AppConfig, m: ModuleName, max = 4): pg.Pool {
  return new pg.Pool({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user: roleFor(m), password: passwordFor(cfg, m), max });
}
export function adminClient(cfg: AppConfig): pg.Client {
  return new pg.Client({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user: cfg.db.adminUser, password: cfg.db.adminPassword });
}
/** Wraps a pooled client so callers see only `query` and `release`. */
export const connect = (pool: pg.Pool) => async (): Promise<Connection> => {
  const c = await pool.connect();
  return { query: (sql: string, params?: unknown[]) => c.query(sql, params) as never, release: () => c.release() };
};
