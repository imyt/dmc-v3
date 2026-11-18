# DMC — Metamodel

Nov 17, 2026

## Principles

The metamodel says which kinds of things DMC knows about, how they relate, and which system is the source of truth for each fact. Most facts arrive through sync jobs; DMC itself is the source of truth only for scopes, governance and what it derives.

- **Types are data.** Entity and relationship types are YAML in the repo, versioned and promoted like code. Adding a type is configuration, not a migration.
- **Everything is a node or an edge.** Both carry attributes, provenance and a lifecycle state.
- **One source of truth per attribute.** Each attribute names the system that owns it. Synced attributes are read-only in DMC; a change goes back to the owning tool as a task.
- **Taxonomies are concepts.** PII classes, ISR classes, business terms, domains and regulations are all subtypes of one `Concept` type, arranged in hierarchies.
- **Bitemporal.** Every node and edge has valid time and recorded time, so any past decision can be replayed against what DMC knew then.
- **High-volume facts are not nodes.** DQ results, signals, decisions and ledger entries live in their own tables and point at nodes.

**Decisions on the draft's open questions**

| Question | Decision |
| --- | --- |
| Single or multiple inheritance | Single inheritance; shared behaviour comes from concepts and relationships, not extra parents |
| Who edits the metamodel | Coding agents change the YAML in the repo; a platform admin approves. Business users never edit types |
| Do policies reference types or capabilities | Both: by type (`Table`) or by concept (`classified_as: PII`), so "anything holding PII" works without listing types |
| DCAM support | Removed (decided earlier) |

## At a glance

Columns sit at the centre: business elements and terms point down to them, and classifications, DQ rules and lineage attach to them. Cross-border checks work one level up, on integrations between applications.

[embedded content: Metamodel at a glance · main types and relationships]

System contains Table contains Column; lineage runs column to column.

## Entity types

Every type has one of five parents. The parent decides what a type can do: which edges it can take, whether policies can govern it, and whether it can be assigned to other types.

| Parent | What it is | Can be governed by policy | Types |
| --- | --- | --- | --- |
| Asset | Something that holds, moves or serves data | Yes | Application, Integration, System, Schema, Table, Column, Dataset, Data Product |
| Concept | A label with a meaning, attached to assets; arranged in hierarchies | No (policies target assets *through* concepts) | Classification (PII, ISR, business), Business Term, Data Category, Data Domain, Record Class, Regulation |
| Control Record | A record from a control tool, or derived by DMC, that says how an asset is controlled | No (it is evidence about an asset) | DQ Rule, Retention Schedule, Legal Hold, Assessment, DataVisa, Cross-border Transfer |
| Governance Object | Something authored in DMC to direct or track governance | Scopes yes; others no | Scope, Scope Group, Business Element, Delegation, Control Requirement, Policy, Exception |
| Party | Someone who owns, stewards or approves | No | Person, Group |

**Asset**

| Type | Key attributes | Source of truth |
| --- | --- | --- |
| Application | ServiceNow sys_id, name, owner, delegates, criticality, status, hosting country | ServiceNow via BigQuery |
| Integration | ServiceNow id, mechanism, frequency, status | ServiceNow via BigQuery |
| System | name, platform (for example BigQuery, Oracle), environment | Git JSON metadata |
| Schema | name | Git JSON metadata |
| Table | name, kind (table, view, file), description, tags; derived by DMC: trust tier, required tier, trust shortfall | Git JSON metadata, plus DMC-derived trust fields |
| Column | name, data type, nullable, description, tags; derived by DMC: trust tier, required tier, trust shortfall, proposed classification and where from; DMC (stewards): rejected classifications | Git JSON metadata, plus DMC-derived fields |
| Data Product | name, Fabric id, owner | Not in the MVP (reserved for Fabric) |
| Dataset | name, description, data category, business context (who uses it), record class | DMC (application owners) |

