# DMC — Product Requirements Document

Nov 17, 2026

## Summary

DMC (Data Management Centre) is the enterprise's control plane for data governance: it senses what data exists and how it moves, decides what policy requires, enforces it automatically where it is safe to, and keeps tamper-evident proof of every step. It replaces Collibra as the system of record for governance metadata and workflows, and it is an internal build, single-tenant, on-prem.

**Problem.** Governance today is catalogue-plus-tickets: people document assets, raise requests and chase approvals by hand. Coverage stalls at the strategic platforms, while thousands of applications hold and move data before it reaches them. Evidence for auditors is assembled after the fact.

**DMC and Fabric.** Fabric is the single business-facing marketplace for data products from the strategic data platforms (fewer than 25, owned by business lines). DMC governs everything wider: the applications, pipelines and platforms upstream of Fabric, and the controls on data products themselves. Fabric reads trust, ownership, classification and lineage from DMC through its API; business users discover in Fabric, tech teams manage metadata in DMC.

|  | Fabric | DMC |
| --- | --- | --- |
| Primary users | Business consumers | Tech teams, stewards, control owners, auditors |
| Scope | Data products on strategic platforms | All data assets, apps, pipelines and controls |
| Job | Find, request and use data | Know, govern and prove control of data |
| Relationship | Consumes DMC's API | System of record for governance |

## Goals and success measures

DMC succeeds when most governance happens without a person in the loop, and every outcome can be proven.

**Goals**

1. Low human touch: the system proposes and acts; people author policy and handle exceptions.
2. Coverage beyond Fabric: governed metadata for applications and pipelines upstream of the strategic platforms.
3. Provable control: every decision and action is evidenced in an immutable ledger.
4. Retire Collibra before its March 2028 licence renewal: migrate its metadata and workflows (for example multi-step business term approval) into DMC.
5. Agent-operable: coding agents read and write DMC through the API under the same rules as people (MCP after the MVP).

**Non-goals**

- Data access control or brokering access to data (not at launch).
- A data product marketplace (that is Fabric).
- Multi-tenancy or commercial packaging.
- Replacing Jira or ServiceNow for non-data work.

**Success measures** (the applications row is a share of the whole estate of about 8,000; the other rows are measured against what has been taken on)

| Measure | 1 year | 3 years |
| --- | --- | --- |
| Applications taken on (owner confirmed, integrations and datasets linked), starting with those feeding BCBS 239 and PRA returns | 10% (about 800) | 60% |
| Priority returns with scopes submitted | Top 50 | Top 500 |
| Elements of submitted scopes with confirmed column links | 70% | 95% |
| Cross-border integrations of taken-on applications with a current assessment | 70% | 95% |
| Decisions made without a person (automation rate) | 30% | 60% |
| Exception age, median / p95 | 15 / 45 days | 7 / 30 days |
| Critical-scope assets at their required trust tier | 40% | 80% |
| Evidence checks passing | 100% | 100% |
| Collibra switched off | Before the March 2028 licence renewal |  |

## Users

Seven personas; the first three do most of the work, and none should spend their day in DMC.

| Persona | Who | Top jobs in DMC |
| --- | --- | --- |
| Application / platform owner | Tech lead for an app, pipeline or platform | Confirm proposed metadata; link tables and columns to business scope; fix breaches on their assets |
| Data steward | Domain steward or steward group | Resolve exceptions; approve terms and classifications; maintain domain glossary |
| Scope owner (e.g. regulatory report owner) | Owns a report or business process, e.g. PRA110 | Define scope (business elements, source to target apps, criticality); submit and lock; issue amendments as new versions |
| Policy author / control owner | Central governance, privacy, data quality, records | Turn operating instructions and technical control requirements into policies in the policy editor; run them in shadow, then enforce |
| Auditor / risk | Internal audit, 2nd line | Trace any decision to its evidence; verify ledger integrity; export proof |
| Platform admin | DMC operators | Metamodel changes, connectors, kill switches, health |
| Coding agent | Agent acting for a user or service account | Register datasets, declare lineage, propose metadata, check changes against policy |

