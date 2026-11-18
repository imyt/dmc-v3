import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, type Principal } from '@dmc/platform';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const header = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);

/**
 * Gateway check: who is calling, and may they read. Attribute rules are re-checked by each handler because only it knows the object.
 * Deny by default: no identity is a 401, no role is a 403 with the reason.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const p = await this.d.authenticate(req.headers);
    if (!p) throw new ApiError('unauthenticated', 'Sign in to use DMC');
    const decision = this.d.authz.authorize(p, 'read');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    req.principal = p;
    return true;
  }
}

/**
 * Local development only: identity from headers (x-dmc-user, x-dmc-groups, x-dmc-scopes, x-dmc-acting-for).
 * Never wire this in UAT or prod; those use the session cookie the corporate sign-in sets (`cookieAuthenticator`).
 */
export function devAuthenticator(env: string): ApiDeps['authenticate'] {
  if (env !== 'local') throw new Error('The header authenticator is only for the local environment');
  return (h) => {
    const user = header(h['x-dmc-user']);
    if (!user) return null;
    const list = (v: string | string[] | undefined) => (header(v) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const base: Principal = { id: user, kind: header(h['x-dmc-kind']) === 'service' ? 'service' : 'person', groups: list(h['x-dmc-groups']), scopes: list(h['x-dmc-scopes']) };
    const on = header(h['x-dmc-acting-for']);
    return on ? { ...base, actingFor: { id: on, kind: 'person', groups: list(h['x-dmc-acting-groups']) } } : base;
  };
}

export const SESSION_COOKIE = 'dmc_session';
export interface Session { displayName: string; staffID: string; groups: string[] }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const sign = (body: string, secret: string) => createHmac('sha256', secret).update(body).digest('base64url');

/**
 * The cookie value: base64url of {displayName, staffID, groups}, and when a secret is set a signature after a dot.
 * Corporate sign-in sets it on success (groups are the person's Active Directory groups); the signature is how the API knows it did.
 */
export function encodeSession(s: Session, secret?: string): string {
  const body = b64(JSON.stringify({ displayName: s.displayName, staffID: s.staffID, groups: s.groups }));
  return secret ? `${body}.${sign(body, secret)}` : body;
}

export function decodeSession(value: string, secret?: string): Session | null {
  const [body, sig, ...rest] = value.split('.');
  if (!body || rest.length) return null;
  if (secret) {
    if (!sig) return null;
    const want = Buffer.from(sign(body, secret)); const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  } else if (sig) return null;
  try {
    const j = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Session>;
    if (typeof j.staffID !== 'string' || !j.staffID || typeof j.displayName !== 'string' || !Array.isArray(j.groups) || j.groups.some((g) => typeof g !== 'string')) return null;
    return { staffID: j.staffID, displayName: j.displayName, groups: j.groups };
  } catch { return null; }
}

export function readCookie(h: Record<string, string | string[] | undefined>, name: string): string | undefined {
  for (const part of (header(h.cookie) ?? '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim()); }
  return undefined;
}

export const sessionPrincipal = (s: Session): Principal => ({ id: s.staffID, displayName: s.displayName, kind: 'person', groups: s.groups });

/**
 * Identity from the session cookie. Outside local a secret is required, so an unsigned cookie is never believed.
 * In local with no secret, unsigned cookies are accepted (the mock login sets them), and the header authenticator is tried when there is no cookie.
 */
export function cookieAuthenticator(opts: { environment: string; secret?: string }): ApiDeps['authenticate'] {
  const local = opts.environment === 'local';
  if (!local && !opts.secret) throw new Error('DMC_SECRET_SESSION must be set: the API will not trust a session cookie it cannot verify');
  const dev = local ? devAuthenticator('local') : undefined;
  return (h) => {
    const v = readCookie(h, SESSION_COOKIE);
    if (v) { const s = decodeSession(v, opts.secret); return s ? sessionPrincipal(s) : null; }
    return dev ? dev(h) : null;
  };
}
