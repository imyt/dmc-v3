import type { PgBoss } from 'pg-boss';
import type { Queryable } from '@dmc/platform';
import type { ResolvedJob } from './definition.js';
import type { SyncService } from './service.js';

export const SYNC_QUEUE = 'sync.run';
export const SYNC_APPROVE_QUEUE = 'sync.approve';
export interface SyncApproveData { runId: string; actor: string }
export interface SyncJobData { job: string; environment: string; trigger: 'schedule' | 'manual'; actor?: string }

/** One schedule per enabled job and environment. Disabled jobs lose their schedule. */
export async function registerSchedules(boss: PgBoss, jobs: ResolvedJob[]): Promise<void> {
  await boss.createQueue(SYNC_QUEUE);
  for (const j of jobs) {
    const key = `${j.environment}/${j.def.job}`;
    if (j.enabled) await boss.schedule(SYNC_QUEUE, j.schedule, { job: j.def.job, environment: j.environment, trigger: 'schedule' } satisfies SyncJobData, { key });
    else await boss.unschedule(SYNC_QUEUE, key);
  }
}

/** On demand from the admin screen. The singleton key stops two runs of one job overlapping. */
export async function runNow(boss: PgBoss, job: string, environment: string, actor: string): Promise<string | null> {
  return boss.send(SYNC_QUEUE, { job, environment, trigger: 'manual', actor } satisfies SyncJobData, { singletonKey: `${environment}/${job}` });
}

export async function startSyncWorker(boss: PgBoss, svc: SyncService, getDb: () => Promise<{ db: Queryable; release(): void }>): Promise<void> {
  await boss.createQueue(SYNC_QUEUE);
  // S12: an admin accepted a run the change limit held; the worker has the sinks that carry its signals out
  await boss.createQueue(SYNC_APPROVE_QUEUE);
  await boss.work<SyncApproveData>(SYNC_APPROVE_QUEUE, async (jobs) => {
    for (const j of jobs) {
      const c = await getDb();
      try { await svc.approve(c.db, j.data.runId, j.data.actor); } finally { c.release(); }
    }
  });
  await boss.work<SyncJobData>(SYNC_QUEUE, async (jobs) => {
    for (const j of jobs) {
      const c = await getDb();
      try { await svc.run(c.db, j.data.job, j.data.environment, { trigger: j.data.trigger, actor: j.data.actor }); } finally { c.release(); }
    }
  });
}
