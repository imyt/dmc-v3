# DMC — Implementation Plan (for coding agents)

Nov 17, 2026

## How this plan works

The whole MVP is built by coding agents, so this plan has no sprints or dates. It is a dependency graph: a task can start as soon as the tasks it depends on are merged, and independent tasks run in parallel on separate agents. What sets the pace is human input (access, sign-offs), not build time.

- **One task, one pull request.** Each task is small enough for one agent to finish, with its own tests.
- **Done means merged with its done-criteria met.** CI runs the tests, boundary checks and contract checks, and a person from the lean DMC platform team reviews every pull request before merge. Fully automated merges are a future state, not part of this plan.
- **Source of truth.** The PRD, MVP System Design, Metamodel and Access Control docs, copied into `/docs` in the repo. An agent that finds a conflict between docs stops and raises it rather than choosing.
- **Collibra first.** Tasks that replace Collibra (catalog, glossary, workflows, Collibra sync) come before new capabilities, because the licence ends in March 2028.
- **Human gates** are marked [H] and listed in Human inputs.

## Build order

Foundation, evidence and the catalog come first because everything writes through them. The Collibra path (sync, workflow, glossary) runs next, alongside scopes and policy; lineage, trust and privacy build on top.

[embedded content: Build order · 11 tracks and the Collibra switch-off]

Only the main dependencies are drawn; each task's own "Needs" column is the full list.

## Ground rules for agents

These become `CLAUDE.md` / `AGENTS.md` at the repo root. Every agent reads them before every task.

1. **Read the docs first.** `/docs` holds the PRD, design, metamodel and access control. Requirement IDs (CAT-5, PRV-4) go in commit messages and test names.
2. **Module boundaries.** One NestJS module per bounded context under `/packages`. Modules talk only through `/packages/contracts`. CI fails on any other cross-module import.
3. **One schema per module.** A module's DB role sees only its own schema. Migrations are expand-then-contract and never edit an applied migration.
4. **Contracts first.** Change the OpenAPI or event schema in `contracts`, regenerate clients, then implement. Never hand-write an API client.
5. **Metamodel is data.** Types live in `/metamodel/types/*.yaml`. Code reads the registry; it never hard-codes a type's attributes.
6. **Every write is evidenced.** Any state change writes an outbox row in the same transaction. No exceptions, including admin actions.
7. **Every write is authorised.** Use the shared authorization library (role, then CEL attribute rules). No endpoint without an authorization test.
8. **Metadata only.** Never read, store, log or return data values from source systems.
9. **Synced fields are read-only.** A write to a field owned by another tool becomes a task for that tool.
10. **Tests with every change.** Unit tests, plus contract tests for APIs, fixture tests for sync jobs and golden tests for policies. No merge without them.
11. **No new dependencies or infrastructure** without a short ADR in `/docs/adr`.
12. **Stop and ask** when docs conflict, a requirement is unclear, or a task needs access you do not have.
13. **Keep it splittable.** Develop in one repo locally, but deployables share code only through package imports (`@dmc/contracts`, `@dmc/platform`, `@dmc/core`), never relative paths. The repo is split per component before UAT.
14. **UI follows DESIGN.md.** Use shadcn/ui and the shared patterns; never build a one-off component when a pattern exists.
15. **Three environments:** local, UAT and prod. Promotion is by merge.

## Tasks

Twelve tracks, 66 tasks. "Needs" lists tasks that must be merged first; [H] marks a task that also needs human input.

**F — Foundation**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| F1 | Monorepo: workspaces, one package per module, `contracts`, `sdk`, `web`; CI with lint, typecheck, tests, boundary check | — | CI green; a cross-module import fails CI |
| F2 | Local stack and Helm: Postgres locally, a chart per deployable, local/UAT/prod overlays | F1 | All deployables run locally; charts render for three environments |
| F3 | Postgres base: migration runner, schema and role per module, pg-boss schema, outbox/inbox library | F1 | Test proves a module cannot read another module's schema |
| F4 | Auth: SSO login, token checks in gateway, group-to-role config, shared authorization library (roles + CEL rules) | F1 [H] | Requests without a role are denied; rule test helpers work |
| F5 | API conventions: OpenAPI in `contracts`, generated SDK, errors, pagination, `dry_run`, idempotency, `If-Match` | F1 | Web uses the generated SDK; contract-test template exists |
| F6 | Observability: traces across HTTP and pg-boss, metrics, structured logs | F1 | One trace spans api → queue → worker |
| F7 | shadcn/ui setup with DESIGN.md tokens; app shell in the corporate-site look | F1 [H] | Shell renders header, navigation, search; light and dark |
| F8 | Pattern library: build the common patterns in DESIGN.md, each with a gallery page, accessibility check and visual test | F7 | Every pattern renders in the gallery and passes its axe and visual tests |

