import { Body, Controller, Get, Headers, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiError, parseDryRun, withIdempotency } from '@dmc/platform';
import type { Queryable } from '@dmc/platform';
import type { FastifyReply } from 'fastify';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';
import { parseCsv } from './csv.js';

const TYPE = 'ControlRequirement';
const FIELDS = ['reference_id', 'title', 'kind', 'owner', 'confluence_link', 'version'] as const;
type Row = Partial<Record<(typeof FIELDS)[number], unknown>>;
export const requirementName = (ref: string): string => `requirement-${ref.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

interface Plan { line: number; reference_id: string; qn: string; attrs: Record<string, unknown>; status: 'created' | 'updated' | 'unchanged'; versionFrom?: number; versionTo: number }

/**
 * Control requirements: entered here (form or CSV) until a Confluence job can sync them. A higher version flags every policy that
 * implements the requirement for review. The coverage view shows which requirements have no policy, only shadow policies, or enforced ones.
 */
@Controller('v1/requirements')
@UseGuards(AuthGuard)
export class RequirementsController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private who(req: AuthedRequest): string {
    const decision = this.d.authz.authorize(req.principal, 'write_requirement');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    if (req.principal.kind !== 'person' || req.principal.actingFor)
      throw new ApiError('forbidden', 'Requirements are registered by people; agents propose changes through a policy, not here');
    return decision.subject;
  }

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  /** Check every row against the metamodel and the current catalog; nothing is written. */
  private async plan(rows: Row[], firstLine: number): Promise<{ plans: Plan[]; problems: { path: string; message: string }[] }> {
    const plans: Plan[] = []; const problems: { path: string; message: string }[] = [];
    const seen = new Set<string>();
    await this.withDb(async (db) => {
      for (const [i, r] of rows.entries()) {
        const line = firstLine + i;
        const bad = (field: string, message: string) => problems.push({ path: `line ${line}: ${field}`, message });
        const ref = typeof r.reference_id === 'string' ? r.reference_id.trim() : '';
        if (!ref) { bad('reference_id', 'required'); continue; }
        if (seen.has(ref)) { bad('reference_id', `${ref} appears twice`); continue; }
        seen.add(ref);
        const attrs: Record<string, unknown> = { reference_id: ref };
        for (const f of FIELDS.slice(1)) {
          const v = r[f];
          if (v === undefined || v === null || v === '') continue;
          attrs[f] = f === 'version' ? (typeof v === 'number' ? v : Number(v)) : typeof v === 'string' ? v.trim() : v;
        }
        attrs.version ??= 1;
        const qn = requirementName(ref);
        const existing = await this.d.store.getNode(db, qn);
        if (existing && existing.type !== TYPE) { bad('reference_id', `${qn} is already used by a ${existing.type}`); continue; }
        const versionFrom = existing ? Number(existing.attributes.version) : undefined;
        if (versionFrom !== undefined && Number(attrs.version) < versionFrom) { bad('version', `is ${attrs.version}; ${ref} is already at version ${versionFrom}`); continue; }
        const problemsHere = this.d.store.validate(TYPE, attrs, { kind: 'user' }, { partial: !!existing });
        if (problemsHere.length) { for (const p of problemsHere) bad(p.path || 'row', p.message); continue; }
        const changed = !existing || Object.entries(attrs).some(([k, v]) => JSON.stringify(existing.attributes[k]) !== JSON.stringify(v));
        plans.push({ line, reference_id: ref, qn, attrs, status: !existing ? 'created' : changed ? 'updated' : 'unchanged', versionFrom, versionTo: Number(attrs.version) });
      }
    });
    return { plans, problems };
  }

  private async apply(plans: Plan[], actor: string): Promise<{ flagged: { policy: string; reference_id: string }[] }> {
    const flagged: { policy: string; reference_id: string }[] = [];
    await this.withDb(async (db) => {
      await this.d.store.tx(db, async () => {
        for (const p of plans) if (p.status !== 'unchanged') await this.d.store.applyNode(db, { type: TYPE, qualifiedName: p.qn, attributes: p.attrs, writer: { kind: 'user' }, actor });
      });
    });
    for (const p of plans) {
      if (p.versionFrom === undefined || p.versionTo <= p.versionFrom) continue;
      for (const pol of this.d.policies().filter((x) => x.implements === p.reference_id)) {
        await this.d.exceptions.raise({ kind: 'policy.review', severity: 'medium', subjectRef: `Policy:${pol.id}`, route: 'policy-authors', actor,
          message: `Requirement ${p.reference_id} is now version ${p.versionTo}. Review that this policy still implements it.` });
        flagged.push({ policy: pol.id, reference_id: p.reference_id });
      }
    }
    return { flagged };
  }

  private report(plans: Plan[], flagged: { policy: string }[], dry: boolean) {
    return {
      dry_run: dry,
      rows: plans.map((p) => ({ line: p.line, reference_id: p.reference_id, qualified_name: p.qn, status: p.status, version: p.versionTo })),
      created: plans.filter((p) => p.status === 'created').length, updated: plans.filter((p) => p.status === 'updated').length, unchanged: plans.filter((p) => p.status === 'unchanged').length,
      flagged_policies: dry ? this.wouldFlag(plans) : flagged.map((f) => f.policy),
    };
  }
  private wouldFlag(plans: Plan[]): string[] {
    return plans.filter((p) => p.versionFrom !== undefined && p.versionTo > p.versionFrom).flatMap((p) => this.d.policies().filter((x) => x.implements === p.reference_id).map((x) => x.id));
  }

  private async run(req: AuthedRequest, rows: Row[], firstLine: number, q: Record<string, string>, key: string | undefined, body: unknown, res: FastifyReply, created: boolean) {
    const actor = this.who(req);
    const dry = parseDryRun(q.dry_run);
    const go = async () => {
      const { plans, problems } = await this.plan(rows, firstLine);
      if (problems.length) throw new ApiError('validation_failed', 'Nothing was saved: some rows are invalid', problems);
      if (dry) return this.report(plans, [], true);
      const { flagged } = await this.apply(plans, actor);
      return this.report(plans, flagged, false);
    };
    const out = dry ? await go() : await withIdempotency(this.d.idempotency, key, body, go);
    void res.status(created && !dry && out.created > 0 ? 201 : 200);
    return out;
  }

  /** One requirement from the form. A new reference id creates it; a higher version of an existing one updates it and flags its policies. */
  @Post()
  async one(@Req() req: AuthedRequest, @Body() body: Row, @Query() q: Record<string, string>, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    return this.run(req, [body ?? {}], 1, q, key, body, res, true);
  }

  /** Many from a CSV (header row: reference_id,title,kind,owner,confluence_link,version). All rows are checked first; one bad row saves nothing. */
  @Post('import')
  async import(@Req() req: AuthedRequest, @Body() body: { csv?: string }, @Query() q: Record<string, string>, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    if (typeof body?.csv !== 'string' || !body.csv.trim()) throw new ApiError('validation_failed', 'csv is required', [{ path: 'csv', message: 'required' }]);
    const table = parseCsv(body.csv);
    const header = (table[0] ?? []).map((h) => h.trim());
    const unknown = header.filter((h) => !(FIELDS as readonly string[]).includes(h));
    if (unknown.length || !header.includes('reference_id')) throw new ApiError('validation_failed', 'The first row must name the columns', [{ path: 'line 1', message: unknown.length ? `unknown column ${unknown.join(', ')}` : 'reference_id column is required' }]);
    const rows: Row[] = table.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
    if (rows.length === 0) throw new ApiError('validation_failed', 'The file has no rows', [{ path: 'csv', message: 'no data rows' }]);
    if (rows.length > 5000) throw new ApiError('validation_failed', 'At most 5000 rows at a time', [{ path: 'csv', message: 'too many rows' }]);
    return this.run(req, rows, 2, q, key, body, res, true);
  }

  @Get('coverage')
  async coverage() {
    const policies = this.d.policies();
    const items = await this.withDb(async (db) => {
      const out: { reference_id: string; title: string; kind: string; version: number; qualified_name: string; status: 'none' | 'shadow_only' | 'enforced'; policies: { id: string; mode: string }[] }[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await this.d.store.listByType(db, TYPE, { limit: 200, afterQn: after });
        for (const n of page) {
          const mine = policies.filter((p) => p.implements === n.attributes.reference_id);
          out.push({ reference_id: String(n.attributes.reference_id), title: String(n.attributes.title), kind: String(n.attributes.kind), version: Number(n.attributes.version), qualified_name: n.qualifiedName,
            status: mine.some((p) => p.mode === 'enforced') ? 'enforced' : mine.length ? 'shadow_only' : 'none', policies: mine.map((p) => ({ id: p.id, mode: p.mode })) });
        }
        if (page.length < 200) break;
        after = page.at(-1)!.qualifiedName;
      }
      return out;
    });
    const known = new Set(items.map((i) => i.reference_id));
    return {
      items,
      summary: { none: items.filter((i) => i.status === 'none').length, shadow_only: items.filter((i) => i.status === 'shadow_only').length, enforced: items.filter((i) => i.status === 'enforced').length },
      unknown_references: policies.filter((p) => p.implements && !known.has(p.implements)).map((p) => ({ policy: p.id, implements: p.implements! })),
    };
  }
}
