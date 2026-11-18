import type { PgBoss } from 'pg-boss';
import type { Queryable } from '@dmc/platform';
import { registerSchedules, startSyncWorker, type ResolvedJob } from '@dmc/connectors';
import type { Composition } from './compose.js';

export const TICK_QUEUE = 'worker.tick';
export const DERIVE_QUEUE = 'worker.derive';
export const SCOPE_OWNERS_QUEUE = 'worker.scope-owners';
export const VERIFY_RECENT_QUEUE = 'verify.recent';
export const VERIFY_FULL_QUEUE = 'verify.full';
const RECENT_ENTRIES = 50_000;

/**
 * Starts what the worker does on a clock: the sync schedules, the sync runner, and the minute-by-minute housekeeping.
 * `getDb` hands out a connection as the connectors role for a run.
 */
export async function startWorker(boss: PgBoss, c: Composition, jobs: ResolvedJob[], getDb: () => Promise<{ db: Queryable; release(): void }>, onTick?: (r: Awaited<ReturnType<Composition['tick']>>) => void): Promise<void> {
  await registerSchedules(boss, jobs);
  await startSyncWorker(boss, c.sync, getDb);
  await boss.createQueue(TICK_QUEUE);
  await boss.schedule(TICK_QUEUE, '* * * * *', {}, { key: 'tick' });
  await boss.work(TICK_QUEUE, async () => { onTick?.(await c.tick()); });
  await boss.createQueue(DERIVE_QUEUE);
  await boss.schedule(DERIVE_QUEUE, '*/15 * * * *', {}, { key: 'derive' });
  await boss.work(DERIVE_QUEUE, async () => { await c.derive(); });
  // scope owners that were unknown when the scope was synced: withdraw the exception once the Person is in the catalog
  await boss.createQueue(SCOPE_OWNERS_QUEUE);
  await boss.schedule(SCOPE_OWNERS_QUEUE, '*/15 * * * *', {}, { key: 'scope-owners' });
  await boss.work(SCOPE_OWNERS_QUEUE, async () => { await c.scopeOwners.recheck(); });
  // the verifier: recent entries every 10 minutes, the whole chain every night
  await boss.createQueue(VERIFY_RECENT_QUEUE); await boss.createQueue(VERIFY_FULL_QUEUE);
  await boss.schedule(VERIFY_RECENT_QUEUE, '*/10 * * * *', {}, { key: 'verify-recent' });
  await boss.schedule(VERIFY_FULL_QUEUE, '0 2 * * *', {}, { key: 'verify-full' });
  await boss.work(VERIFY_RECENT_QUEUE, async () => { await c.verify({ recent: RECENT_ENTRIES }); });
  await boss.work(VERIFY_FULL_QUEUE, async () => { await c.verify(); });
}
