import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compileJob, compileOverlay, resolveJob, SyncDefError, type Overlay } from '../packages/connectors/src/index';

// UAT and prod overlays carry REPLACE_ME placeholders until the owning teams supply real values (see the comments in each file).
const root = join(import.meta.dirname, '..');
const JOBS = readdirSync(join(root, 'sync/jobs')).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => compileJob(readFileSync(join(root, 'sync/jobs', f), 'utf8')));
const overlayText = (env: string) => readFileSync(join(root, 'sync/overlays', `${env}.yaml`), 'utf8');
const withEnabled = (o: Overlay, enabled: boolean): Overlay => ({ ...o, jobs: Object.fromEntries(JOBS.map((j) => [j.job, { ...(o.jobs?.[j.job] ?? {}), enabled }])) });

describe.each(['uat', 'prod'])('S-overlays: the %s overlay', (env) => {
  const overlay = compileOverlay(overlayText(env));

  it('has an entry for every job, resolves every one, and has every job switched off', () => {
    for (const def of JOBS) {
      expect(overlay.jobs?.[def.job], `${env} has no entry for ${def.job}`).toBeDefined();
      const r = resolveJob(def, overlay, env);
      expect(r.enabled, `${def.job} must be off while it has placeholders`).toBe(false);
      expect(overlay.connections?.[r.connection], `${def.job} uses connection ${r.connection}`).toBeDefined();
    }
  });

  it('has no real-looking values: every connection secret is a placeholder, and no host is local', () => {
    for (const [name, c] of Object.entries(overlay.connections ?? {})) {
      expect(c.secret, name).toMatch(/^REPLACE_ME/);
      expect(JSON.stringify(c), name).not.toMatch(/localhost|127\.0\.0\.1|local-fixture|local\/none/);
    }
  });

  it('a placeholder never passes as a real value: switching any job on fails and names the placeholders', () => {
    const on = withEnabled(overlay, true);
    for (const def of JOBS) expect(() => resolveJob(def, on, env), def.job).toThrow(/REPLACE_ME.*before enabling/s);
  });

  it('supplies every parameter every job needs: with placeholders replaced by values, every job resolves enabled', () => {
    const filled = compileOverlay(overlayText(env).replace(/REPLACE_ME[A-Za-z0-9_/-]*/g, 'x'));
    const on = withEnabled(filled, true);
    for (const def of JOBS) expect(resolveJob(def, on, env).enabled, def.job).toBe(true);
  });

  it('a parameter that is not supplied is a clear error that names it', () => {
    const o = compileOverlay(overlayText(env).replace(/REPLACE_ME[A-Za-z0-9_/-]*/g, 'x'));
    const { peoplePath: _unset, ...idpWithout } = o.connections!.idp!;
    const broken = compileOverlay(JSON.stringify({ ...o, connections: { ...o.connections, idp: idpWithout } }));
    const idp = JOBS.find((j) => j.job === 'idp-people')!;
    expect(() => resolveJob(idp, broken, env)).toThrow(SyncDefError);
    expect(() => resolveJob(idp, broken, env)).toThrow(`peoplePath} but ${env} does not set it`);
  });
});

describe('S-overlays: the placeholder guard', () => {
  it('a job that is off may carry placeholders, and one with real values may be on', () => {
    const def = JOBS.find((j) => j.job === 'aris-scopes')!;
    const o = (enabled: boolean, secret: string) => compileOverlay(JSON.stringify({ connections: { aris: { type: 'rest', baseUrl: 'https://aris.example.test', secret } }, jobs: { 'aris-scopes': { connection: 'aris', enabled } } }));
    expect(resolveJob(def, o(false, 'REPLACE_ME/x'), 'uat').enabled).toBe(false);
    expect(() => resolveJob(def, o(true, 'REPLACE_ME/x'), 'uat')).toThrow(/REPLACE_ME/);
    expect(resolveJob(def, o(true, 'sm/aris'), 'uat').enabled).toBe(true);
  });
});