Business consumers are served through Fabric; DMC gives them read-only discovery but does not design for them first.

## Scope

Launch covers five control types fed by configurable sync jobs; access control is deferred.

**In scope at launch**

| Control type | What DMC does |
| --- | --- |
| Classification and tagging | Detect sensitive and business classifications; propagate along lineage; confirm or route for review |
| Data quality | Read rules, business context and column-level results from DQ Hub (via BigQuery); flag breaches and assets below their required tier; track remediation. DQ Hub runs the checks |
| Retention and lifecycle | Read retention schedules, lifecycle state and legal holds from DSTORM and legal-hold tools; schedules apply through each dataset's Record Class; flag missing schedules and overdue disposal. DMC never deletes or quarantines |
| Privacy and consent | Read column-level PII and ISR classifications from the classification tool; detect cross-border transfers of classified data and flag those without a DataVisa. Consent is out of scope for the MVP |
| Lineage and impact | Column-to-column lineage; impact analysis; drives propagation |

Also in scope: catalog (search, object pages), business glossary and scopes, workflow engine for approvals migrated from Collibra, evidence ledger, public API and sync jobs.

**Sources at launch:** technical metadata kept as JSON in each application's Git repo; ServiceNow applications and integrations via BigQuery; dbt and Airflow for lineage; Collibra until cutover; DQ Hub and DSTORM results; PII and ISR classifications (API); DataVisa records; scopes from ARIS, RRIS and the BCBS inventory. All arrive through sync jobs configured per environment; DMC does not connect to databases directly.

**Regulations at launch:** BCBS 239, PRA and SOX.

**Out of scope:** access control; consent; direct database connections, SQL lineage parsing, MCP and write-back to source systems (all after the MVP); file shares and streaming sources; data fabric concerns; regulations beyond BCBS 239, PRA and SOX.

## Core concepts

DMC runs one loop for every control: Sense, Decide, Enforce, Evidence. People write policy and handle exceptions; everything else is automated.

[Diagram: The DMC loop · Sense, Decide, Enforce, Evidence]

- **Metamodel.** Types (system, table, column, concept, policy, scope) are data in a versioned registry; adding a type is configuration, not code. Every node and edge carries provenance, confidence and valid/recorded time.
- **Autonomy.** Each policy sets a ceiling and confidence thresholds; the effective level is the lower of the ceiling and what the confidence earns. Outcomes are act, act and notify, propose, or drop.
- **Reversibility.** DMC changes only its own records and raises tasks for owning systems, so every DMC action can be undone; changes to data happen in the owning tools.
- **Scope.** A regulatory report or business process groups business elements and the source to target apps that feed them; criticality flows from the scope to linked assets.
- **Propagation.** Classification and retention flow along column-level lineage when edge confidence clears the threshold; otherwise they become proposals.

## Functional requirements

Requirements are grouped by capability; IDs are stable for traceability.

**Sense — discovery and signals**

| ID | Requirement |
| --- | --- |
| SEN-1 | Sync jobs bring in technical metadata, reference data and lineage on schedule; each job's connection, GCP project, dataset, schedule and enabled flag are set per environment |
| SEN-2 | Every finding is emitted as a signal with source, confidence and provenance (sync job, propagation, declared) |
| SEN-3 | Classifiers use rules and patterns drafted and extended with LLM help (see POL-8); they read names, comments, metadata and lineage, not data values. PII and ISR classes come from the classification tool, which overrides DMC's own rules |
| SEN-4 | Quality rules, business context and column-level results come from DQ Hub via BigQuery; failures become breach signals. Retention schedules, lifecycle state and legal holds come from DSTORM and legal-hold tools |
| SEN-5 | Lineage merges orchestrator metadata (dbt, Airflow) and declared edges at column level; SQL parsing comes later, with confidence per edge |
| SEN-6 | Backpressure per source so one sync job cannot starve the platform; a run that would change more than its limit pauses for review |

