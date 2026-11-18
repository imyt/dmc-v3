# 0019. ajv-formats for the metamodel and contract validators

Status: accepted (the new dependency needs a human to confirm it, per rule 11)

## Decision
Add `ajv-formats` (3.x, the package the Ajv authors maintain) to `@dmc/catalog` and `@dmc/contracts` and register it on the two Ajv instances that check data: attribute writes against the metamodel, and API responses against the OpenAPI contract.

## Why
Today Ajv runs with `strict: false`, so a `format` keyword (`date`, `date-time`, `uri`) is ignored and logs "unknown format". A date attribute from a source such as ServiceNow or the DataVisa tool is accepted whatever it contains, and the cross-border and retention checks compare dates as text. Enforcing the formats refuses a malformed date at the door, as a refused source record, instead of letting it into the catalog.

## Consequences
- A synced record whose date or URL is not valid is refused and reported (the existing refused-record path), not stored.
- No other package changes: policies, workflow and connector definitions keep their own schemas, which use no formats.
- `ajv-formats` is already in the pnpm store as a transitive dependency, so it adds no new download.
- Rollback: remove the two `addFormats` calls.
