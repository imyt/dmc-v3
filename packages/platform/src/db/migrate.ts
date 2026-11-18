import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Queryable } from './types';
import { ident } from './provision';

/**
 * Applies `NNNN_name.sql` files from a module's migrations folder inside the module's own schema.
 * Applied migrations are never edited: a changed checksum is an error (ground rule 3).
 */
export async function migrateModule(db: Queryable, moduleName: string, dir: string): Promise<string[]> {
  const schema = ident(moduleName);
  await db.query(`create table if not exists ${schema}.schema_migration (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const done = await db.query<{ checksum: string }>(`select checksum from ${schema}.schema_migration where name = $1`, [file]);
    if (done.rows[0]) {
      if (done.rows[0].checksum !== checksum) throw new Error(`Migration ${file} was edited after it was applied`);
      continue;
    }
    await db.query('begin');
    try {
      await db.query(`set local search_path to ${schema}`);
      await db.query(sql);
      await db.query(`insert into ${schema}.schema_migration (name, checksum) values ($1, $2)`, [file, checksum]);
      await db.query('commit');
    } catch (e) {
      await db.query('rollback');
      throw e;
    }
    applied.push(file);
  }
  return applied;
}