**Decide — policy**

| ID | Requirement |
| --- | --- |
| POL-1 | Policy authors write policies in a DMC policy editor (structured form plus YAML/CEL view) with live validation and dry run; saving opens a pull request; the control owner signs it off in UAT and the DMC platform team merges it, which promotes it |
| POL-2 | Policies declare scope, condition, effect, autonomy ceiling, confidence thresholds, reversibility and exception route |
| POL-3 | Conflicting policies block activation, with the conflict explained |
| POL-4 | Dry-run over the real estate reports assets affected, actions that would fire and projected exceptions |
| POL-5 | Policies run in shadow mode (evaluate and report only, no exceptions or actions) before they are enforced; enforcement can be staged on a subset with auto-halt thresholds |
| POL-6 | Policies are versioned and diffable; every version used by a decision is recorded |
| POL-7 | Per-policy and global kill switch stops dispatch without losing queued decisions |
| POL-8 | When new signals appear that no rule covers (new patterns, recurring exceptions), coding agents (LLMs) draft new deterministic rules as files in the repo; drafts go through validation, conflict check, dry run and UAT sign-off by the control owner and merge by the DMC platform team, like any policy change |
| POL-9 | Each policy names the operating instruction or technical control requirement it implements, for example data movement: every integration is linked to at least one dataset |

**Enforce — actions**

| ID | Requirement |
| --- | --- |
| ENF-1 | Decisions resolve to act, act and notify, propose, or drop |
| ENF-2 | In the MVP, a change needed in a source system becomes a task for the app owner; write-back integrations (for example ServiceNow) come later |
| ENF-3 | Every DMC action keeps prior state for undo; DMC never deletes or quarantines data in source systems |
| ENF-4 | Rate limits and blast-radius caps per target and per policy; exceeding a cap pauses the policy |
| ENF-5 | Unacknowledged event actions escalate and show as pending enforcement |
| ENF-6 | DMC writes the intended change on the asset as pending and confirms it only when the next sync from the source shows it; sources sync at least daily, and a change still unconfirmed by the deadline its policy sets escalates |

**Workflow and exceptions**

| ID | Requirement |
| --- | --- |
| WF-1 | One inbox of decisions per person, each answerable in one action with context and a recommendation |
| WF-2 | Routes, SLAs and escalation are defined by policy |
| WF-3 | Multi-step approval workflows (for example business term creation) are configurable and replace Collibra workflows |
| WF-4 | Reviewer outcomes are recorded and reported per policy, to help tune policies |
| WF-5 | DMC owns all workflows for data controls; Jira and ServiceNow are not required for them |

**Catalog, glossary and scope**

| ID | Requirement |
| --- | --- |
| CAT-1 | Global search with facets is the front door; every object has one canonical page |
| CAT-2 | Asset lifecycle: discovered, proposed, confirmed, deprecated; no hard delete |
| CAT-3 | Metamodel types are data: added and changed through a registry with dry-run impact |
| CAT-4 | Business glossary of terms and classifications as concepts in a taxonomy |
| CAT-5 | Scopes (regulatory report, business process) hold groups of business elements, source to target apps and inherited criticality |
| CAT-6 | Submitting a scope, by its owner or a delegate, locks it with no separate approval; amendments follow the same path and create a new version |
| CAT-7 | Each app owner links their side of a scope to tables and columns |
| CAT-8 | Column-level lineage view and impact analysis from any asset or element |
| CAT-9 | Scopes and their owners come from ARIS (business processes), RRIS (regulatory returns) and the BCBS inventory (reports and report metrics) through sync jobs; DMC adds groups, elements and flows |
| CAT-10 | Scope owners delegate to named people for up to 12 months; delegates can prepare and submit; delegations expire, are ledgered and end when the owner changes |
| CAT-11 | A scope is complete when every business element has links confirmed by the app owners on its flows; overdue link tasks escalate |

