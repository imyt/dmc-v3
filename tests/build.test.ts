import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
let server: EmbeddedPostgres; let api: ChildProcess | undefined;
const env = { ...process.env, DMC_ENVIRONMENT: 'local', DMC_ROOT: root, DMC_DB_HOST: 'localhost', DMC_DB_PORT: '54382', DMC_DB_NAME: 'postgres', DMC_DB_ADMIN_USER: 'postgres', DMC_DB_ADMIN_PASSWORD: 'pw', DMC_HTTP_HOST: '127.0.0.1', DMC_HTTP_PORT: '38081' };

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-build-')), user: 'postgres', password: 'pw', port: 54382, persistent: false });
  await server.initialise(); await server.start();
}, 120_000);
afterAll(async () => { try { api?.kill('SIGTERM'); } finally { await server?.stop(); } });

describe('production build', () => {
  it('bundles to dist/ with its data files', () => {
    const r = spawnSync('node', ['scripts/build.mjs'], { cwd: root, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, 'dist/dmc.mjs'))).toBe(true);
  }, 60_000);

  it('the bundle migrates the database and serves the API, with no TypeScript tooling', async () => {
    const m = spawnSync('node', ['dist/dmc.mjs', 'migrate'], { cwd: root, env, encoding: 'utf8' });
    expect(m.status, m.stderr + m.stdout).toBe(0);
    api = spawn('node', ['dist/dmc.mjs', 'api'], { cwd: root, env, stdio: 'pipe' });
    let out = ''; api.stdout?.on('data', (d) => { out += d; }); api.stderr?.on('data', (d) => { out += d; });
    let status = 0;
    for (let i = 0; i < 60 && !status; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { status = (await fetch('http://127.0.0.1:38081/v1/auth/me')).status; } catch { /* not up yet */ }
    }
    expect(status, out).toBe(401);   // up, and asking for sign-in
  }, 90_000);
});