Pipeline and Job are not in the MVP. Lineage is column to column; where a source names the transforming job, it is kept as an attribute on the edge.

**Concept**

| Type | Key attributes | Source of truth |
| --- | --- | --- |
| Classification | code, name, scheme (PII, ISR, business), level | Classification tool (PII, ISR); DMC (business) |
| Business Term | name, definition, status, steward | Collibra until cutover, then DMC |
| Data Category | name, definition, owner | Collibra until cutover, then DMC (to confirm) |
| Data Domain | name, description, owner | Collibra until cutover, then DMC |
| Regulation | code (BCBS 239, PRA, SOX), name | DMC |
| Record Class | code, name, description | DSTORM |

Business Terms group into Data Categories, and Data Categories into Data Domains, through `part_of`.

**Control Record**

| Type | Key attributes | Source of truth |
| --- | --- | --- |
| DQ Rule | DQ Hub id, name, dimension, business context, criticality | DQ Hub |
| Retention Schedule | DSTORM id, record class, period, trigger event, disposal action | DSTORM |
| Legal Hold | id, reason, start, end | Legal-hold tools |
| DataVisa | id, source country, target country, data categories, valid from, valid to, status | DataVisa tool |
| Cross-border Transfer | from country, to country, data categories, status (covered, missing, expired), problem, uncovered categories, detail | Derived by DMC |
| Assessment | assessment id, integration, outcome (DataVisa required or not), assessed on, review due | DataVisa tool (BigQuery now, API later) |

**Governance Object**

| Type | Key attributes | Source of truth |
| --- | --- | --- |
| Scope | name, owner, kind (regulatory return, report, report metric, business process), regulation, criticality, required trust tier (chosen by the owner), version, status (draft, submitted, amended), locked_at | Scope list and owner: ARIS (business processes), RRIS (regulatory returns), BCBS inventory (reports, report metrics), via sync jobs; groups, elements and flows: DMC |
| Scope Group | name, order | DMC |
| Business Element | name, definition, criticality | DMC (scope owners) |
| Policy | control type, mode (shadow, enforced), implements, version, state | DMC policy editor, stored in the policy repo |
| Exception | kind, severity, status, due, assignee | DMC |
| Control Requirement | reference id, title, kind (operating instruction, technical control requirement), owner, regulation, Confluence link, version | Entered in DMC (form or CSV); synced from Confluence later |
| Delegation | owner, delegate, covers (one scope or all), valid from, valid to, reason | DMC (scope owners); application delegates stay in ServiceNow |

**Party**

| Type | Key attributes | Source of truth |
| --- | --- | --- |
| Person | staff ID (the key: 8 digits, text, ADR 0026), email, name, department | IdP (ServiceNow supplies owner links only) |
| Group | name, IdP group | IdP |

**Not nodes (own tables, pointing at nodes):** DQ results per column per run (DQ Hub), trust grades, signals, decisions, actions, pending changes, workflow tasks, ledger entries, sync runs.

## Relationship types

Edges carry their own provenance and confidence. Derived edges are recomputed by DMC and never edited by hand.