**Evidence**

| ID | Requirement |
| --- | --- |
| EVI-1 | Every signal, policy version, decision, action, approval, metamodel change and agent call is captured in the same transaction as the change (through an outbox) and appended to the ledger's hash chain within 60 seconds |
| EVI-2 | The ledger is append-only, hash-chained, with the latest hash copied regularly to a separate audit database |
| EVI-3 | An independent verifier runs continuously; a failure freezes autonomous actions |
| EVI-4 | Auditors can trace any asset state back to its evidence and export proof |

**API and agents**

| ID | Requirement |
| --- | --- |
| API-1 | Versioned domain API, separate from the UI backend, is the only integration surface (including Fabric) |
| API-2 | After the MVP, an MCP server exposes search, read, generic metadata writes and governance intent tools over the API |
| API-3 | Agent writes are evaluated by policy like any other signal: low-risk or repeatable changes apply automatically, the rest go to review |
| API-4 | Every write supports dry run, idempotency keys and optimistic concurrency |
| API-5 | Agents act for a named user or service account with scoped permissions from the identity provider |

**Migration**

| ID | Requirement |
| --- | --- |
| MIG-1 | Bring Collibra assets, glossary, relations and ownership in through sync jobs until cutover, then stop the jobs |
| MIG-2 | Rebuild active Collibra workflows in DMC and run them in parallel until cutover |

**Privacy**

| ID | Requirement |
| --- | --- |
| PRV-1 | Column-level PII and ISR classifications come from the classification tool's API through a sync job and are authoritative |
| PRV-2 | Every application and system carries a hosting country, taken from ServiceNow |
| PRV-3 | Every integration has an Assessment, held in the DataVisa tool with its own id, that decides whether a DataVisa is required; a cross-border transfer is an integration between applications in different countries |
| PRV-4 | Where the integration's Assessment requires a DataVisa, each data category of its datasets must be covered by a valid DataVisa, synced from the DataVisa tool; a missing Assessment, or a missing or expired DataVisa, raises an exception to the data owner |
| PRV-5 | Auditors see every cross-border transfer by country pair with its DataVisa status and evidence |
| PRV-6 | Datasets are mastered in DMC by application owners: each integration's datasets with their data category, business context, record class and links to columns |

**Control requirements**

| ID | Requirement |
| --- | --- |
| CRQ-1 | Operating instructions and technical control requirements are registered in DMC with reference id, title, kind, owner, regulation, Confluence link and version |
| CRQ-2 | In the MVP they are entered through a form or CSV upload; a Confluence sync job can replace that later without changing the model |
| CRQ-3 | Each policy implements one or more requirements; a requirement can have many policies |
| CRQ-4 | A coverage view shows requirements with no policy, with shadow policies only, and with enforced policies |
| CRQ-5 | A new version of a requirement flags its policies for review |

## Key journeys

Five journeys define launch; each should take minutes of human time, not days.

1. **A new sensitive column appears.** A sync job brings it in, classifier proposes "personal data" at high confidence, policy allows auto-apply, classification propagates downstream along lineage, the app owner is notified, and every step lands in the ledger. No one opens DMC unless confidence is low.
2. **Regulatory report owner defines scope (PRA110).** Owner creates a scope, adds groups of business elements and source to target apps; criticality is inherited from the report. On submit the scope locks and each app owner gets one task to link their tables and columns. An amendment creates a new version.
3. **Steward clears the inbox.** Steward opens a short queue of exceptions, each with context and a recommended action, and approves, rejects or modifies in one action. Unanswered items escalate per policy.
4. **Policy author ships a retention rule.** Author writes it in the policy editor, sees validation errors, conflicts and a dry-run impact, saves it as a pull request, runs it in shadow after merge, then enforces it.
5. **Auditor proves a control.** Auditor picks an asset or report, sees its current state and the chain of signals, policy versions, decisions and approvals behind it, verifies integrity and exports proof.

