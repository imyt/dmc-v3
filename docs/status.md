# DMC: status against the implementation plan

As of 2026-11-18 (updated after the review fixes, the web fixes, S12 and the Policies and Evidence screens). Task IDs and "done when" criteria are in [implementation-plan.md](./implementation-plan.md); this page only reports. It is based on the code, tests, ADRs and `sync/jobs` in the repo, not on merged-PR history (the repo is not under version control here). "Built" means the code and its tests exist. Last full `pnpm run ci` (run by the agent that added the policy endpoints): passed, with 62 root test files (591 tests, 1 skipped) and 11 web test files (188 tests). Screens were checked in a real browser by the agents that built them, against the seeded local database; they were not re-checked by a person.

Status words: **built** (done criteria covered by tests in the repo), **built on fixtures** (works against recorded or invented source data; the real source is not connected), **partly built**, **blocked on <who>**, **not started**.

## Summary

- Everything that does not depend on a real source system or corporate service is built: foundation, evidence, metamodel, catalog, workflow, policy, decisions, actions, scopes, datasets, requirements, trust, privacy, lineage, the shared UI, and the glossary cutover switch.
- The sync jobs (S5 to S11) are built against fixtures. No real source is connected: every one waits on a team's access or schema (see Human inputs). The UAT and prod overlays (`sync/overlays/uat.yaml`, `prod.yaml`) exist with REPLACE_ME placeholders and every job off.
- Not started: G2, G3, R2, R3. Not built: the Teams and digest parts of U4, a real Git connector (S3).
- Web: the "Coming soon" stubs are gone. Scopes, Dashboard, Home, object pages, lineage, datasets, Policies, Evidence and the new Sync admin screen render against the seeded data. Known weak spots: the Policies editor flow has three flaws (see P3); the seeded policies reference requirement ids TCR-0001 to 0005 while the registered requirements are DM-1 and DM-2, so coverage shows four unknown references; the Controls tab on object pages is empty because no API feeds it; the dashboard shows only the one-year targets.
- A review of the sync code (ADR 0027) found six defects, all fixed: a source that clears a value now clears it in the catalog, the incremental cursor holds past rows that failed to map, refused records no longer trip the change limit, owner transfers apply in one run, departed people no longer block email lookups, and a type switched to DMC can no longer be deprecated by its old source.

## Tasks

**F: Foundation**

| ID | Status |
| --- | --- |
| F1 | built. pnpm workspaces, one package per module, `pnpm run ci`, `.github/workflows/ci.yml`, boundary check (`tests/boundaries.test.mjs`). |
| F2 | built for local (`docker-compose.yml`, a chart per deployable in `deploy/charts`, values for local, uat, prod in `deploy/env`). Charts not rendered or deployed here. UAT and prod blocked on the platform team (namespaces, Postgres, audit database). |
| F3 | built. Migration runner, schema and role per module, pg-boss, outbox/inbox; isolation tested (`tests/db.test.mjs`). |
| F4 | partly built. Authorization library (roles plus CEL rules, `config/authz.yaml`, ADR 0014) and sign-in by signed session cookie (ADR 0020) are built. Real corporate SSO wiring and IdP group names: blocked on the identity team. |
| F5 | built. OpenAPI in `contracts`, generated SDK (`sdk:check` in CI), conventions, contract-test template (`tests/contract`). |
| F6 | built (`tests/observability.test.ts`). |
| F7 | built. Shell, tokens, light and dark. Brand fonts and logo are placeholders (Arial, text wordmark): blocked on design / brand (ADR 0011). |
| F8 | built. Patterns, gallery, unit and axe checks. Playwright visual tests exist but are not part of `pnpm run ci` (ADR 0022). |

**E: Evidence**

| ID | Status |
| --- | --- |
| E1 | built (`tests/evidence.test.ts`). `pnpm run perf` (separate from CI): about 31,000 to 35,000 entries/s through `appendBatch` and about 15,800 entries/s through the outbox relay, against the 2,000/s target. Measured once, on a developer laptop with one client; not measured on UAT hardware. |
| E2 | built (`tests/audit-anchor.test.ts`). Needs the real separate audit database for UAT and prod: blocked on the platform team. |
| E3 | built (`tests/ledger-verifier.test.ts`, `tests/worker.test.ts`). The verifier fails closed: if the audit database cannot be reached, anchors cannot be checked, so automatic actions pause and platform-governance is notified. The pause is released only by a person. |
| E4 | built (ADR 0017, `tests/evidence-proof.test.ts`). |

**M: Metamodel and catalog**

