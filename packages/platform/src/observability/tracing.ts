import { context, propagation, trace, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = () => trace.getTracer('dmc');

/** Run `fn` inside a span; records errors and always ends the span. */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, attrs?: Record<string, string | number | boolean>): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Carrier added to queue payloads and outbox rows so the worker continues the caller's trace. */
export type TraceCarrier = { traceparent?: string; tracestate?: string };

export function currentCarrier(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Attach the current trace to a job or outbox payload under `_trace`. */
export const withTrace = <T extends object>(payload: T): T & { _trace: TraceCarrier } => ({ ...payload, _trace: currentCarrier() });

/** Run a queue handler as a child of the span that enqueued the job. */
export async function runJob<T extends { _trace?: TraceCarrier }, R>(name: string, job: T, fn: (job: T, span: Span) => Promise<R> | R): Promise<R> {
  const parent = propagation.extract(context.active(), job._trace ?? {});
  return context.with(parent, () => withSpan(name, (span) => fn(job, span), { 'dmc.kind': 'job' }));
}

export const currentTraceId = (): string | undefined => trace.getActiveSpan()?.spanContext().traceId;