Also required: a coding agent registers a new dataset and its lineage through the API with a dry run first; a business term goes through a multi-step approval migrated from Collibra.

## Experience requirements

One surface with search at the front and a single decisions inbox; no suite of modules.

| ID | Requirement |
| --- | --- |
| UX-1 | Global command bar reachable by keyboard from anywhere; landing view asks "What do you need?" |
| UX-2 | Catalog, policy, quality, lineage and evidence are views of the same objects, not separate apps |
| UX-3 | Every object page has the same anatomy: name, state, owner, relationships, activity |
| UX-4 | The system proposes defaults (owners, classifications, links, descriptions); people confirm |
| UX-5 | Tables and facets for lists; inline editing and side panels instead of stacked modals |
| UX-6 | Lineage and workflow canvases are focused tools with stable viewport and few edges until asked |
| UX-7 | Empty states say what the system is already doing |
| UX-8 | Token-based theming, light and dark, keyboard-first, WCAG 2.1 AA |
| UX-9 | Notifications: a daily digest per person by email or Teams (new tasks, due soon, overdue), with an immediate alert only for urgent items; each person can change frequency and channel |
| UX-10 | Management dashboard: applications taken on, scope completeness, coverage by business line, exception ageing, automation rate and trust tiers, against the success targets |
| UX-11 | CSV export from every table, respecting current filters and access rules |
| UX-12 | In-app help: empty states that explain what to do next, and a short help page per role linked from the user menu |

Visual direction: a corporate-site look, which overrides the calm visual language in the design principles. The interaction rules above still apply.

## Non-functional requirements

Targets marked (assumed) come from the system design and need confirming.

| Area | Requirement |
| --- | --- |
| Scale | Up to 10M assets, 1B column nodes, 3B lineage edges (assumed) |
| Throughput | 5k signals/s and 2k ledger entries/s at peak (assumed) |
| Latency | Signal to action p95 under 30 s on automated paths; UI reads p95 under 400 ms (assumed) |
| Availability and recovery | Catalog and ledger RPO 1 min, RTO 1 h (assumed) |
| Deployment | Greenfield on-prem Kubernetes; every dependency runs in-cluster; single tenant; scheduling through pg-boss, no Kubernetes CronJobs |
| Identity | Existing OIDC/SAML identity provider; DMC roles mapped from groups; agents via OAuth scopes |
| Security | mTLS between services, default-deny network, secrets in the org's existing store |
| Data minimisation | Metadata only in the MVP; DMC reads no data values |
| AI | Runtime decisions use deterministic rules only. LLMs write and propose new rules; they never decide or execute, and every call is recorded |
| Architecture | TypeScript across the stack (NestJS on the Fastify adapter, React single-page app); API separate from frontend; pg-boss for workflows; lineage in Postgres behind a store port, FalkorDB later; one package per bounded context, boundaries enforced in CI and the database |
| Observability | Traces across events; SLIs for decision lag, exception age, ledger lag, lineage freshness |
| Engineering | Built through agentic coding; contracts and typed clients generated, not hand-written |

## Dependencies and open questions

**Dependencies**

- Fabric API contract is agreed after the MVP; until then Fabric reads /api/v1 as built.
- Read access to the Git metadata repo, the BigQuery datasets in each GCP project, and Collibra until cutover.
- An inventory of live Collibra workflows.

**Decided**

