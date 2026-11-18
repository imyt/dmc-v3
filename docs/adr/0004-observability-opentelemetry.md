# ADR 0004 — Observability on OpenTelemetry

Status: accepted (task F6)

Decision: `@opentelemetry/api` in `@dmc/platform` (runtime) for spans and metrics; `@opentelemetry/sdk-trace-base` and `context-async-hooks` as test-only devDependencies. Logs are our own one-line JSON logger that stamps `trace_id` and `span_id`. The trace context crosses the queue as a `_trace` field on job and outbox payloads (W3C traceparent), so a worker span is a child of the API span.

The exporter (OTLP to the bank's collector) is wired per deployable at startup and needs the platform team's endpoint; until then spans are no-ops, which is safe.

Alternatives: pino (not needed for a one-line logger), a vendor SDK (lock-in).