**E — Evidence (early, because every write uses it)**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| E1 | Outbox relay and ledger writer: one consumer, batched inserts, hash chain, insert-only role | F3 | Any edited row is detected in tests; 2,000 entries/s in a load test |
| E2 | Copy the chain hash to the audit database every 5 s or 5,000 entries | E1 [H] | DMC's role cannot update or delete in the audit DB |
| E3 | Verifier on a pg-boss schedule; a divergence pauses automatic actions and alerts | E2 | Injected divergence pauses actions in a test |
| E4 | Evidence API: trace any object to its entries, export proof | E1, F5 | Proof export for an asset passes the verifier |

**M — Metamodel and catalog**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| M1 | Metamodel registry: load YAML types, JSON Schema check in CI, versions | F1 | All types load; an invalid file fails CI |
| M2 | Generate TypeScript types, API schemas and write validators from the metamodel | M1, F5 | Adding an attribute needs no hand-written code |
| M3 | Catalog store: bitemporal nodes and edges, lifecycle, provenance, identity by qualified name | M1, F3, E1 | Re-applying a record makes no duplicate; state at any past date is queryable |
| M4 | Catalog API: get, list by type, relationships, history | M3, F4 | Contract and authorization tests pass |
| M5 | Search: Postgres full text and facets behind a port | M3 | p95 under 400 ms on a 1M-node fixture |
| M6 | Metamodel change check on pull requests: block breaking changes, report affected objects | M1, M3 | A breaking change fails with counts |

**S — Connectors and sync jobs**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| S1 | Sync framework: connector interface, connections, job YAML with environment overlays, schedules, cursors, run history, change detection to signals, change-limit pause, deprecate only on complete full runs, retries | M3, F3 | Fixtures prove the pause and that a partial run deprecates nothing |
| S2 | Connector: BigQuery (project and dataset per job and environment) | S1 [H] | Reads a fixture dataset through a test project |
| S3 | Connector: Git, one repo per application, repos found from the application list | S1 [H] | Syncs fixture repos; a removed repo deprecates its assets |
| S4 | Connector: REST API (auth, paging) | S1 | Syncs a fixture API |
| S5 | Job: Collibra assets, glossary, relations, owners (until cutover) | S4 [H] | Reconciliation report matches Collibra counts |
| S6 | Jobs: ServiceNow applications (owner, two delegates, hosting country) and integrations | S2 [H] | Apps and integrations in the catalog with owners |
| S7 | Job: Git JSON technical metadata | S3, S6 | Systems, tables, columns linked to their application |
| S8 | Jobs: dbt and Airflow column lineage, job name on the edge | S1 [H] | Column edges created from fixture manifests |
| S9 | Jobs: DQ Hub rules and column results; DSTORM record classes, schedules, legal holds | S2 [H] | Results and schedules attached to the right objects |
| S10 | Jobs: classification tool (API) PII and ISR; DataVisa tool assessments and DataVisas | S2, S4 [H] | Classes on columns; assessments on integrations |
| S11 | Jobs: ARIS, RRIS, BCBS inventory scopes with owners | S1 [H] | Scopes and owners in the catalog |
| S12 | Sync admin screen: jobs per environment, runs, counts, errors, run now, pause | S1, U1 | Admin can pause and rerun a job |

**W — Workflow and exceptions**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| W1 | Workflow engine: versioned step graphs as data, instances, tasks, CEL branches, pg-boss timers and escalation | F3, E1 | Parallel and branch fixtures pass; retries never double-advance |
| W2 | Inbox: one queue per person, decide in one action, context and recommendation | W1, F4, U1 | Assignee decides; others are refused |
| W3 | Exceptions: raise, route by policy, SLA, escalate, resolve | W1 | Escalation fires on a fixture SLA |

