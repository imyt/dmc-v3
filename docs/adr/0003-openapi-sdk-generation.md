# ADR 0003 — OpenAPI SDK generation

Status: accepted (task F5)

Decision: the OpenAPI file in `@dmc/contracts` is the API contract. `openapi-typescript` (root devDependency) generates `packages/sdk/src/schema.d.ts`; `openapi-fetch` (runtime, `@dmc/sdk`) is the typed client. CI runs `pnpm run sdk:check` so a stale SDK fails. `ajv` and `yaml` (already approved in ADR 0002) power the contract-test helper.

Conventions (see `@dmc/platform` http/conventions): RFC 9457 problems with a closed `code` set, opaque cursor pagination, `dry_run`, `Idempotency-Key` on creates, `ETag`/`If-Match` on updates.

Alternatives: orval or hey-api generators (heavier output, more config); hand-written client (drifts).
