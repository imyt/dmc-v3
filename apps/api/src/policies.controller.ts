import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { ApiError } from '@dmc/platform';
import { checkDraft, renderReport } from '@dmc/policy';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const SAMPLE = 200;
interface DraftBody { yaml?: unknown; golden?: unknown; message?: unknown }

/**
 * P3. The policy editor's backend. A draft is checked (compiled, its golden cases run, conflicts looked for, a dry run over sample assets);
 * saving opens a pull request with that report attached. Policies change only by merge, so nothing is written here.
 */
@Controller('v1/policies')
@UseGuards(AuthGuard)
export class PoliciesController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private who(req: AuthedRequest): string {
    const decision = this.d.authz.authorize(req.principal, 'write_policy');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Policies are written by people');
    return decision.subject;
  }

  private text(b: DraftBody): { yaml: string; golden?: string } {
    if (typeof b?.yaml !== 'string' || !b.yaml.trim()) throw new ApiError('validation_failed', 'yaml is required', [{ path: 'yaml', message: 'the policy as YAML' }]);
    if (b.yaml.length > 50_000) throw new ApiError('validation_failed', 'yaml is too long', [{ path: 'yaml', message: 'at most 50,000 characters' }]);
    if (b.golden !== undefined && typeof b.golden !== 'string') throw new ApiError('validation_failed', 'golden must be YAML text', [{ path: 'golden', message: 'text' }]);
    return { yaml: b.yaml, ...(typeof b.golden === 'string' ? { golden: b.golden } : {}) };
  }

  private async report(yaml: string, golden: string | undefined) {
    const ed = this.d.policyEditor;
    if (!ed) throw new ApiError('precondition_failed', 'The policy editor is not configured here');
    // sample assets of the type the draft scopes to, from the catalog (attributes only)
    const probe = checkDraft(yaml, golden, this.d.registry, ed.existing());
    const type = probe.policy?.type;
    const sample: Record<string, Record<string, unknown>[]> = {};
    if (type) {
      const c = await this.d.connect();
      try { sample[type] = (await this.d.store.listByType(c, type, { limit: SAMPLE })).slice(0, SAMPLE).map((n) => ({ qualified_name: n.qualifiedName, ...n.attributes })); } finally { c.release(); }
    }
    return checkDraft(yaml, golden, this.d.registry, ed.existing(), sample);
  }

  /** Check a draft without saving it. */
  @Post('check')
  @HttpCode(200)
  async check(@Req() req: AuthedRequest, @Body() body: DraftBody) {
    this.who(req);
    const { yaml, golden } = this.text(body);
    return this.report(yaml, golden);
  }

  /** Save a draft: only a draft that passes opens a pull request, with the report attached. */
  @Post('propose')
  async propose(@Req() req: AuthedRequest, @Body() body: DraftBody) {
    const actor = this.who(req);
    const { yaml, golden } = this.text(body);
    const rep = await this.report(yaml, golden);
    if (!rep.ok) throw new ApiError('validation_failed', 'The draft does not pass its checks, so no pull request was opened', [...rep.problems.map((m) => ({ path: 'policy', message: m })), ...rep.cases.filter((c) => !c.pass).map((c) => ({ path: `case ${c.name}`, message: c.detail ?? 'failed' })), ...rep.conflicts.map((c) => ({ path: 'conflict', message: `${c.a} and ${c.b}: ${c.reason}` }))]);
    const id = rep.policy!.id;
    const msg = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : `Policy ${id}`;
    const pr = await this.d.changeRequests!.open({
      repo: 'policies', title: msg, author: actor, body: `${msg}\n\nOpened by ${actor} in DMC.\n\n${renderReport(rep)}`,
      files: [{ path: `policies/${id}.yaml`, content: yaml }, ...(golden ? [{ path: `policies/${id}.golden.yaml`, content: golden }] : [])],
    });
    return { ...pr, report: rep };
  }
}
