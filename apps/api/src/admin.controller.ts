import { createHash } from 'node:crypto';
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiError, withIdempotency } from '@dmc/platform';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

/**
 * U2. What is running, and the switches that stop it. Pausing enforcement (or one policy) turns it into shadow: results are still recorded,
 * but no exception, task or change is raised. Only people may press these, and each press is in the ledger.
 */
@Controller('v1/admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private admin() {
    if (!this.d.admin) throw new ApiError('conflict', 'The pause switches are not available in this process');
    return this.d.admin;
  }

  private person(req: AuthedRequest, action: string, facts: Record<string, unknown> = {}): string {
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'The switches are pressed by people, not by agents or scripts');
    const decision = this.d.authz.authorize(req.principal, action, facts);
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    return decision.subject;
  }

  /** The metamodel's version is a short fingerprint of every type and its version. */
  private metamodelVersion(): string {
    const parts = this.d.registry.all().map((t) => `${t.type}@${t.version}`).sort();
    return `${parts.length} types, ${createHash('sha256').update(parts.join(',')).digest('hex').slice(0, 8)}`;
  }

  @Get('status')
  async status(@Req() req: AuthedRequest) {
    this.person(req, 'admin_control');
    const s = await this.admin().state();
    return {
      version: this.d.version, metamodel_version: this.metamodelVersion(), enforcement: s.enforcementPaused ? 'paused' : 'running',
      policies: this.d.policies().map((p) => ({ id: p.id, mode: p.mode, paused: s.enforcementPaused || s.pausedPolicies.includes(p.id) })).sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  private paused(body: { paused?: unknown }): boolean {
    if (typeof body?.paused !== 'boolean') throw new ApiError('validation_failed', 'paused must be true or false', [{ path: 'paused', message: 'true or false' }]);
    return body.paused;
  }

  @Post('enforcement')
  @HttpCode(200)
  async enforcement(@Req() req: AuthedRequest, @Body() body: { paused?: unknown }, @Headers('idempotency-key') key?: string) {
    const paused = this.paused(body);
    const who = this.person(req, 'admin_control');
    return (await withIdempotency(this.d.idempotency, key, { enforcement: body }, async () => {
      const changed = await this.admin().setEnforcement(paused, who);
      return { status: 200, body: { enforcement: paused ? 'paused' : 'running', changed } };
    })).body;
  }

  @Post('policies/:id/pause')
  @HttpCode(200)
  async pausePolicy(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { paused?: unknown }, @Headers('idempotency-key') key?: string) {
    const paused = this.paused(body);
    const policy = this.d.policies().find((p) => p.id === id);
    if (!policy) throw new ApiError('not_found', `No policy ${id}`);
    const who = this.person(req, 'pause_policy', policy.control ? { control: policy.control } : {});
    return (await withIdempotency(this.d.idempotency, key, { id, ...body }, async () => {
      const changed = await this.admin().setPolicy(id, paused, who);
      return { status: 200, body: { id, paused, changed } };
    })).body;
  }
}
