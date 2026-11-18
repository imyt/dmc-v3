import { PgBoss } from 'pg-boss';
import type { WorkflowEngine, Scheduler } from './engine.js';
import { QUEUES } from './engine.js';
import type { Queryable } from '@dmc/platform';

/** Production scheduler: delayed jobs live in Postgres (pg-boss), so timers survive restarts. */
export class PgBossScheduler implements Scheduler {
  constructor(private readonly boss: PgBoss) {}

  async enqueue(queue: string, payload: Record<string, unknown>, opts: { runAt?: Date; singletonKey?: string } = {}): Promise<void> {
    await this.boss.send(queue, payload, { startAfter: opts.runAt, singletonKey: opts.singletonKey, retryLimit: 5, retryBackoff: true });
  }
}

/**
 * Starts the worker side: one handler per queue. `getDb` hands each job its own connection
 * (the engine runs transactions on a single connection).
 */
export async function startWorkflowWorkers(boss: PgBoss, engine: WorkflowEngine, getDb: () => Promise<{ db: Queryable; release(): void }>,
  exec: (action: string, ctx: { subjectRef: string; context: Record<string, unknown>; stepRunId: string }) => Promise<void>): Promise<void> {
  for (const q of Object.values(QUEUES)) await boss.createQueue(q);
  await boss.work<{ stepRunId: string }>(QUEUES.step, async (jobs) => {
    for (const j of jobs) { const c = await getDb(); try { await engine.runAction(c.db, j.data.stepRunId, exec); } finally { c.release(); } }
  });
  await boss.work<{ stepRunId: string }>(QUEUES.timer, async (jobs) => {
    for (const j of jobs) { const c = await getDb(); try { await engine.onTimer(c.db, j.data.stepRunId); } finally { c.release(); } }
  });
}
