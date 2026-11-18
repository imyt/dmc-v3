# DMC — MVP System Design

Nov 17, 2026

## What changed for the MVP

The MVP runs on Postgres alone, plus a separate audit database and the org's existing secret store. Kafka, OpenSearch, a graph database, Temporal and model hosting all move behind ports and arrive later, when measured load calls for them.

| PRD decision | Design consequence |
| --- | --- |
| Deterministic rules at runtime; LLMs only draft rules | No inference service in the MVP. Coding agents write rules as files in the repo, so DMC hosts no model |
| pg-boss for workflows | pg-boss (on Postgres) carries the event loop, approvals, timers and escalations; no Kafka or Temporal |
| Postgres first, FalkorDB later | Lineage lives in Postgres behind a `LineageStore` port; FalkorDB is an adapter added when traversal latency is measured too slow |
| NestJS on Fastify | One NestJS module per bounded context; modules deploy together in a few processes, split later without code changes |
| Enforcement per source; confirm on sync | A `pending_change` record per action; the next sync confirms it; the policy's deadline decides when it escalates |
| Trust tiers | A derived grade per asset, recomputed when any of its five dimensions changes |
| BCBS 239, PRA, SOX | Scopes carry a regulation and criticality; required tier and ledger retention follow from them |
| Corporate-site look | Design tokens only; no impact on the backend |

**Still as in the v4 design:** Sense, Decide, Enforce, Evidence loop; metamodel as data; transactional outbox; append-only, hash-chained ledger; API separate from the frontend.

## MVP architecture

Four deployables share one Postgres cluster, which holds every module's schema, the pg-boss queues and the ledger.

[embedded content: MVP architecture · 4 deployables, 2 stores]

The web app and integrations never touch storage: they go through `api`. The worker does all asynchronous work, and the connectors deployable runs every sync job that reaches outside DMC, on its own node pool.

## Modules

Thirteen NestJS modules, one package and one Postgres schema each, packed into four TypeScript deployables. Moving a module to its own deployable is a Helm change, not a code change.

| Module | Owns (schema) | MVP responsibilities | Runs in |
| --- | --- | --- | --- |
| gateway | sessions | OIDC/SAML login, role checks, `/ui/*` screen-shaped responses, `/api/v1/*` routing | api |
| catalog | `catalog` | Metamodel registry, nodes and edges, search (Postgres full text), object pages | api |
| scope | `scope` | Regulatory report and process scopes, groups, elements, versions, app-owner links | api |
| policy | `policy` | Control requirements, policy editor and repo sync, compile to IR, validate, conflict check, dry run, shadow and enforced modes | api |
| workflow | `workflow` | Exception inbox, multi-step approvals (Collibra replacements), SLAs, escalation | api + worker |
| trust | `trust` | Five-dimension grades and tier per asset; required tier check | worker |
| connectors | `connectors` | Connector types, connections, sync job definitions per environment, run history (see Connectors and sync jobs) | connectors |
| ingest | `ingest` | Normalise sync output into signals; diff against catalog | connectors |
| classify / quality | `detect` | Run classification rules; turn DQ Hub and DSTORM results into signals | worker |
| lineage | `lineage` | Merge orchestrator (dbt, Airflow) and declared edges; SQL parsing later; propagation | worker |
| decision | `decision` | Evaluate signals against active policy; resolve autonomy; route | worker |
| actions | `actions` | Execute via adapters, pending changes, confirm on sync, undo journal, kill switch | worker |
| evidence | `evidence` | Ledger writer, hash copies to the audit database, verifier | worker |
| privacy | `privacy` | Cross-border transfer checks; Assessment and DataVisa matching | worker |

**Deployables:** `web` (React single-page app with Vite, TanStack Router and TanStack Query; no server framework, since the API is separate), `api`, `worker` (pg-boss consumers and all scheduled work, scaled on queue depth) and `connectors` (every sync job that reaches outside DMC, on its own node pool). All TypeScript; no Python and no MCP in the MVP.

