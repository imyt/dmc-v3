import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { InboxItem } from '@dmc/contracts';
import { ApiError } from '@dmc/platform';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const json = (i: InboxItem) => ({
  id: i.id, assignee: i.assignee, ...(i.exceptionId && { exception_id: i.exceptionId }), kind: i.kind, ...(i.severity && { severity: i.severity }),
  title: i.title, message: i.message, subject_ref: i.subjectRef, decisions: i.decisions, raised_at: i.raisedAt, ...(i.dueAt && { due_at: i.dueAt }), escalated: i.escalated,
});

/** The person the request is for: the caller, or the person an agent acts for. */
const identities = (req: AuthedRequest): string[] => {
  const p = req.principal.actingFor ?? req.principal;
  return [p.id, ...p.groups];
};

/** W2. One queue per person: what is assigned to them or to a group they are in. Deciding is for the assignee only. */
@Controller('v1/inbox')
@UseGuards(AuthGuard)
export class InboxController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const items = await this.d.inbox.list(identities(req));
    return { items: items.map(json), count: items.length };
  }

  @Post(':id/decision')
  @HttpCode(200)
  async decide(@Req() req: AuthedRequest, @Param('id') id: string, @Body() body: { decision?: unknown }, @Headers('idempotency-key') key?: string) {
    if (typeof body?.decision !== 'string' || !body.decision) throw new ApiError('validation_failed', 'decision is required');
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Tasks are decided by people, not by agents or scripts');
    const item = await this.d.inbox.get(id).catch(() => undefined); // an id that is not a uuid is just "not found"
    if (!item) throw new ApiError('not_found', 'No such task, or it is already decided');
    const decision = this.d.authz.authorize(req.principal, 'decide_task', { assignee: item.assignee });
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    if (!item.decisions.includes(body.decision)) throw new ApiError('validation_failed', `decision must be one of ${item.decisions.join(', ')}`);
    return this.d.inbox.decide({ taskId: id, decision: body.decision, actor: decision.subject, assignees: identities(req), key });
  }
}