| ID | Status |
| --- | --- |
| M1, M2 | built (`tests/metamodel*.test.ts`, `metamodel:check`, generated types and schemas). |
| M3 | built (`tests/catalog.test.ts`). Backdated corrections are refused (ADR 0006). A same-millisecond duplicate-key flake in repeated writes to one node was fixed in `packages/catalog/src/store.ts` (see Notes). |
| M4 | built (`tests/api-catalog.test.ts`). |
| M5 | built. `pnpm run perf`: p95 129 ms on 1M nodes against the 400 ms target (one run, developer laptop). |
| M6 | built (`scripts/metamodel-diff.ts`, `tests/metamodel-diff.test.ts`). |

**S: Connectors and sync jobs**

| ID | Status |
| --- | --- |
| S1 | built (ADR 0013, ADR 0024, `tests/sync*.test.ts`). |
| S2 | built on a fixture client (`@google-cloud/bigquery` loaded lazily, ADR 0025). Blocked on the data platform team: GCP project, dataset, service account. |
| S3 | not built as a real Git connector. S7 reads recorded checkouts through the manifest connector. Blocked on engineering (read access, repo naming convention, approval). |
| S4 | built (`tests/rest-connector.test.ts`). |
| S5 | built on fixtures: seven `collibra-*` jobs and the reconciliation function (`sync/collibra-reconciliation.yaml`, tested in `tests/collibra-sync.test.ts`; not scheduled as a daily report). Blocked on the Collibra admin: API access, type, relation and role ids (role names are assumptions), owner key field. |
| S6 | built on fixtures. Five `servicenow-*-bq` jobs with an invented BigQuery schema, plus a REST stand-in job used locally. Blocked on the data platform team (real tables) and the ServiceNow owner (which user field lands in `owned_by`). |
| S7 | built on fixtures (recorded checkouts, `tests/sync-git.test.ts`). Blocked on engineering (S3). |
| S8 | built on fixtures (`tests/sync-lineage.test.ts`). Blocked on data engineering for the real dbt and Airflow artifact locations. |
| S9 | built on fixtures with an invented DQ Hub and DSTORM schema (`tests/sync-dq-retention.test.ts`). Blocked on the data platform team. |
| S10 | built on fixtures with invented source shapes (`tests/sync-privacy.test.ts`). Blocked on privacy / security (classification tool API) and the DataVisa team. |
| S11 | built on the mock source server (`tests/scope-sources.test.ts`). Access method for ARIS, RRIS and BCBS unknown: blocked on the owning teams. |
| S12 | built (`tests/sync-admin.test.ts`, `apps/web/src/features/sync`). Seven `/v1/sync` endpoints (list jobs, runs, one run, pause and resume, run now, approve a held run), admin only, evidenced, no secrets in responses; screen at `/admin/sync`. Gaps: no "next run" column (needs a cron parser, rule 11), no discard button, refused counts are read from the run note, approve is not one transaction, a run left "running" by a crashed worker is not detected. Seen in a browser: job list, run list and run panel, pause and resume. Not seen in a browser: a held run and its approval. |
| (extra) | `idp-people` (Person nodes keyed by staff ID, ADR 0026) is built on an invented fixture. Blocked on the identity team. |

**W: Workflow and exceptions**

| ID | Status |
| --- | --- |
| W1 | built (`tests/workflow.test.ts`, `workflow-pgboss.test.ts`). |
| W2 | built (`tests/inbox.test.ts`, inbox screen). |
| W3 | built (exceptions with SLA and escalation, `tests/exceptions.test.ts`). |

**G: Glossary and Collibra workflows**

| ID | Status |
| --- | --- |
| G1 | built (ADR 0018, `config/source-of-truth.yaml`, all three types still `collibra`). |
| G2 | not started. No business term approval definition in `workflows/` (only `scope-links.yaml`). Needs the Collibra workflow inventory from the Collibra admin. |
| G3 | not started. Blocked on G2 and the inventory. |

**C: Scopes, datasets and requirements**

| ID | Status |
| --- | --- |
| C1 | built (`tests/scopes.test.ts`). |
| C2 | built (delegations, `tests/scopes.test.ts`). |
| C3 | built (`tests/scope-links.test.ts`, `workflows/scope-links.yaml`). |
| C4 | built (`tests/datasets.test.ts`). |
| C5 | built (form and CSV intake, coverage; the Confluence link is a stored field, no Confluence sync). CSV export from Confluence: blocked on control owners. |
| C6 | built (screens, `tests/journeys.test.ts` journey 2). |

**P: Policy**