**Repositories.** Development starts in one monorepo for speed. Before the first UAT deployment it is split into one repo per component: `dmc-web`, `dmc-api`, `dmc-worker`, `dmc-connectors`, plus shared packages `dmc-contracts` (OpenAPI, events, generated SDK), `dmc-platform` (authorization, outbox, metamodel loader) and `dmc-core` (domain modules used by both api and worker), and config repos `dmc-metamodel`, `dmc-policies` and `dmc-sync-jobs`. Shared code is published as versioned packages to the internal registry; deployables depend only on those packages, never on each other's source. Environments are local, UAT and prod.

**Boundary rules:** modules talk only through `contracts` (typed commands, queries, events) and never read another schema; each module's DB role is granted its own schema only. In-process calls today become HTTP or queue calls when a module is split out.

## Data model

Assets are generic nodes and edges typed by the registry; governance objects and control records are nodes too. Module tables hold only working state: policy IR, workflow instances, transfer checks, signals, decisions and the ledger. All node and edge tables are bitemporal (`valid_from`, `valid_to`, `recorded_at`).

| Schema | Table | Key columns |
| --- | --- | --- |
| catalog | `type_def` | `name`, `version`, `parent`, `attributes` (JSON Schema), `allowed_edges`, `propagation`, `lifecycle` |
| catalog | `node` | `id`, `type`, `qualified_name` (unique per source), `attrs` (jsonb), `state` (discovered, proposed, confirmed, deprecated), `source_id`, `provenance`, `confidence`, `version` |
| catalog | `edge` | `id`, `type`, `from_id`, `to_id`, `attrs`, `provenance`, `confidence`, `state` |
| catalog | `search_doc` | `node_id`, `tsv` (tsvector), facet columns (type, domain, system, classification, tier) |
| scope | `scope`, `scope_version` | `kind` (regulatory report, process), `regulation`, `criticality`, `status` (draft, submitted, amended), `locked_at` |
| scope | `scope_element`, `scope_app`, `scope_link` | element in a group; source-to-target app; app owner's link from element to table or column |
| policy | `policy`, `policy_version` | `control_type`, `dsl`, `ir` (jsonb), `scope_key`, `autonomy_ceiling`, `thresholds`, `reversibility`, `route`, `state` (draft, simulated, staged, active, paused, retired) |
| detect | `rule`, `rule_run` | deterministic classification rules (quality rules stay in DQ Hub); `origin` (authored, llm_drafted), `approved_by` |
| decision | `signal`, `decision` | signal `kind`, `subject_id`, `payload`, `confidence`; decision `outcome` (act, act_notify, propose, drop), `policy_version_id`, `inputs_hash` |
| actions | `action`, `pending_change`, `undo_journal` | target, adapter, `idempotency_key`, `status`; pending change `expected_state`, `due_by` (from the policy's deadline), `confirmed_at`, `escalated_at` |
| workflow | `workflow_def`, `workflow_instance`, `task` | step graph; current step; assignee, `due_at`, decision |
| trust | `grade` | `node_id`, five dimension grades, `tier`, `required_tier`, `computed_at`, `inputs_hash` |
| evidence | `ledger_entry`, `checkpoint` | `seq`, `kind`, `subject_ref`, `actor`, `payload_hash`, `prev_hash`; checkpoint `chain_hash`, `audit_copy_id`, `seq_range` |
| every schema | `outbox`, `inbox` | events to publish; processed event ids for idempotency |
| privacy | dataset, assessment, transfer, datavisa | source and target app, countries, data categories, datavisa id, status (covered, missing, expired), checked_at |

**Lineage at MVP scale:** column edges stay in `catalog.edge` with indexes on `(from_id, type)` and `(to_id, type)`; traversal uses recursive CTEs with depth and fan-out caps. The `LineageStore` port hides this so FalkorDB can replace it.

**Partitioning:** `signal`, `decision`, `action` and `ledger_entry` are partitioned by month; `node` and `edge` by hash of `source_id` once a table passes about 100M rows.

## Core flows

Every hop is a pg-boss job created in the same transaction as the state change that caused it, so nothing is lost and nothing double-fires.

**Queues:** `sync.run`, `signal.new`, `decision.made`, `action.dispatch`, `sync.confirm`, `lineage.propagate`, `trust.recompute`, `workflow.step`, `workflow.timer`, `ledger.append`. Jobs for one asset use a singleton key on `asset_id`, so evaluation per asset is ordered.

**1. The loop**

1. `connectors` runs each sync job on its schedule (daily minimum), diffs against the catalog and writes signals plus `signal.new` jobs.
2. `decision` loads the active policies indexed by the asset's scope keys, evaluates the IR, and resolves autonomy: the lower of the policy ceiling and the tier its thresholds allow.
3. Outcome `act` or `act_notify` creates `action.dispatch`; `propose` creates a workflow task on the policy's route; `drop` is recorded only.
4. Each step writes an outbox row in the same transaction as its change; the ledger writer appends it to the hash chain within 60 seconds.

**2. Pending change, confirmed on sync**

1. `actions` writes the change on the DMC asset with `state = pending` and a `pending_change` row holding the expected source state.
2. The adapter applies it: in the MVP, a task to the app owner to make the change; write-back adapters (for example ServiceNow) come later.
3. The next sync of that source compares observed state with `expected_state`. A match sets `confirmed_at` and the asset change becomes current.
4. No match by `due_by` (the deadline set by the policy) escalates to the asset owner, and the asset shows "pending enforcement". The DMC value is never silently overwritten or dropped.

**3. Workflow capability**

A generic engine comes first; specific Collibra workflows are built on it later.

- Definitions are data: a versioned step graph (sequential, parallel, and conditional branches using CEL), assignee rules, allowed decisions and SLAs. Running instances stay on the version they started with.
- State lives in `workflow_instance` and `task`. Each decision advances the instance in one transaction and enqueues `workflow.step`; handlers are idempotent, so retries are safe.
- SLA reminders and escalations are scheduled pg-boss jobs, not polling.
- Any worker can run any step; jobs for one instance share a singleton key, so steps never race.
- One engine serves exceptions, approvals, scope submission and rule approval.

**4. Rule drafting with an LLM, outside DMC**

1. DMC lists gaps at `/api/v1/gaps`: signals no policy matched, recurring exceptions, reviewer overrides.
2. A coding agent writes a deterministic policy as a YAML file and opens a pull request.
3. CI validates it and DMC attaches a dry-run report to the pull request.
4. The control owner signs it off in UAT and the DMC platform team merges it; merge promotes it, and it starts in shadow mode.

## Policy language and runtime

Policies are YAML validated by a JSON Schema, with conditions written in CEL (Common Expression Language). Both are deterministic, easy for agents to write, and have mature TypeScript implementations.

```yaml
policy: integration-has-dataset
control: data-movement
implements: <technical-control-requirement-id>
mode: enforced            # or shadow: evaluate and report only
scope:
  type: Integration
when: size(integration.datasets) == 0
effect:
  action: raise_exception
  message: Link at least one dataset to this integration
route: application-owner
escalate_after: 10d
```

**Authoring.** Policy authors use the policy editor in DMC: a structured form for scope, condition, effect and mode, with the YAML/CEL view alongside, live validation and a dry run against current data. Saving opens a pull request in the policy repo; the control owner signs it off in UAT, and the DMC platform team reviews and merges it, which promotes it. Coding agents can open the same pull requests.

**Shadow and enforced.** A shadow policy is evaluated on every signal and its results are stored and reported to the policy author and auditors, but it raises no exceptions and dispatches no actions. New policies, and checks not yet backed by an instruction such as cross-border transfers, start in shadow.

**Control requirements.** Each policy names the operating instruction or technical control requirement it implements (`implements`), so audit can trace a requirement to its policies and evidence.

**Requirement intake.** In the MVP, requirements are entered in DMC through a form or a CSV upload, each with its Confluence link and version. A `confluence` connector type can later sync them through the same job framework without changing the model. A coverage view lists requirements with no policy, with shadow policies only, and with enforced policies; a new requirement version flags its policies for review.

**Compile.** The YAML is parsed, checked against the schema and the metamodel (types, attributes and concepts must exist), and compiled to an IR: `scope_keys`, compiled CEL program, effect, autonomy, route. The same IR runs for live evaluation, dry run and staged rollout.

**Evaluate.** Active policies are indexed by scope key (type, concept, domain, scope). A signal loads only the policies whose keys match the asset, typically fewer than 20.

**Autonomy.** `effective = min(ceiling, level allowed by confidence)`. Deterministic rules emit confidence 1.0 unless the rule declares otherwise, so for most rules the ceiling decides. Irreversible effects cannot exceed `propose` without a named approver.

**Conflicts.** Two policies conflict when their scope keys can overlap (checked against the concept hierarchy) and their effects contradict, for example retain 7 years versus delete at 90 days. A sampled check against real assets removes overlaps that cannot occur. A conflict blocks staging.

**Activation path:** draft (pull request), validated, dry-run report, merged, shadow, enforced (optionally staged on a subset with an auto-halt threshold). Every transition is a ledger entry.

## Detection, trust and connectors

**Detection rules** are policies whose effect is to classify; they live in the policy repo and follow the same pull-request path.

| Rule kind | Inputs | Example |
| --- | --- | --- |
| Name pattern | Table and column names, comments (Git JSON) | Column name matches `(nat|national)_?id` |
| Metadata | Data types, tags and descriptions in the Git JSON | String column tagged `customer` with a description mentioning date of birth |
| Lineage | Upstream classification above threshold | Derived from a column classified as personal data |
| Quality | DQ Hub rules and column-level results (BigQuery) | Column fails a critical DQ Hub rule |
| Retention | DSTORM schedules, lifecycle state, legal holds | Trade-record table with no retention schedule |
| Cross-border | Hosting countries, integrations, datasets, Assessments, DataVisa records | Cross-border integration whose Assessment requires a DataVisa, with none valid |

DMC runs no quality checks itself. DQ Hub owns quality rules, business context and results, and DMC reads them column by column from BigQuery. Retention schedules, lifecycle state and legal holds come the same way from DSTORM and the legal-hold tools. DMC compares them with policy and the required tier and raises exceptions; it does not delete or quarantine data.

**Privacy and cross-border transfers.** PII and ISR classifications arrive per column from the classification tool and override DMC's own classification rules. A transfer check then runs whenever an integration, dataset, Assessment, hosting country or DataVisa changes:

1. For each integration between applications in different hosting countries, check it has a current Assessment (from the DataVisa tool).
2. If the Assessment requires a DataVisa, collect the data categories of the integration's datasets and upsert a `transfer` record.
3. Match each category to a valid DataVisa for that source and target: covered, missing or expired.
4. A missing Assessment, or a missing or expired DataVisa, becomes a signal; policy routes it to the data owner, and the result is ledgered.

**Trust tiers.** `trust` subscribes to changes in owner, classification, quality results, lineage, exceptions and sync status, and recomputes only the affected asset. Each of the five dimensions gets Bronze, Silver, Gold or none from the agreed criteria; the tier is the lowest. If the tier is below the required tier from its scope (Gold for BCBS 239 and PRA, Silver for SOX), an exception goes to the asset owner. The required-tier policy starts in shadow and is enforced scope by scope. Fabric reads tier and dimension grades from `/api/v1/assets/{id}/trust`.

**Connectors at MVP**

| Source | How | Brings |
| --- | --- | --- |
| Git repos (JSON), one per application | Sync job | Technical metadata already kept as JSON: systems, schemas, tables, columns |
| ServiceNow via BigQuery | Sync job | Applications (with hosting country) and integrations, daily |
| dbt, Airflow | Sync job reading manifests and DAGs | Column-to-column lineage; the job name is kept on the edge |
| Declared lineage | API | App owners and coding agents declare edges; SQL parsing comes later |
| Collibra | Sync job until cutover | Assets, glossary, relations, owners; the jobs stop after cutover |
| DQ Hub via BigQuery | Sync job | Quality rules, business context and column-level results |
| DSTORM and legal-hold tools | Sync job | Retention schedules, lifecycle state, legal holds |
| PII and ISR classification tool | Sync job | Column-level PII and ISR classifications, read through its API |
| DataVisa records | Sync job from the DataVisa tool | Assessments (with their own ids) and DataVisas; BigQuery now, API later |
| ARIS, RRIS, BCBS inventory | Sync jobs (access method to confirm) | Scopes with owners: business processes (ARIS), regulatory returns (RRIS), reports and report metrics (BCBS inventory) |

DMC does not connect to databases directly in the MVP.

Enforcement adapters (after the MVP) add `apply()`, `undo()` and `observe()`. Credentials are references to the org's existing secret store; read and write credentials are separate.

## Connectors and sync jobs

A `sync` module brings reference and technical metadata into DMC on a schedule, running in the connectors deployable. Its first jobs load applications and integrations mastered in ServiceNow, which lands them in BigQuery; DMC reads them daily. Technical metadata kept as JSON in each application's Git repo is another sync job; it finds the repos from the application list. Further APIs and datasets are added as configuration, not code.

**Three concepts**

| Concept | What it is | Example |
| --- | --- | --- |
| Connector type | Code: how to talk to a kind of system. Implements `test()`, `read(query, cursor)` and optionally `observe()` | `bigquery`, `git`, `rest-api`, `file` |
| Connection | Config: one instance of a connector type in one environment, with a secret reference | `snow-bq` credentials for one GCP project in one environment |
| Job | Config: what to read, how to map it to the metamodel, when to run | `snow-applications`, `snow-integrations` |

**Job definition** (YAML in the repo, written by coding agents):

```yaml
job: snow-applications
connection: snow-bq
schedule: "0 3 * * *"        # daily 03:00
source:
  query: SELECT * FROM `${project}.${dataset}.cmdb_ci_business_app`
  mode: incremental
  cursor: sys_updated_on
target:
  type: Application
  key: sys_id
  map:
    name: name
    owner: owned_by.email
    criticality: business_criticality
    status: install_status
  on_missing: deprecate        # records gone from source are deprecated, never deleted
limits:
  max_changes_pct: 10          # pause and raise an exception if more than 10% would change
```

**Environment overlay** (one file per environment):

```yaml
# environments/prod.yaml
connections:
  snow-bq:  { project: <snow-prod-project>,  secret: <secret-ref> }
  integ-bq: { project: <integ-prod-project>, secret: <secret-ref> }
jobs:
  snow-applications:  { connection: snow-bq,  dataset: <cmdb-dataset>, enabled: true }
  snow-integrations:  { connection: integ-bq, dataset: <integrations-dataset>, enabled: true }
```

**Per environment.** The overlay sets, per job, the connection, GCP project, dataset, schedule and `enabled` flag. One job can read a different project and dataset in each environment, and different jobs can read different projects in the same environment. A connection holds the credentials for one GCP project. Overlays are promoted local → UAT → prod like code.

**UAT reads** prod-like sources that lag production by a day to a week, depending on the source, so policies and jobs are tested against realistic data before merge to prod.

**How a run works**

1. pg-boss starts `sync.run` on the job's schedule (or on demand from the admin screen).
2. The connector reads in pages from the last cursor; each record is mapped and hashed.
3. Records whose hash changed become signals with `source = <job>`, so policy decides what auto-applies (for example owner and status updates) and what goes to review.
4. Records missing from a full run are deprecated. A run that would change more than its limit pauses and raises an exception instead.
5. The run is recorded with counts, duration and errors. A job with no successful run in 24 hours lowers the sync dimension of affected assets and alerts the platform admin.
6. Sync runs also confirm pending changes for the assets they cover.

**Admin screen:** jobs per environment, last run, next run, counts, errors, run now, pause. Editing a job happens in the repo, not the screen.

**New tables:** `sync.connection` (`name`, `type`, `environment`, `config`, `secret_ref`), `sync.job` (`name`, `version`, `definition`, `environment`, `enabled`), `sync.run` (`job`, `started_at`, `finished_at`, `status`, `read`, `changed`, `deprecated`, `errors`), `sync.cursor` (`job`, `value`).

## Evidence and API

**Evidence ledger**

- Writer: a single `ledger.append` consumer assigns `seq` and inserts into `evidence.ledger_entry` in batches; only its DB role may INSERT, and no role may UPDATE or DELETE.
- Each entry stores `hash = H(prev_hash ‖ payload_hash ‖ seq)`. Every 5 seconds or 5,000 entries the latest chain hash is copied to a separate audit Postgres database run by the same team but separate from DMC's database, where DMC's application role can only insert, so any later edit to the ledger no longer matches the copy.
- The verifier runs as a scheduled pg-boss job in the worker: recent partitions every 10 minutes, the full chain nightly. A divergence pages the on-call and pauses all automatic actions.
- Retention follows the strictest regulation on the subject (BCBS 239, PRA, SOX); checkpoints are never deleted.

**API surfaces**

| Surface | For | Notes |
| --- | --- | --- |
| `/ui/*` | DMC web app | Screen-shaped responses; not versioned; not for integrations |
| `/api/v1/*` | Fabric, scripts | OpenAPI first; generated TypeScript SDK; cursor pagination; `dry_run`, `Idempotency-Key` and `If-Match` on every write |

Every write through `/api/v1`, from people, scripts or coding agents, becomes a signal and goes through policy like a sync record. MCP comes after the MVP. Every rule is enforced behind `/api/v1/*`, so an MCP server can later be a thin adapter over it with no other changes.

## Deployment, security and operations

**Kubernetes footprint (MVP)**

| Component | Shape |
| --- | --- |
| Postgres | The org's Postgres platform or CloudNativePG; 1 primary + 2 replicas, point-in-time recovery; pg-boss in its own schema |
| Audit database | A small separate Postgres database run by the same team, separate from DMC's database; DMC's role may only insert ledger hash copies |
| Secret store | The org's existing store, for connector credentials |
| `api` | 2+ replicas; scale on request rate |
| `worker` | Scale on pg-boss queue depth; separate pools per queue group if one starves another |
| `connectors` | Own node pool and quotas so sync jobs cannot starve the decision path |
| Verifier | A pg-boss schedule in the worker; no Kubernetes CronJobs |

**Security:** OIDC/SAML from the existing IdP; DMC roles (policy author, control owner, steward, scope owner, app owner, auditor, admin) from IdP groups; JWT checked in the gateway and re-checked in each module. mTLS between services, default-deny NetworkPolicies, one DB role per module. DMC reads metadata only; no data values are stored or returned.

**Operations:** OpenTelemetry traces carried through pg-boss job data; Prometheus metrics. SLIs: signal-to-decision lag, decision-to-action lag, pending changes past `due_by`, exception age, ledger anchor lag, verifier status, sync freshness per source.

**When to add the deferred pieces**

| Add | Trigger |
| --- | --- |
| Kafka | pg-boss sustained above about 2,000 jobs/s, or queue lag over SLO after tuning |
| OpenSearch | Search p95 above 400 ms on the full estate |
| FalkorDB | Impact traversal p95 above 2 s at depth 10 |
| Separate deployables | A module needs its own scaling or release cadence |

## Decisions

| Topic | Decision |
| --- | --- |
| Sources | Whatever the org already runs; connectors wrap existing capabilities |
| Frontend | React single-page app (Vite, TanStack Router and Query) |
| Policy language | YAML + JSON Schema + CEL, written by coding agents |
| SQL lineage parsing | Not in the MVP; lineage from dbt, Airflow and declared edges |
| Ledger | Hash chain in Postgres; latest hash copied to a separate audit database (same team, separate database) |
| Workflows | Generic, scalable engine first |
| ServiceNow | Read via BigQuery daily in the MVP; write-back after the MVP |
| MCP | After the MVP |
| Scheduling | pg-boss schedules only; no Kubernetes CronJobs |
| Data quality | DQ Hub owns rules and checks; DMC reads rules, context and column-level results via BigQuery |
| Retention | DSTORM and legal-hold tools own it; DMC reads and flags, never deletes |
| Consent | Not in the MVP |
| Privacy | PII and ISR classifications from the classification tool; cross-border transfers checked for a DataVisa |
| Policy authoring | Policy editor in DMC; saving opens a pull request; control owner signs off in UAT; DMC platform team merges |
| Policy modes | Shadow or enforced; classification rules are policies too |
| Promotion | Through code merge, local → UAT → prod; UAT uses prod-like data a day to a week old |
| Ledger timing | Outbox row in the same transaction; appended to the hash chain within 60 seconds |
| Backend | NestJS on Fastify (confirmed) |
| Fabric API contract | After the MVP |
| Access control | Roles from IdP groups plus CEL attribute rules from the catalog; see the access-control doc |

- [ ] Review the access-control (RBAC/ABAC) draft.
- [ ] Register the TCRs from Confluence.
