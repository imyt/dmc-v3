import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiError, parseDryRun, withIdempotency, type Queryable } from '@dmc/platform';
import type { NodeRecord } from '@dmc/catalog';
import type { FastifyReply } from 'fastify';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const DERIVED = { kind: 'sync', source: 'derived' } as const;
const encode = (column: string, code: string): string => Buffer.from(`${column}\n${code}`).toString('base64url');
const decode = (id: string): { column: string; code: string } => {
  const [column, code] = Buffer.from(id, 'base64url').toString().split('\n');
  if (!column || !code) throw new ApiError('not_found', 'No such proposal');
  return { column, code };
};
const codeOf = (qn: string): string => qn.slice(qn.lastIndexOf(':') + 1);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * L2. A classification that follows lineage arrives as a proposal on the column; its steward accepts or rejects it.
 * Accepting writes the classification itself (with who accepted it), and tells the decision path the proposal is gone, which closes the steward's task.
 * Rejecting remembers it, so the same classification is not proposed for that column again.
 */
@Controller('v1/classifications')
@UseGuards(AuthGuard)
export class ClassificationsController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  /** Facts about who looks after the column: its domain, or "unassigned" so that any steward may. */
  private async facts(db: Queryable, column: NodeRecord) {
    const e = (await this.d.store.namedEdgesOf(db, column.qualifiedName, { name: 'in_domain', direction: 'out' }))[0];
    return e ? { domain: codeOf(e.toQn), unassigned: false, locked: false } : { domain: '', unassigned: true, locked: false };
  }

  private mayDecide(req: AuthedRequest, facts: Awaited<ReturnType<ClassificationsController['facts']>>) {
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Classifications are accepted by their stewards; agents and scripts cannot decide them');
    const decision = this.d.authz.authorize(req.principal, 'decide_classification', facts);
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    return decision;
  }

  @Get('proposals')
  async proposals(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const mine = q.mine === 'true';
    return this.withDb(async (db) => {
      const out = [];
      for (const c of await this.d.store.listByType(db, 'Column', { limit: 5000 })) {
        const codes = list(c.attributes.proposed_classification);
        if (!codes.length) continue;
        const facts = await this.facts(db, c);
        const can = req.principal.kind === 'person' && !req.principal.actingFor && this.d.authz.authorize(req.principal, 'decide_classification', facts).allowed;
        if (mine && !can) continue;
        const via = list(c.attributes.proposed_from);
        for (const code of codes) {
          const k = await this.d.store.getNode(db, code);
          out.push({ id: encode(c.qualifiedName, code), column: c.qualifiedName, code, ...(typeof k?.attributes.name === 'string' ? { name: k.attributes.name } : {}), via, can_decide: can });
        }
      }
      out.sort((a, b) => a.column.localeCompare(b.column) || a.code.localeCompare(b.code));
      return { proposals: out };
    });
  }

  @Post('proposals/:id/decision')
  @HttpCode(200)
  async decide(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('id') id: string, @Body() body: { decision?: unknown }, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const decision = body?.decision;
    if (decision !== 'accept' && decision !== 'reject') throw new ApiError('validation_failed', 'decision must be accept or reject', [{ path: 'decision', message: 'accept or reject' }]);
    const { column, code } = decode(id);
    const dry = parseDryRun(q.dry_run);
    const go = async () => {
      const c = await this.d.connect();
      try {
        const col = await this.d.store.getNode(c, column);
        if (!col || col.type !== 'Column') throw new ApiError('not_found', 'No such proposal');
        const open = list(col.attributes.proposed_classification);
        if (!open.includes(code)) throw new ApiError('not_found', 'That proposal is no longer open');
        const who = this.mayDecide(req, await this.facts(c, col)).subject;
        let newOpen: string[] = [];
        await c.query('begin');
        try {
          newOpen = open.filter((x) => x !== code);
          if (decision === 'accept') {
            if ((await this.d.store.getNode(c, code))?.type !== 'Classification') throw new ApiError('conflict', `${code} is no longer a classification in the catalog`);
            await this.d.store.link(c, { name: 'classified_as', fromQn: column, toQn: code, source: 'dmc', actor: who, attributes: { accepted_by: who, accepted_at: new Date().toISOString() } });
          } else {
            const rejected = [...new Set([...list(col.attributes.rejected_classification), code])].sort();
            await this.d.store.applyNode(c, { type: 'Column', qualifiedName: column, attributes: { rejected_classification: rejected }, writer: { kind: 'user' }, actor: who });
          }
          await this.d.store.applyNode(c, { type: 'Column', qualifiedName: column, attributes: { proposed_classification: newOpen, ...(newOpen.length ? {} : { proposed_from: [] }) }, writer: DERIVED, actor: who });
        } catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
        // the decision path sees the column without the proposal: that closes the steward's task (and keeps it open while other proposals remain)
        if (!dry) await this.d.signals.submit([{ source: 'api', key: `classify:${column}:${decision}:${code}:${Date.now()}`, kind: 'derived.upsert', subjectRef: `Column:${column}`, subjectType: 'Column', actor: who,
          asset: { ...col.attributes, qualified_name: column, proposed_classification: newOpen } }]);
        return { status: 200, body: dry ? { dry_run: true } : { column, code, decision: decision === 'accept' ? 'accepted' : 'rejected', remaining: newOpen.length } };
      } finally { c.release(); }
    };
    const out = dry ? await go() : await withIdempotency(this.d.idempotency, key, body ? { id, ...body } : { id }, go);
    void res.status(out.status);
    return out.body;
  }
}
