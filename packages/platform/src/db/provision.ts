import type { Queryable } from './types';

const IDENT = /^[a-z][a-z0-9_]*$/;
export function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return `"${name}"`;
}

export function roleFor(moduleName: string): string {
  return `dmc_${moduleName}`;
}

/**
 * Creates the schema and DB role for one module (ground rule 3: a module's role sees only its own schema),
 * plus its outbox and inbox tables (ground rule 6). Idempotent. Run as an admin role.
 */
export async function provisionModule(db: Queryable, moduleName: string, opts: { password?: string } = {}): Promise<void> {
  const schema = ident(moduleName);
  const role = ident(roleFor(moduleName));
  const exists = await db.query('select 1 from pg_roles where rolname = $1', [roleFor(moduleName)]);
  if (exists.rowCount === 0) {
    await db.query(`create role ${role} ${opts.password ? `login password '${opts.password.replace(/'/g, "''")}'` : 'nologin'}`);
  }
  await db.query(`create schema if not exists ${schema} authorization ${role}`);
  await db.query(`revoke all on schema ${schema} from public`);
  await db.query(`grant usage, create on schema ${schema} to ${role}`);
  await db.query(`
    create table if not exists ${schema}.outbox (
      id          bigserial primary key,
      event_type  text        not null,
      subject_ref text        not null,
      actor       text        not null,
      payload     jsonb       not null,
      created_at  timestamptz not null default now(),
      published_at timestamptz
    )`);
  await db.query(`create index if not exists outbox_unpublished on ${schema}.outbox (id) where published_at is null`);
  await db.query(`
    create table if not exists ${schema}.inbox (
      event_id     text primary key,
      processed_at timestamptz not null default now()
    )`);
  await db.query(`grant all on all tables in schema ${schema} to ${role}`);
  await db.query(`grant all on all sequences in schema ${schema} to ${role}`);
  // Each module's role may use only its own schema; the shared platform schema is read-only for migrations bookkeeping.
  await db.query(`revoke all on schema public from ${role}`);
}
