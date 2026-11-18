# ADR 0018: Per-type source of truth for the glossary (cutover)

Status: accepted. Date: 2026-11-18. Closes task G1.

## Decision
- `config/source-of-truth.yaml` says, per type, whether Collibra or DMC owns the attributes the metamodel marks `source: collibra`. It changes only by merge.
- At start-up the registry is built with `Registry.withSourceOfTruth(switches)`. A type set to `dmc` has its Collibra-owned attributes re-marked as DMC's; every check that already reads attribute sources then follows: the write validator (the Collibra sync job can no longer write them, people can), the authorisation facts (`fieldSource`), the action module's `sourceOf`, and the API's `attribute_sources`.
- A listed type with nothing to switch, or an unknown source, fails at start-up.
- Glossary types are edited with the `edit_glossary` action, scoped to the steward's domain (`dmc-steward-<domain>`). A term's domain is its category's domain; a category's is the domain it is `part_of`. Data domains are created by administrators (`create_domain`).
- `POST /v1/nodes` creates glossary nodes (people only). `PATCH /v1/nodes/{qn}` edits them like any other node.

## Consequences
- The cutover for a type is one reviewed change: flip its line, disable its Collibra sync job.
- Reverting is the same change the other way; DMC-made edits stay in history.
- The running service must restart to pick up a flip (the registry is immutable at run time).

## Last cutover
When the last type is switched to `dmc` in `config/source-of-truth.yaml`, the same change disables every Collibra job in the environment overlays (`sync/overlays/<env>.yaml`, `enabled: false`): `collibra-data-domains`, `collibra-data-categories`, `collibra-business-terms`, `collibra-term-categories`, `collibra-category-domains`, `collibra-owners` and `collibra-stewards` (the seven `sync/jobs/collibra-*.yaml`). Owners and stewards are not left running after the last switch, because nothing in Collibra is then authoritative.
The Collibra reconciliation report then has nothing left to compare: its last output is archived with the cutover evidence and it is not run again (`sync/collibra-reconciliation.yaml` stays only as the record of the mapping).