| ID | Status |
| --- | --- |
| P1 | built (`tests/policy.test.ts`, `policies:check`). |
| P2 | built (shadow and enforced, per-environment overlay, `tests/policy-load.test.ts`). |
| P3 | built, with known flaws. Server side (check, dry run, conflicts, propose as a file by `FileChangeRequests`), `GET /v1/policies` and `GET /v1/policies/{id}` (`tests/policy-read.test.ts`, read by policy author, control owner, auditor and admin through the new `read_policy` action), and the Policies screen (all policies with mode and paused state, real YAML and golden cases, validation, dry run, open pull request, read-only for readers). Admin is read-only on policy writes, as `docs/access-control.md` says. Flaws found, not fixed: a control owner is denied writes because the controller passes no facts to the `control_ownership` rule although the screen treats them as writers; a proposal for an existing policy is written to `policies/<id>.yaml` instead of replacing the file in `policies/examples/`, so it would add a duplicate id; `propose` ignores the `checksum` the detail endpoint returns. A real Git service account to open pull requests: blocked on engineering. |
| P4 | built (`tests/policy-conflicts.test.ts`). |
| P5 | partly built. Examples exist for owner, dataset, trust tier, cross-border, classification and critical-app review; no "scope elements linked" policy found. UAT sign-off blocked on control owners. UAT overlay only sets `application-has-owner` to shadow. |

**D: Decisions and actions**

| ID | Status |
| --- | --- |
| D1 | built (ADR 0009, `tests/decision.test.ts`). |
| D2 | built (ADR 0010, `tests/actions.test.ts`). |
| D3 | built (ADR 0013, confirm on sync or escalate). |
| D4 | built (ADR 0016, `apply_change`). |

**L: Lineage, trust and privacy**

| ID | Status |
| --- | --- |
| L1 | built. `tests/lineage.test.ts`; `pnpm run perf`: impact queries at depth 10 p95 1,272 ms against the 2,000 ms target, with every query at the 20,000-node cap (thinnest margin, about 1.6 times). One run, developer laptop. |
| L2 | built (`packages/lineage/src/propagate.ts`, journey 1). |
| L3 | built (`tests/trust-privacy-lineage.test.ts`). |
| L4 | built (`packages/privacy/src/transfers.ts`); real data depends on S6 and S10 sources. |
| L5 | built (ADR 0022; table view in unit tests, canvas visual test outside CI). Fixed after a browser walk: edges were drawn backwards and the first view was clipped. |

**U: Shared UI**

| ID | Status |
| --- | --- |
| U1 | built (search and metamodel-driven object page). Fixed after a browser walk: Column and Person pages crashed on synced fields with no provenance; relationships now show the other end's name and type. A visible "Owner has left" badge shows beside an owner, delegate or steward whose Person is deprecated (the owner chose a visible flag instead of an exception for now). The Controls tab is empty because no API feeds it. |
| U2 | built (kill switch and per-policy pause; the metamodel version shows on the admin page). |
| U3 | built. `/evidence` is the one auditor screen (verify the ledger, trace with paging, export and check a proof bundle); `/audit` redirects to it; the stub Catalog route now redirects to Search. The proof check runs in the browser (a port of `verifyProof`); a server verify endpoint would be cleaner. |
| U4 | partly built. Email for new tasks, escalations, exceptions and due dates (ADR 0023, `tests/notifications.test.ts`). No daily digest, no urgent-alert tier, no Teams, no per-person preferences. Blocked on the messaging team for the email relay and a Teams channel. |
| U5 | built. All nine PRD success measures show with their one-year targets and proper units; ageing measures are lower-is-better. The three-year targets are not shown (the API returns only one target). |
| U6 | built (export in the data table pattern). |
| U7 | built (help route). |

**R: Repositories**

