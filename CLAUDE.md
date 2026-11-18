# DMC — rules for coding agents

Data Management Centre: governance control plane (Sense → Decide → Enforce → Evidence). Internal, single tenant, TypeScript, NestJS on Fastify, Postgres + pg-boss, on-prem Kubernetes. Replaces Collibra before the March 2028 licence renewal.

Read this file before every task. The task backlog is in `docs/implementation-plan.md` (task IDs F1, E1, M3 …). One task = one pull request. Done means merged with its done-criteria met; a human reviews every PR.

## Rules

1. **Read the docs first.** `/docs` holds the PRD, MVP system design, metamodel, access control, implementation plan and DESIGN.md. Put requirement IDs (CAT-5, PRV-4) in commit messages and test names.
2. **Module boundaries.** One NestJS module per bounded context under `/packages`. Modules talk only through `@dmc/contracts`. CI fails on any other cross-module import (`pnpm run boundaries`).
3. **One schema per module.** A module's DB role sees only its own schema. Migrations are expand-then-contract; never edit an applied migration.
4. **Contracts first.** Change OpenAPI or event schemas in `contracts`, regenerate clients, then implement. Never hand-write an API client.
5. **Metamodel is data.** Types live in `/metamodel/types/*.yaml`. Code reads the registry; it never hard-codes a type's attributes.
6. **Every write is evidenced.** Any state change writes an outbox row in the same transaction. No exceptions, including admin actions.
7. **Every write is authorised.** Use the shared authorization library (role, then CEL attribute rules). No endpoint without an authorization test.
8. **Metadata only.** Never read, store, log or return data values from source systems.
9. **Synced fields are read-only.** A write to a field owned by another tool becomes a task for that tool.
10. **Tests with every change.** Unit tests, contract tests for APIs, fixture tests for sync jobs, golden tests for policies. No merge without them.
11. **No new dependencies or infrastructure** without a short ADR in `/docs/adr`.
12. **Stop and ask** when docs conflict, a requirement is unclear, or a task needs access you do not have. Never choose between conflicting docs.
13. **Keep it splittable.** Develop in one repo, but deployables share code only through package imports (`@dmc/contracts`, `@dmc/platform`), never relative paths. The repo is split per component before UAT.
14. **UI follows DESIGN.md.** Use shadcn/ui (React Aria base) and the shared patterns; never build a one-off component when a pattern exists.
15. **Three environments:** local, UAT, prod. Promotion is by merge.

## Layout

```
packages/<module>   14 bounded-context modules (own schema each)
packages/contracts  OpenAPI, event schemas, generated types
packages/platform   authorization, outbox/inbox, metamodel loader, observability
packages/sdk        generated SDK (never hand-written)
apps/api|worker|connectors|web   deployables (packages named @dmc/app-*)
metamodel/types     type definitions (YAML)
scripts             CI helpers (boundary check, lint)
```

## Commands

`pnpm run ci` runs lint, typecheck, boundary check and tests. Run it before opening a PR.
