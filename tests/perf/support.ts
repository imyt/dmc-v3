import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

export async function startPg(port: number, tag: string): Promise<{ server: EmbeddedPostgres; admin: pg.Client }> {
  const server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(os.tmpdir(), `dmc-perf-${tag}-`)), user: 'postgres', password: 'pw', port, persistent: false });
  await server.initialise(); await server.start();
  const admin = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  return { server, admin };
}

export const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

export function hardware(): string {
  const c = os.cpus();
  return `${c[0]?.model.trim()} x${c.length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB RAM, ${process.platform}, node ${process.version}`;
}