| ID | Status |
| --- | --- |
| R1 | partly built. The boundary check is in CI and also rejects absolute-path imports (`tests/boundaries.test.mjs`); it scans `packages/*` and `apps/*`, not the repo-level `tests/`. The plan names `@dmc/core`, which does not exist (only `contracts` and `platform`). Publishing shared packages to a local registry, a per-package build and publish pipeline, and a check that installs the published packages are not done (need the platform team's registry). |
| R2 | not started. Blocked on the platform team (registry, component repos, pipelines). |
| R3 | not started. Blocked on R2. |

## Open human inputs

| Input | Task | Who |
| --- | --- | --- |
| Namespaces, Postgres, separate audit database | F2, E2 | Platform team |
| SSO client, IdP group names; IdP people API (endpoint, auth, fields) | F4, `idp-people` | Identity team |
| Brand fonts, logo, tokens | F7 | Design / brand |
| GCP project, datasets, service account, workload identity or key; real table and column names for ServiceNow, DQ Hub, DSTORM, DataVisa | S2, S6, S9, S10 | Data platform team |
| Which ServiceNow user field is `owned_by` (staff ID, user name, email) | S6 | ServiceNow owner |
| Git read access, repo naming, approval of the Git connector; a service account for policy pull requests | S3, S7, P3 | Engineering |
| Collibra API access, ids of types, relations and roles (Owner, Steward names), whether `userName` is the staff ID, workflow inventory | S5, G2, G3 | Collibra admin |
| dbt and Airflow artifact locations | S8 | Data engineering |
| Classification tool API | S10 | Privacy / security |
| DataVisa tables, and how a current assessment is decided | S10 | DataVisa team |
| Access method for ARIS, RRIS, BCBS | S11 | Owning teams |
| UAT sign-off of the first policies | P5 | Control owners |
| TCRs as CSV | C5 | Control owners |
| Package registry, component repos, pipelines | R1, R2 | Platform team |
| Email relay and a Teams channel | U4 | Collaboration / messaging team |
| Confirmation of new dependencies (ADR 0019 `ajv-formats`, 0021 `esbuild`, 0022 `@xyflow/react` and `elkjs`, 0023 `nodemailer`; 0025 `@google-cloud/bigquery` is confirmed) | rule 11 | Owner |

## Open design decisions

- Collibra owner and steward key: `ownerKeyField` and `personKeyField` are `emailAddress` until the Collibra admin confirms `userName` holds the staff ID (ADR 0026, `collibra-owners`).
- ServiceNow application delegates are a string list of staff IDs and are not resolved to Person nodes (ADR 0026, `servicenow-applications*`).
- Persons are not yet required to carry `staff_id`; other person-typed attributes (assignees, delegation owner and delegate) are not pattern-checked because they may be routes or groups (ADR 0026).
- `subjectRef` for synced records is `<Type>:<key>`; decision and catalog fixtures used `node/<id>`; the final convention is open (ADR 0013).
- Backdated corrections (`valid_from` before the current version) are refused until a connector needs them (ADR 0006).
- Monthly partitioning of the ledger is deferred until about 50M rows (ADR 0005).
- Agent writes are asynchronous (202, read back later); there is no synchronous apply (ADR 0016).
- Collibra role and relation names ("Owner", "Steward", "is part of", "is grouped by") and the asset list shape are assumptions (`sync/jobs/collibra-*.yaml`).
- The Git, classification tool, DataVisa, DQ Hub, DSTORM, ServiceNow BigQuery and IdP source shapes in the job YAMLs are invented and change with the real ones.
- Last Collibra cutover: all seven `collibra-*` jobs are disabled in the overlays in the same change as the last type switch (ADR 0018).
- One ServiceNow writer per environment: UAT and prod are meant to run the `*-bq` jobs and not the REST stand-in; both overlays keep everything off until values are supplied. The worker refuses to load two enabled jobs that write the same ServiceNow data.
- A departed (deprecated) owner shows a visible flag in the web app and raises no exception; scope owner checks do not treat a deprecated Person as unknown. Revisit if an exception is wanted (owner decision, 2026-11-18).
- The web app recognises a person by an 8-digit staff ID that resolves to a Person; the API does not say which attributes refer to people, and Application `delegates` is a plain string list with no `identifies: Person` in the metamodel.
- The Policies screen does not use the `PolicyEditor` pattern (P15), whose per-asset rows do not match the real check report; it is composed from the data table, form, dialog and tab patterns plus a plain text source editor (no editor library, rule 11).
- Sync behaviour decided in the review (ADR 0027): a NULL or blank value from a source clears the attribute; the first run after the change counts those records as updated and may need one approval against the change limit.
- Open review findings not fixed: job installs and connection changes write no ledger entry (rule 6); a job file removed from `sync/jobs` keeps its installed row and schedule; the BigQuery table check can be bypassed with a comma join; the DQ Hub result jobs have no change limit; an incremental `>` watermark can skip rows with equal timestamps; dbt and Airflow can write the same lineage edge; a dropped worker database connection is not reconnected.

## Notes

- UAT and prod sync overlays: every connection and job is listed with REPLACE_ME values and `enabled: false`; the worker refuses to enable a job that still has a placeholder (`tests/sync-overlays.test.ts`).
- The local database needs `pnpm run migrate` after code changes that add migrations. A missing migration shows as a bare 500 on the page that reads the new table (seen on `/admin`, fixed by migrating). The API in `pnpm run api` does not reload on code changes.
- Test runs: embedded Postgres is now stopped cleanly and its temp folders removed (`tests/support/windows-ebusy.ts`), and `tests/ports.test.ts` fails if two test files use the same port.
- Fixed on 2026-11-18: a rare duplicate `node_version_pkey` when one node was written twice within the same millisecond (the seed does this for scopes). A change is now recorded at least 1 ms after the version it replaces; test in `tests/seed.test.ts`.
