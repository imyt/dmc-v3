import { trace } from '@opentelemetry/api';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink { (line: string): void }

/** One JSON object per line; trace_id and span_id are added when a span is active. Metadata only: never log record data. */
export function createLogger(opts: { module: string; level?: Level; sink?: LogSink; now?: () => Date }) {
  const min = RANK[opts.level ?? 'info'];
  const sink = opts.sink ?? ((l) => process.stdout.write(l + '\n'));
  const now = opts.now ?? (() => new Date());
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < min) return;
    const sc = trace.getActiveSpan()?.spanContext();
    sink(JSON.stringify({
      ts: now().toISOString(), level, module: opts.module, msg,
      ...(sc && { trace_id: sc.traceId, span_id: sc.spanId }),
      ...fields,
    }));
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
    info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
    error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;
