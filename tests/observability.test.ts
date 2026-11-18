import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { propagation } from '@opentelemetry/api';
import { createLogger, runJob, withSpan, withTrace } from '../packages/platform/src/index';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});
afterAll(() => exporter.reset());

describe('observability', () => {
  it('one trace spans api → queue → worker', async () => {
    let queued: ReturnType<typeof withTrace<{ task: string }>> | undefined;
    await withSpan('api POST /v1/examples', async () => {
      queued = withTrace({ task: 'sync' }); // what goes into pg-boss / the outbox
    });
    // the worker runs later, in a different async context
    await runJob('worker sync', queued!, async () => {});
    const spans = exporter.getFinishedSpans();
    const api = spans.find((s) => s.name.startsWith('api'))!;
    const worker = spans.find((s) => s.name === 'worker sync')!;
    expect(worker.spanContext().traceId).toBe(api.spanContext().traceId);
    expect(worker.parentSpanContext?.spanId ?? (worker as any).parentSpanId).toBe(api.spanContext().spanId);
  });

  it('logs one JSON line with trace ids and no surprises', async () => {
    const lines: string[] = [];
    const log = createLogger({ module: 'catalog', sink: (l) => lines.push(l), now: () => new Date('2026-01-01T00:00:00Z') });
    await withSpan('x', () => log.info('applied', { count: 3 }));
    log.debug('hidden');
    const rec = JSON.parse(lines[0]!);
    expect(lines).toHaveLength(1);
    expect(rec).toMatchObject({ level: 'info', module: 'catalog', msg: 'applied', count: 3 });
    expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
});
