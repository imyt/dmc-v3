import type { Scheduler } from './engine.js';

/** Collects jobs in memory; tests and local runs use it, production uses the pg-boss adapter. */
export class MemoryScheduler implements Scheduler {
  readonly jobs: { queue: string; payload: Record<string, unknown>; runAt?: Date; singletonKey?: string }[] = [];
  async enqueue(queue: string, payload: Record<string, unknown>, opts: { runAt?: Date; singletonKey?: string } = {}): Promise<void> {
    if (opts.singletonKey && this.jobs.some((j) => j.singletonKey === opts.singletonKey)) return;
    this.jobs.push({ queue, payload, ...opts });
  }
  take(queue: string): Record<string, unknown>[] {
    const out = this.jobs.filter((j) => j.queue === queue).map((j) => j.payload);
    this.jobs.splice(0, this.jobs.length, ...this.jobs.filter((j) => j.queue !== queue));
    return out;
  }
}
