import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiError, parseDryRun, withIdempotency, type Queryable } from '@dmc/platform';
import { CatalogDelegations, type DelegationView } from '@dmc/catalog';
import type { FastifyReply } from 'fastify';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const json = (d: DelegationView, today: string) => ({
  qualified_name: d.qualifiedName, owner: d.owner, delegate: d.delegate, covers: d.covers, ...(d.scopeQn ? { scope: d.scopeQn } : {}),
  valid_from: d.validFrom, valid_to: d.validTo, ...(d.reason ? { reason: d.reason } : {}), active: d.validFrom <= today && d.validTo >= today,
});

/**
 * C2. Scope owners give named people the right to prepare and submit, for at most 12 months. Only the owner creates or revokes one;
 * a delegate cannot pass it on. Each grant and revoke is a catalog change, so it is in the ledger.
 */
@Controller('v1/delegations')
@UseGuards(AuthGuard)
export class DelegationsController {
  private readonly delegations: CatalogDelegations;
  constructor(@Inject(DEPS) private readonly d: ApiDeps) { this.delegations = new CatalogDelegations(d.store); }

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  private person(req: AuthedRequest): string {
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Delegations are granted by scope owners themselves; agents and scripts cannot grant them');
    return req.principal.id;
  }

  /** Delegations you granted and delegations you hold. */
  @Get()
  async mine(@Req() req: AuthedRequest) {
    const me = req.principal.actingFor?.id ?? req.principal.id;
    const today = new Date().toISOString().slice(0, 10);
    const all = await this.withDb((db) => this.delegations.all(db));
    return { granted: all.filter((x) => x.owner === me).map((x) => json(x, today)), received: all.filter((x) => x.delegate === me).map((x) => json(x, today)) };
  }

  @Post()
  async grant(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Body() body: { delegate?: string; covers?: string; scope?: string; valid_from?: string; valid_to?: string; reason?: string },
    @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const me = this.person(req);
    const dry = parseDryRun(q.dry_run);
    const run = async () => {
      const c = await this.d.connect();
      try {
        // only the owner: the delegate list is left empty so a delegate cannot re-delegate
        if (body?.covers === 'one-scope') {
          const scope = body.scope ? await this.d.store.getNode(c, body.scope) : undefined;
          if (!scope || scope.type !== 'Scope') throw new ApiError('not_found', `No scope ${body.scope ?? ''}`.trim());
          const decision = this.d.authz.authorize(req.principal, 'scope_delegate', { ...(typeof scope.attributes.owner === 'string' ? { scopeOwner: scope.attributes.owner } : {}), scopeDelegates: [] });
          if (!decision.allowed) throw new ApiError('forbidden', 'Only the scope’s owner can delegate it');
        } else {
          const owns = (await this.d.store.listByType(c, 'Scope', { limit: 5000 })).some((s) => s.attributes.owner === me);
          const decision = this.d.authz.authorize(req.principal, 'scope_delegate', { scopeOwner: owns ? me : '', scopeDelegates: [] });
          if (!decision.allowed) throw new ApiError('forbidden', 'You do not own any scope to delegate');
        }
        await c.query('begin');
        let made: DelegationView;
        try {
          made = await this.delegations.create(c, { owner: me, delegate: body?.delegate ?? '', covers: body?.covers ?? '', scopeQn: body?.scope, validFrom: body?.valid_from, validTo: body?.valid_to ?? '', reason: body?.reason, actor: me });
        } catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
        return { status: dry ? 200 : 201, body: dry ? { dry_run: true } : json(made, new Date().toISOString().slice(0, 10)) };
      } finally { c.release(); }
    };
    const out = dry ? await run() : await withIdempotency(this.d.idempotency, key, body, run);
    void res.status(out.status);
    return out.body;
  }

  @Delete(':id')
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string) {
    const me = this.person(req);
    await this.withDb(async (c) => {
      const n = await this.d.store.getNode(c, id);
      if (!n || n.type !== 'Delegation' || n.lifecycle === 'deprecated') throw new ApiError('not_found', 'No such active delegation');
      const decision = this.d.authz.authorize(req.principal, 'scope_delegate', { scopeOwner: String(n.attributes.owner), scopeDelegates: [] });
      if (!decision.allowed) throw new ApiError('forbidden', 'Only the owner who granted a delegation can revoke it');
      await this.d.store.tx(c, () => this.delegations.revoke(c, id, me));
    });
    return { qualified_name: id, ended: 'revoked' };
  }
}
