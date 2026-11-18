import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiError } from '@dmc/platform';
import { checkDraft, renderReport, type PolicySource } from '@dmc/policy';
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

  private reader(req: AuthedRequest): void {
    const decision = this.d.authz.authorize(req.principal, 'read_policy');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
  }

  private async sources(): Promise<{ source: PolicySource; paused: boolean }[]> {
    if (!this.d.policySources) throw new ApiError('conflict', 'The policy sources are not available in this process');
    // paused comes from the control state itself (not the admin-only status endpoint); a process without the switches cannot pause anything
    const state = this.d.admin ? await this.d.admin.state() : { enforcementPaused: false, pausedPolicies: [] as string[] };
    return this.d.policySources().map((source) => ({ source, paused: state.enforcementPaused || state.pausedPolicies.includes(source.id) }));
  }

  private summary({ source: s, paused }: { source: PolicySource; paused: boolean }) {
    return { id: s.id, control: s.control, type: s.type, ...(s.implements ? { implements: s.implements } : {}), mode: s.mode, source_mode: s.sourceMode, paused, effective: s.effective };
  }

  /**
   * Read-only: the policies as stored in the policies folder, with the mode in force here and the pause state. This changes no state,
   * so it writes no outbox row (rule 6 covers state changes). The files are policy rules, metadata only (rule 8).
   */
  @Get()
  async list(@Req() req: AuthedRequest) {
    this.reader(req);
    return { items: (await this.sources()).map((x) => this.summary(x)) };
  }

  /** One policy with its YAML, its golden cases as stored and a checksum of both. Read-only, like the list. */
  @Get(':id')
  async one(@Req() req: AuthedRequest, @Param('id') id: string) {
    this.reader(req);
    const found = (await this.sources()).find((x) => x.source.id === id);
    if (!found) throw new ApiError('not_found', `No policy ${id}`);
    const { source: s } = found;
    return { ...this.summary(found), path: s.path, yaml: s.yaml, golden: s.golden, checksum: s.checksum };
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