| Relationship | From → To | Cardinality | Source |
| --- | --- | --- | --- |
| `contains` | System → Schema → Table → Column | 1 : many | Git JSON |
| `owns` | Application → System | 1 : many | ServiceNow or Git JSON |
| `source_of` / `target_of` | Application → Integration | many : many | ServiceNow |
| `transfers` | Integration → Dataset | 1 : many | DMC (application owners) |
| `in_category` | Dataset → Data Category | many : many | DMC (application owners) |
| `realised_by` | Dataset → Column | many : many | Application owner, in DMC |
| `derives_from` | Column → Column | many : many | dbt, Airflow, declared (job name as an attribute) |
| `classified_as` | Table or Column → Classification | many : many | Classification tool, DMC rules, lineage propagation |
| `represents` | Column → Business Term | many : 1 | Collibra until cutover, then DMC |
| `part_of` | Business Term → Data Category → Data Domain | many : 1 | Collibra until cutover, then DMC |
| `in_domain` | any asset → Data Domain | many : 1 | Collibra until cutover, then DMC |
| `owned_by` / `stewarded_by` | any asset → Person or Group | many : 1 | Owning source, else DMC |
| `includes` | Scope → Scope Group → Business Element | 1 : many | DMC |
| `flows_through` | Scope → Integration (source to target flows) | many : many | DMC |
| `implemented_by` | Business Element → Column or Table | many : many | DMC (app owners link their side) |
| `subject_to` | Scope → Regulation | many : many | DMC |
| `checked_by` | Table or Column → DQ Rule | many : many | DQ Hub |
| `retained_under` | Record Class → Retention Schedule | many : 1 | DSTORM |
| `held_by` | Table → Legal Hold | many : many | Legal-hold tools |
| `over` | Cross-border Transfer → Integration | many : 1 | Derived |
| `covered_by` | Cross-border Transfer → DataVisa | many : 1 | Derived (match) |
| `governed_by` | any asset → Policy | many : many | Derived from policy scope |
| `raised_on` | Exception → any node | many : 1 | DMC |
| `is_a` | Concept → Concept | many : 1 | Owning source |
| `recorded_as` | Dataset → Record Class | many : 1 | DMC (application owners) |
| `relates_to` | Record Class → Data Category (loose link) | many : many | DSTORM or DMC (to confirm) |
| `assessed_by` | Integration → Assessment | 1 : many (latest is current) | DataVisa tool |
| `implements` | Policy → Control Requirement | many : many | DMC (policy repo) |
| `delegates` | Delegation → Person (delegate) and → Scope (covered) | many : 1, many : many | DMC |

**Inherited attributes.** Some attributes flow along edges instead of being stored twice: a System's hosting country comes from its owning Application; a Column's criticality comes from the highest-criticality Scope it implements; required trust tier is the highest tier any submitted Scope using it asks for; each scope owner chooses theirs (Bronze, Silver or Gold; Bronze if not chosen).

## Classifications and taxonomy

All taxonomies are subtypes of `Concept`, linked by `is_a`. Policies can target any level, so a rule on a parent class applies to every child.

| Concept subtype | Scheme | Who defines the values | Notes |
| --- | --- | --- | --- |
| Classification | PII | Classification tool | Codes and hierarchy synced as-is; DMC defines no PII classes of its own |
| Classification | ISR | Classification tool | Same as PII |
| Classification | Business (for example trade record) | DMC, via repo | Used by policies such as retention; assigned by DMC rules |
| Business Term | Glossary | Collibra until cutover, then DMC | Each term is `part_of` one Data Category |
| Data Category | Glossary grouping | Collibra until cutover, then DMC | Groups Business Terms; datasets and DataVisas use it |
| Data Domain | Ownership | Collibra until cutover, then DMC | Groups Data Categories |
| Regulation | Regulatory | DMC | BCBS 239, PRA, SOX |
| Record Class | Records management | DSTORM | Each Record Class has a Retention Schedule; loosely linked to Data Categories |

**How a column gets its PII or ISR class**

1. The classification tool's value always wins and is stored with `source = classification-tool`.
2. If the tool has not classified a column, lineage propagation may propose one from upstream; policy decides whether it applies or goes to review.
3. When the tool later classifies the column, its value replaces any proposed one.

**DataVisa matching.** Every integration has an Assessment that decides whether a DataVisa is required. Where the integration connects applications in different countries and its Assessment requires a DataVisa, each data category of its datasets must appear on a valid DataVisa for that source and target. DataVisas use the glossary's Data Categories. A cross-border integration with no current Assessment raises an exception.

## Identity, provenance and lifecycle

