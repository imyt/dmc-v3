import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Authz, loadRegistry } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { checkResponse, loadSpec } from '../packages/contracts/src/index';
import { cookieAuthenticator, createApi, decodeSession, encodeSession, SESSION_COOKIE } from '../apps/api/src/index';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const spec = loadSpec();
const gone = async () => { throw new Error('no db in this test'); };
const empty = async () => ({ query: async () => ({ rows: [] }) as never, release() {} });
const build = (environment: string, secret?: string) => createApi({
  version: '0', registry, store: { listByType: async () => [] } as unknown as CatalogStore, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')),
  authenticate: cookieAuthenticator({ environment, ...(secret ? { secret } : {}) }), session: { environment, ...(secret ? { secret } : {}) },
  connect: empty, connectEvidence: gone, policies: () => [],
  exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
  inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
  signals: { async submit() {} }, idempotency: { async get() { return undefined; }, async put() {} },
});
const person = { staffID: '43001234', displayName: 'Amy Adams', groups: ['dmc-scope-owner', 'dmc-steward-finance'] };
let local: NestFastifyApplication; let uat: NestFastifyApplication;
const inj = (a: NestFastifyApplication, method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, payload?: unknown) => a.getHttpAdapter().getInstance().inject({ method, url, headers, payload: payload as never });
const cookieOf = (setCookie: unknown) => String(setCookie).split(';')[0]!;

beforeAll(async () => { local = await build('local'); uat = await build('uat', 'a-long-test-secret'); });
afterAll(async () => { await local?.close(); await uat?.close(); });

describe('F4b: session cookie', () => {
  it('encodes and decodes; a signature must match', () => {
    const v = encodeSession(person, 's3cret');
    expect(decodeSession(v, 's3cret')).toEqual(person);
    expect(decodeSession(v, 'other')).toBeNull();
    expect(decodeSession(encodeSession(person), 's3cret')).toBeNull();     // unsigned where a signature is required
    expect(decodeSession(v)).toBeNull();                                    // signed where none is expected
    expect(decodeSession('!!!')).toBeNull();
    expect(decodeSession(encodeSession({ ...person, staffID: '' }))).toBeNull();
  });

  it('refuses to be built outside local without a secret', () => {
    expect(() => cookieAuthenticator({ environment: 'prod' })).toThrow(/DMC_SECRET_SESSION/);
  });

  it('mock login sets the cookie, which then signs you in', async () => {
    const r = await inj(local, 'POST', '/v1/auth/mock-login', {}, person);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ id: '43001234', display_name: 'Amy Adams', kind: 'person', groups: person.groups, roles: ['scope-owner', 'steward', 'viewer'] });
    expect(checkResponse(spec, '/v1/auth/mock-login', 'post', 200, r.json())).toEqual([]);
    expect(String(r.headers['set-cookie'])).toMatch(/HttpOnly/);
    const cookie = cookieOf(r.headers['set-cookie']);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const me = await inj(local, 'GET', '/v1/auth/me', { cookie });
    expect(me.json()).toMatchObject({ id: '43001234', display_name: 'Amy Adams' });
    expect(checkResponse(spec, '/v1/auth/me', 'get', 200, me.json())).toEqual([]);
  });

  it('no cookie is 401; a tampered one is 401; header auth still works in local; logout clears', async () => {
    expect((await inj(local, 'GET', '/v1/auth/me')).statusCode).toBe(401);
    expect((await inj(local, 'GET', '/v1/auth/me', { cookie: `${SESSION_COOKIE}=garbage` })).statusCode).toBe(401);
    expect((await inj(local, 'GET', '/v1/auth/me', { 'x-dmc-user': 'dev1' })).json().id).toBe('dev1');
    const out = await inj(local, 'POST', '/v1/auth/logout');
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });

  it('outside local: no mock login, a signed cookie works, an unsigned or forged one does not, headers are ignored', async () => {
    expect((await inj(uat, 'POST', '/v1/auth/mock-login', {}, person)).statusCode).toBe(404);
    const good = `${SESSION_COOKIE}=${encodeSession(person, 'a-long-test-secret')}`;
    expect((await inj(uat, 'GET', '/v1/auth/me', { cookie: good })).json().display_name).toBe('Amy Adams');
    expect((await inj(uat, 'GET', '/v1/auth/me', { cookie: `${SESSION_COOKIE}=${encodeSession(person)}` })).statusCode).toBe(401);
    expect((await inj(uat, 'GET', '/v1/auth/me', { cookie: `${SESSION_COOKIE}=${encodeSession(person, 'wrong')}` })).statusCode).toBe(401);
    expect((await inj(uat, 'GET', '/v1/auth/me', { 'x-dmc-user': 'dev1' })).statusCode).toBe(401);
  });

  it('mock login validates its input', async () => {
    expect((await inj(local, 'POST', '/v1/auth/mock-login', {}, { staffID: '', groups: 'x' })).statusCode).toBe(422);
  });
});
