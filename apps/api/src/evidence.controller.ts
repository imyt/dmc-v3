import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiError, decodeCursor, parseLimit, toPage } from '@dmc/platform';
import { ProofTooLarge, exportProof, trace, verifyChain, type TraceEntry } from '@dmc/evidence';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const entryJson = (e: TraceEntry) => ({ seq: e.seq, kind: e.kind, subject_ref: e.subjectRef, actor: e.actor, source_module: e.sourceModule, occurred_at: e.occurredAt,
  payload: e.payload, payload_hash: e.payloadHash, prev_hash: e.prevHash, hash: e.hash });

/** Evidence is read by auditors, admins and control owners. Nothing here writes: the ledger has one writer, the worker. */
@Controller('v1')
@UseGuards(AuthGuard)
export class EvidenceController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private allow(req: AuthedRequest) {
    const decision = this.d.authz.authorize(req.principal, 'read_evidence');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
  }

  /** The names the ledger knows a node by: its id (catalog events) and `<Type>:<qualified name>` (decisions, actions, exceptions). */
  private async subjects(qn: string): Promise<string[]> {
    const c = await this.d.connect();
    try {
      const n = await this.d.store.getNode(c, qn);
      if (!n) throw new ApiError('not_found', `No ${qn} in the catalog`);
      return [`node/${n.id}`, `${n.type}:${n.qualifiedName}`];
    } finally { c.release(); }
  }

  private async withEvidence<R>(fn: (db: import('@dmc/platform').Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connectEvidence();
    try { return await fn(c); } finally { c.release(); }
  }

  @Get('nodes/:qn/evidence')
  async list(@Req() req: AuthedRequest, @Param('qn') qn: string, @Query() q: Record<string, string>) {
    this.allow(req);
    const limit = parseLimit(q.limit, 200);
    const after = decodeCursor<{ seq: number }>(q.cursor)?.seq;
    const subjects = await this.subjects(qn);
    const rows = await this.withEvidence((db) => trace(db, subjects, { afterSeq: after, limit: limit + 1, kind: q.kind }));
    const page = toPage(rows, limit, (last) => ({ seq: last.seq }));
    return { items: page.items.map(entryJson), next_cursor: page.next_cursor };
  }

  @Get('nodes/:qn/evidence/proof')
  async proof(@Req() req: AuthedRequest, @Param('qn') qn: string) {
    this.allow(req);
    const subjects = await this.subjects(qn);
    try { return await this.withEvidence((db) => exportProof(db, subjects)); }
    catch (e) { if (e instanceof ProofTooLarge) throw new ApiError('validation_failed', e.message); throw e; }
  }

  @Get('evidence/verify')
  async verify(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    this.allow(req);
    const num = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new ApiError('validation_failed', `${name} must be a positive integer`, [{ path: name, message: 'positive integer' }]);
      return n;
    };
    const r = await this.withEvidence((db) => verifyChain(db, { fromSeq: num(q.from_seq, 'from_seq'), toSeq: num(q.to_seq, 'to_seq') }));
    return { ok: r.ok, checked: r.checked, ...(r.firstBadSeq !== undefined ? { first_bad_seq: r.firstBadSeq } : {}), ...(r.reason ? { reason: r.reason } : {}) };
  }
}