**Identity.** Every node has an internal UUID and a `qualified_name` that is stable across syncs and unique per type. Sync jobs match on it, so re-running a job never creates duplicates.

| Type | Qualified name |
| --- | --- |
| Application, Integration | ServiceNow id |
| System, Schema, Table, Column | `system/schema/table/column` as written in the Git JSON |
| DQ Rule, Retention Schedule, Legal Hold, Assessment, DataVisa | The owning tool's id |
| Concepts | `scheme:code` (for example `pii:<code>`) |
| Scope, Business Element, Dataset, Control Requirement, Policy, Exception | DMC-generated slug |

**Provenance.** Each attribute value and edge records `source` (sync job, rule, person, propagation), `source_ref` (run id or rule version), `confidence` (1.0 for authoritative sources) and `recorded_at`.

**Source precedence.** The type definition names one source of truth per attribute. A value from that source always wins. Other sources can only propose, through the normal signal and policy path. A person editing a synced attribute in DMC creates a task for the owning tool instead of changing the value.

**Lifecycle.** All nodes and edges share four states: discovered (seen by a sync, not yet governed), proposed (suggested by a rule or person), confirmed (accepted by its source of truth or by policy), and deprecated (gone from the source, or retired). Nothing is hard-deleted; deprecated items keep their history and evidence.

**Scope versions.** A submitted Scope is locked. An amendment creates a new Scope version that copies its groups, elements and links; the previous version stays readable for audit.

## Type definition format

Each type is one YAML file in `metamodel/types/`, validated by a JSON Schema in CI. From these files DMC generates the API schemas, the TypeScript types and the attribute checks on write.

```yaml
type: Application
version: 3
parent: Asset
identity:
  qualified_name: servicenow.sys_id
attributes:
  name:            { type: string,  required: true,  source: servicenow }
  owner:           { type: person,  required: true,  source: servicenow }
  criticality:     { type: enum, values: [low, medium, high, critical], source: servicenow }
  status:          { type: enum, values: [planned, live, retiring, retired], source: servicenow }
  hosting_country: { type: country, required: true, source: servicenow }
  description:     { type: text,    source: dmc }
edges:
  owns:       { to: System,      cardinality: one-to-many }
  source_of:  { to: Integration, cardinality: many-to-many }
  target_of:  { to: Integration, cardinality: many-to-many }
  in_domain:  { to: Domain,      cardinality: many-to-one }
inherit:
  - attribute: hosting_country
    along: owns            # Systems take the country of their Application
lifecycle: default
controls: [privacy, lineage]
```

| Key | Meaning |
| --- | --- |
| `parent` | Single parent: `Asset`, `Concept`, `ControlRecord`, `GovernanceObject` or `Party` |
| `identity` | How the qualified name is formed |
| `attributes.*.source` | The one source of truth; other sources can only propose |
| `edges` | Allowed relationships and cardinality; anything else is rejected on write |
| `inherit` | Attributes that flow along an edge instead of being stored |
| `propagate` | (on edge types) Which concepts flow along the edge and above what confidence |
| `controls` | Which control types apply, so policies can be checked against types |

## Changing the metamodel

A metamodel change follows the same path as a policy change: written by a coding agent in the repo, checked, dry-run, approved, promoted.

1. **Write.** The agent edits or adds a YAML file; CI validates it against the JSON Schema.
2. **Check.** DMC compares it with the active version. Additive changes (new type, new optional attribute, new edge) are safe. Breaking changes (removing a type, attribute or edge, tightening cardinality, making an attribute required) are blocked while any node, sync job mapping or policy still uses them.
3. **Dry run.** DMC reports the nodes, sync jobs and policies affected and any existing data that would fail the new rules.
4. **Approve.** A platform admin reviews and merges the pull request; the merge is recorded in the ledger.
5. **Promote.** local → UAT → prod, like code. Sync job mappings and policies that need the new type ship in the same promotion.

**Open items**

None at this stage.