| Topic | Decision |
| --- | --- |
| Regulations | BCBS 239, PRA and SOX to start |
| Rules and LLMs | Deterministic rules at runtime; LLMs write and propose new rules, never decide |
| Trust score | Tiers: Gold, Silver, Bronze, Unverified, each met by explicit criteria |
| Enforcement | MVP: a task for the app owner; write-back integrations such as ServiceNow come later; DMC marks the change pending and confirms it on the next sync |
| Workflow engine | pg-boss to start |
| Backend | NestJS on the Fastify adapter (recommended, to confirm) |
| Lineage store | Postgres behind a port for the MVP; FalkorDB later |
| Agent autonomy | Low-risk or repeatable changes auto-apply per policy; others proposed |
| Visual direction | Corporate-site look |
| Sync | Sources sync at least daily; unconfirmed changes escalate at the deadline set by their policy |
| LLM-drafted rules | Approved by the control owner or policy author |
| Sources | Sync jobs only: Git JSON metadata, ServiceNow via BigQuery, dbt, Airflow, Collibra until cutover; no direct database connections |
| Ledger | Hash chain in Postgres; latest hash copied to a separate audit database |
| MCP | After the MVP |
| Data quality | DQ Hub owns rules and checks; DMC reads rules, context and column-level results via BigQuery |
| Retention | DSTORM and legal-hold tools own it; DMC reads and flags, never deletes |
| Consent | Not in the MVP |
| Privacy | PII and ISR classifications from the classification tool; cross-border transfers checked for a DataVisa |
| Policy authoring | Policy editor in DMC; saving opens a pull request; control owner signs off in UAT; DMC platform team merges |
| Policy modes | Shadow (evaluate and report) or enforced; for example cross-border and required-tier checks start in shadow |
| Promotion | Through code merge, local → UAT → prod; UAT uses prod-like data a day to a week old |
| Audit database | Run by the same team, separate database; accepted |
| Backend | NestJS on Fastify (confirmed) |
| Fabric API contract | After the MVP |
| Control requirements | Framework in DMC; TCRs from Confluence entered by form or CSV, synced later |
| Collibra switch-off | Before the March 2028 licence renewal |

**Open questions**

- [ ] Review the access-control (RBAC/ABAC) draft.
- [ ] Register the TCRs from Confluence in the control requirement framework.

**Trust score options**

| Option | How it works | Strength | Weakness |
| --- | --- | --- | --- |
| A. Composite score | 0–100 from quality pass rate, lineage completeness, ownership and classification coverage, open breaches; weights set by policy | One number, easy for Fabric to show | Hides why; weights get argued |
| B. Tiers | Gold, Silver, Bronze, Unverified, each met by explicit criteria | Explainable and auditable; suits BCBS 239 | Coarse |
| C. Scorecard | Separate grade per dimension, no roll-up | Most transparent | No single answer for Fabric |
| D. Criticality-relative | Scored against what the asset's scope requires (e.g. PRA110 critical elements) | Fits regulatory focus | Needs scope links first |

Decided: B, tiers. The scope's criticality sets which tier an asset must reach.

**Tier criteria**

Each asset is graded per dimension, scorecard-style; its tier is its weakest dimension, so the reason for a tier is always visible.

| Dimension | Bronze | Silver | Gold |
| --- | --- | --- | --- |
| Ownership and metadata | Owner assigned | Plus steward, description and confirmed classification | Plus every column classified and linked to business terms |
| Quality | Rules defined on key columns | Pass rate ≥ 95% over 30 days | Pass rate ≥ 99% over 90 days; no open critical breach |
| Lineage | Table-level lineage to the source app | Column-level for critical elements | Column-level end to end, above confidence threshold, no gaps |
| Compliance | No overdue retention or privacy actions | No exceptions past their SLA | No open exceptions; every control evidenced in the ledger |
| Sync | Synced in the last 7 days | Synced daily | Synced daily with no pending changes |

An asset that misses Bronze on any dimension is Unverified.

**Required tier by criticality:** elements in BCBS 239 or PRA report scopes must be Gold; SOX-relevant assets Silver; everything else Bronze. The required-tier policy starts in shadow and is enforced scope by scope as owners catch up; once enforced, a shortfall raises an exception to the asset owner.
