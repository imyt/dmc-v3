import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiError } from '@dmc/platform';
import type { FastifyReply } from 'fastify';
import { CatalogDelegations } from '@dmc/catalog';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';
import { SESSION_COOKIE, encodeSession } from './auth.js';

const MAX_AGE = 8 * 60 * 60;

/**
 * Sign-in. In UAT and prod the corporate gateway authenticates and sets the `dmc_session` cookie (display name, staff ID, Active Directory groups);
 * DMC only reads it. The mock login below exists in local only, so the same cookie can be had without the gateway.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private get local(): boolean { return (this.d.session?.environment ?? 'local') === 'local'; }

  private cookie(value: string, maxAge: number): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.local ? '' : '; Secure'}`;
  }

  @Post('mock-login')
  @HttpCode(200)
  async mockLogin(@Body() body: { staffID?: unknown; displayName?: unknown; groups?: unknown }, @Res({ passthrough: true }) res: FastifyReply) {
    if (!this.local) throw new ApiError('not_found', 'Not found');
    const { staffID, displayName, groups } = body ?? {};
    const problems: { path: string; message: string }[] = [];
    if (typeof staffID !== 'string' || !staffID.trim()) problems.push({ path: 'staffID', message: 'required' });
    if (typeof displayName !== 'string' || !displayName.trim()) problems.push({ path: 'displayName', message: 'required' });
    if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string')) problems.push({ path: 'groups', message: 'list of group names' });
    if (problems.length) throw new ApiError('validation_failed', 'staffID, displayName and groups are required', problems);
    const s = { staffID: (staffID as string).trim(), displayName: (displayName as string).trim(), groups: groups as string[] };
    void res.header('set-cookie', this.cookie(encodeSession(s, this.d.session?.secret), MAX_AGE));
    return this.me2({ id: s.staffID, displayName: s.displayName, kind: 'person', groups: s.groups });
  }

  @Get('me')
  async me(@Req() req: AuthedRequest) {
    const p = await this.d.authenticate(req.headers);
    if (!p) throw new ApiError('unauthenticated', 'Sign in to use DMC');
    return this.me2(p);
  }

  /** Who the caller is, and the roles they hold: from their Active Directory groups, plus those the data gives them (owning an application or a scope). */
  private async me2(p: { id: string; displayName?: string; kind: string; groups: string[] }) {
    const roles = new Set(this.d.authz.rolesFor(p.groups).map((r) => r.role));
    if (p.kind === 'person') for (const r of await this.derivedRoles(p.id)) roles.add(r);
    return { ...me(p), roles: [...roles].sort() };
  }

  private async derivedRoles(id: string): Promise<string[]> {
    const c = await this.d.connect();
    try {
      const out: string[] = [];
      const apps = await this.d.store.listByType(c, 'Application', { limit: 5000 });
      if (apps.some((a) => a.attributes.owner === id || (Array.isArray(a.attributes.delegates) && a.attributes.delegates.includes(id)))) out.push('app-owner');
      const scopes = await this.d.store.listByType(c, 'Scope', { limit: 5000 });
      const today = new Date().toISOString().slice(0, 10);
      const delegated = (await new CatalogDelegations(this.d.store).all(c)).some((x) => x.delegate === id && !x.ended && x.validFrom <= today && x.validTo >= today);
      if (scopes.some((s) => s.attributes.owner === id) || delegated) out.push('scope-owner');
      return out;
    } finally { c.release(); }
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: FastifyReply) { void res.header('set-cookie', this.cookie('', 0)); }
}

const me = (p: { id: string; displayName?: string; kind: string; groups: string[] }) => ({ id: p.id, display_name: p.displayName ?? p.id, kind: p.kind, groups: p.groups });