**G — Glossary and Collibra workflows**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| G1 | Glossary: Business Terms, Data Categories, Data Domains; steward edits; source switch per type at cutover | M3, M4 | Steward edits own domain only; source flag switches cleanly |
| G2 | Business term approval workflow (replaces Collibra's) | G1, W1 [H] | Same steps and outcomes as Collibra on test cases |
| G3 | Remaining Collibra workflows, from an inventory | G2 [H] | Each has a passing parity test |

**C — Scopes, datasets and requirements**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| C1 | Scopes: versions, groups, elements, flows over integrations, lock on submit, amend to new version | M3, S11 | A locked scope is read-only; an amendment creates version 2 |
| C2 | Scope delegation: grant, revoke, 12-month limit, reminder, end on owner change | C1, F4 | An expired delegate is refused |
| C3 | App-owner link tasks: one per app on a scope's flows; confirm element-to-column links; completeness | C1, W1 | A scope shows complete when all links are confirmed |
| C4 | Datasets: per integration, data category, business context, record class, column links | M3, S6, G1 | Only the app owner or delegates can edit |
| C5 | Control requirements: form and CSV intake, Confluence link, version, coverage view | M3 | Coverage shows requirements with no, shadow-only and enforced policies |
| C6 | Scope, dataset and requirement screens | C1–C5, U1 | PRD journey 2 passes end to end |

**P — Policy**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| P1 | Policy YAML schema, CEL compile to IR, golden-test harness | M2 | Example policies compile; golden tests run in CI |
| P2 | Load merged policies per environment; shadow and enforced modes | P1, F2 | Shadow results are stored and raise no exceptions |
| P3 | Policy editor: form plus YAML/CEL view, validation, dry run, opens a pull request | P1, U1 [H] | Saving opens a PR with the dry-run report attached |
| P4 | Conflict check and dry-run report | P1, M3 | Contradicting fixture policies are blocked |
| P5 | First policies: integration has a dataset; application has an owner; scope elements linked; required trust tier (shadow, enforced scope by scope); cross-border (shadow) | P2 [H] | Signed off in UAT by the policy owner |

**D — Decisions and actions**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| D1 | Decision worker: signal to matching policies, autonomy, act / notify / propose / drop | P2, W3, E1 | Each outcome covered by a test; every step evidenced |
| D2 | Actions: DMC-side changes with undo, tasks to owning tools, kill switches | D1 | Undo restores prior state; kill switch stops dispatch |
| D3 | Pending changes confirmed on sync, else escalated at the deadline their policy sets | D2, S1 | Fixture covers confirm and escalate |
| D4 | API writes from people, scripts and agents become signals | D1, M4 | An agent write follows the same policy path |

**L — Lineage, trust and privacy**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| L1 | Lineage store behind a port, capped traversal, impact API | M3, S8 | Impact query p95 under 2 s at depth 10 on a fixture |
| L2 | Propagate classifications along lineage as proposals | L1, D1 | Tool-classified columns are never overridden |
| L3 | Trust tiers: five dimension grades, tier is the lowest, required tier from scope | C1, S9, L1 | Fixture assets get the expected tiers and exceptions |
| L4 | Cross-border checks: countries, assessment, DataVisa match by category | C4, S6, S10, D1 | Missing assessment and missing DataVisa both raise exceptions |
| L5 | Lineage canvas | L1, U1 | Focused canvas with stable viewport and expand on demand |

**U — Shared UI**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| U1 | Global search and an object page template driven by the metamodel (name, state, owner, relationships, activity) | F7, F8, M4, M5 | Any type renders without type-specific code |
| U2 | Admin screens: metamodel version, kill switches | U1 | Admin can pause a policy |
| U3 | Auditor views: trace and export | E4, U1 | PRD journey 5 passes end to end |
| U4 | Notifications: daily digest by email or Teams, urgent alerts, per-person preferences | W2 [H] | A fixture user gets one digest listing new, due and overdue items |
| U5 | Management dashboard against the success targets | U1, C3, W3, L3 | Every PRD success measure shows with its target |
| U6 | CSV export in the data table pattern | F8 | Export matches the filtered view and hides what the user cannot see |
| U7 | In-app help: guided empty states and one help page per role | U1 | Each role's first screen links to its help page |

**R — Repositories (local monorepo, split before UAT)**

| ID | Task | Needs | Done when |
| --- | --- | --- | --- |
| R1 | Keep the monorepo splittable: shared code only through package names (`@dmc/contracts`, `@dmc/platform`, `@dmc/core`); each shared package builds and publishes | F1 | CI fails on a relative import across deployables; packages publish to a local registry |
| R2 | Split into one repo per component with history; versioned packages; a CI/CD pipeline and Helm chart per repo | R1 and the tasks needed for UAT [H] | Each repo builds and deploys to UAT from its own pipeline |
| R3 | Config repos for metamodel, policies and sync jobs, with pull-request checks that post DMC's dry-run report | R2, M6, P4 | A pull request in each repo gets its report |

## Human inputs

These are what actually set the pace. Starting them now lets agents work without waiting.

| Input | Unblocks | Who |
| --- | --- | --- |
| Kubernetes namespaces (dev, test, prod), Postgres, and a separate audit database | F2, F3, E2 | Platform team |
| SSO client registration; later, IdP groups for roles | F4 | Identity team |
| Brand tokens for the corporate-site look (colours, type, logo) | F7 | Design / brand |
| GCP projects, datasets and service accounts for ServiceNow, DQ Hub, DSTORM and DataVisa data in BigQuery | S2, S6, S9, S10 | Data platform team |
| Read access to application Git repos, and the repo naming convention | S3, S7 | Engineering |
| Collibra API access and an inventory of live workflows with their steps | S5, G2, G3 | Collibra admin |
| dbt and Airflow manifest locations | S8 | Data engineering |
| Classification tool API access | S10 | Privacy / security |
| Access method for ARIS, RRIS and the BCBS inventory | S11 | Owning teams |
| A Git service account for the policy editor to open pull requests | P3 | Engineering |
| UAT sign-off of the first policies by their owners | P5 | Control owners |
| TCRs exported from Confluence as CSV | C5 | Control owners |
| Internal package registry, the component repos, and a CI/CD pipeline per repo to UAT and prod | R2 | Platform team |
| Email relay and a Teams channel or bot for notifications | U4 | Collaboration / messaging team |

## Testing and verification

Agents write the code, so tests are the main control on quality. CI blocks a merge unless all of these pass.

| Kind | What it proves | Where |
| --- | --- | --- |
| Unit | Logic in each module | Every package |
| Boundary | No cross-module imports; each DB role sees one schema | CI, every PR |
| Contract | API and event shapes match `contracts`; generated SDK compiles | `contracts`, `gateway` |
| Authorization | Every endpoint denies without the right role and attribute rule | Every module with endpoints |
| Sync fixtures | Each job maps, diffs, pauses and deprecates correctly on recorded source data | `connectors` |
| Policy golden tests | Each policy gives the expected outcome on fixture assets, in shadow and enforced | Policy repo |
| Evidence | Chain integrity, audit copy, verifier catches tampering | `evidence` |
| Journeys | PRD journeys 1 to 5 run end to end against test data | UAT |
| Load | 2,000 ledger entries/s; search and impact p95 targets | Before prod |

UAT uses prod-like data a day to a week old. A separate review agent, which has not seen the change being made, reviews every pull request against the docs and the ground rules before a human approves the merge.

## Collibra parallel run and switch-off

Collibra must be off before the March 2028 licence renewal. Because the build is agent-paced, the deadline is mostly about the parallel run and people moving their work.

1. **Mirror.** S5 syncs Collibra into DMC daily. Collibra stays the source of truth for glossary and domains.
2. **Reconcile.** A daily report compares counts and attributes per type; differences go to the platform admin until they reach zero.
3. **Parallel workflows.** G2 and G3 run in DMC for real requests while Collibra still runs them. Outcomes are compared.
4. **Switch source of truth.** Per type (terms, categories, domains), flip the source flag to DMC (G1). Collibra becomes read-only for that type.
5. **Stop the sync.** When every type is switched, S5 is disabled and Collibra is archived for audit.
6. **Licence ends** with at least three months of margin before March 2028.

Agents can finish the build well ahead of this; plan the people side (stewards and workflow users moving to DMC) from the start.
