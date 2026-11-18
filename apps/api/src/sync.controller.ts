import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { SyncAdminPort, SyncJobView, SyncRunView } from '@dmc/contracts';
import { ApiError, checkIfMatch, decodeCursor, parseLimit, toPage, withIdempotency } from '@dmc/platform';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runJson = (r: SyncRunView) => ({
  id: r.id, job: r.job, environment: r.environment, trigger: r.trigger, status: r.status, mode: r.mode, complete: r.complete,
  started_at: r.startedAt, finished_at: r.finishedAt, counts: r.counts, note: r.note, etag: r.etag,
});
export const jobJson = (j: SyncJobView) => ({
  name: j.name, environment: j.environment, version: j.version, enabled: j.enabled, paused: j.paused, schedule: j.schedule,
  connection: j.connection, connection_type: j.connectionType, mode: j.mode, max_changes_pct: j.maxChangesPct,
  last_run: j.lastRun ? runJson(j.lastRun) : null, last_success_at: j.lastSuccessAt, awaiting_review: j.awaitingReview, etag: j.etag,
});

/**
 * S12. The sync admin screen's API. Reading and pressing are both the `sync_admin` action (administrators only), and only people press:
 * agents and scripts get 403. A run happens in the worker; run now and approve only queue it, so a request never waits on a source system.
 */
@Controller('v1/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private sync(): SyncAdminPort {
    if (!this.d.sync) throw new ApiError('conflict', 'Sync administration is not available in this process');
    return this.d.sync;
  }

  private read(req: AuthedRequest): void {
    const decision = this.d.authz.authorize(req.principal, 'sync_admin');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
  }

  private person(req: AuthedRequest): string {
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Sync jobs are run and paused by people, not by agents or scripts');
    const decision = this.d.authz.authorize(req.principal, 'sync_admin');
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    return decision.subject;
  }

  private async mustJob(environment: string, name: string): Promise<SyncJobView> {
    const j = await this.sync().job(environment, name);
    if (!j) throw new ApiError('not_found', `No job ${name} in ${environment}`);
    return j;
  }

  private async mustRun(id: string): Promise<SyncRunView> {
    const r = UUID.test(id) ? await this.sync().run(id) : undefined;
    if (!r) throw new ApiError('not_found', `No run ${id}`);
    return r;
  }

  @Get('jobs')
  async jobs(@Req() req: AuthedRequest) {
    this.read(req);
    return { items: (await this.sync().jobs()).map(jobJson) };
  }

  @Get('jobs/:environment/:name')
  async job(@Req() req: AuthedRequest, @Param('environment') environment: string, @Param('name') name: string, @Res({ passthrough: true }) res: FastifyReply) {
    this.read(req);
    const j = await this.mustJob(environment, name);
    void res.header('etag', j.etag);
    return jobJson(j);
  }

  @Get('jobs/:environment/:name/runs')
  async runs(@Req() req: AuthedRequest, @Param('environment') environment: string, @Param('name') name: string, @Query() q: Record<string, string>) {
    this.read(req);
    const limit = parseLimit(q.limit, 200);
    const before = decodeCursor<{ startedAt: string; id: string }>(q.cursor);
    if (before && (typeof before.startedAt !== 'string' || Number.isNaN(Date.parse(before.startedAt)) || !UUID.test(String(before.id)))) throw new ApiError('validation_failed', 'Invalid cursor', [{ path: 'cursor', message: 'not a valid cursor' }]);
    await this.mustJob(environment, name);
    const rows = await this.sync().runs(environment, name, { limit: limit + 1, ...(before ? { before } : {}) });
    const page = toPage(rows, limit, (last) => ({ startedAt: last.startedAt, id: last.id }));
    return { items: page.items.map(runJson), next_cursor: page.next_cursor };
  }

  @Get('runs/:id')
  async run(@Req() req: AuthedRequest, @Param('id') id: string, @Res({ passthrough: true }) res: FastifyReply) {
    this.read(req);
    const r = await this.mustRun(id);
    void res.header('etag', r.etag);
    return runJson(r);
  }

  @Post('jobs/:environment/:name/pause')
  @HttpCode(200)
  async pause(@Req() req: AuthedRequest, @Param('environment') environment: string, @Param('name') name: string, @Body() body: { paused?: unknown },
    @Headers('idempotency-key') key: string | undefined, @Headers('if-match') ifMatch: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const who = this.person(req);
    if (typeof body?.paused !== 'boolean') throw new ApiError('validation_failed', 'paused must be true or false', [{ path: 'paused', message: 'true or false' }]);
    const paused = body.paused;
    const out = await withIdempotency(this.d.idempotency, key, { environment, name, paused }, async () => {
      const j = await this.mustJob(environment, name);
      checkIfMatch(ifMatch, j.etag);   // inside the replay guard: the same press sent twice answers the same, though the job has changed since
      await this.sync().setPaused(environment, name, paused, who);
      return jobJson(await this.mustJob(environment, name));
    });
    void res.header('etag', out.etag);
    return out;
  }

  @Post('jobs/:environment/:name/run')
  @HttpCode(202)
  async runNow(@Req() req: AuthedRequest, @Param('environment') environment: string, @Param('name') name: string, @Headers('idempotency-key') key?: string) {
    const who = this.person(req);
    await this.mustJob(environment, name);
    return withIdempotency(this.d.idempotency, key, { environment, name, run: true }, async () => {
      const r = await this.sync().runNow(environment, name, who);
      if (!r.queued) throw new ApiError('conflict', r.conflict);
      return { queued: true as const };
    });
  }

  @Post('runs/:id/approve')
  @HttpCode(202)
  async approve(@Req() req: AuthedRequest, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Headers('if-match') ifMatch: string | undefined) {
    const who = this.person(req);
    return withIdempotency(this.d.idempotency, key, { id, approve: true }, async () => {
      const run = await this.mustRun(id);
      if (run.status !== 'paused_limit') throw new ApiError('conflict', 'The run is not waiting for review.');
      checkIfMatch(ifMatch, run.etag);
      const r = await this.sync().approve(id, who);
      if (!r.queued) throw new ApiError('conflict', r.conflict);
      return { queued: true as const };
    });
  }
}
