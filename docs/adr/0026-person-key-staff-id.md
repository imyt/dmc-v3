# 0026. The Person key is the staff ID

Status: accepted (owner decision, confirmed). Extends 0014 (authorization), 0018 (source of truth), 0020 (session cookie), 0024 (owner re-check).

## Decision
- A Person's qualified name is the **staff ID**: a string of exactly 8 digits, often with leading zeros (`00123456`, `04300004`). It is always a string. It is never parsed as a number, padded or trimmed anywhere (JSON, YAML, CSV, SQL, TypeScript). Quote it in every fixture, job and config file; unquoted digits in YAML become a number and lose their zeros.
- The rule is data in `metamodel/types/Person.yaml`: `identity.pattern: '^\d{8}$'`, and `pattern` on the `staff_id` attribute. Email stays a required attribute and is how an email from a source is resolved to a person. Person is version 2.
- Small additive extension of the metamodel format (no new dependency): `identity.pattern` (checked by the store when a node of the type is created) and attribute `pattern` (in the generated JSON Schema, so the write validator and the API schemas apply it). A pattern failure on an all-digit value says the leading zeros may have been lost.
- Attribute `identifies: <Type>` marks a string attribute that holds the key of another node (`Scope.owner` identifies a Person). A `type: person` attribute is treated the same way by the sync.
- **Resolution of owners** (`PersonRefResolver`, worker, in front of the catalog ingest): for a sync write of such an attribute, and for the Person end of an edge (`owned_by`, `stewarded_by`), a staff ID passes through untouched; an email is looked up on the Person's `email` attribute (case-insensitive) and replaced by the staff ID. Anything else is a data error: a value of all digits but not 8 long ("lost its zeros"; never padded), a number type, an email no Person has, an email two Persons share, or text that is neither. The record is refused through the existing reject path (`onReject`, key in `rejected`), is not recorded as seen and is retried (ADR 0024).
- Scope owner check (S11) and its re-check look the owner up by Person key only. An unknown 8-digit owner still raises `scope.owner_unknown`.
- Collibra owner/steward jobs: the user field that identifies the person is the overlay parameter `ownerKeyField` (`to_qualified_name: "{${ownerKeyField}}"`; overlay parameters are now also filled into edge templates). Local default `emailAddress`. The reconciliation reads the same field from `personKeyField` in `sync/collibra-reconciliation.yaml`, resolves emails through the catalog's Person nodes, and lists values it cannot resolve in `unresolvedPeople` (the report then does not match).
- ServiceNow application jobs: `owned_by` is expected to be the staff ID; an email is resolved as above.
- The authorization principal id is the staff ID (cookie `staffID`, ADR 0020); rules compare it to owner strings with `==`/`in`, so zeros matter. Seed creates a Person node for each user in `config/local-users.json`, including one with leading zeros.
- M6: `identity_changed` and `attribute_pattern_changed` are breaking changes in the diff, counted against nodes whose key (or value) no longer matches the new pattern. The acknowledgement mechanism of the repo is the version bump plus the count: the change is blocked only while such nodes exist. Person is bumped to version 2; no Person node exists yet in any environment (no IdP sync job), so nothing is blocked.

## Open (human input needed)
- Collibra admin: does the user `userName` hold the staff ID? If yes set `ownerKeyField: userName` and `personKeyField: userName`; otherwise keep `emailAddress`.
- ServiceNow owner: which user field lands in `owned_by` (staff ID, user name or email)? Application `delegates` (a string list) are not resolved yet.
- The IdP sync job that creates Person nodes (keyed by staff ID, with email) does not exist yet; until it does, an email owner cannot resolve outside local.
- Persons are not yet required to carry `staff_id` (it should equal the key); other `person` attributes written by people (ControlRequirement.owner, task assignees, delegation owner/delegate) are not pattern-checked, because assignees may be routes or groups.
