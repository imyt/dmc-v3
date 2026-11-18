# 0024. Sync: retry of refused records, owner re-check, value maps

Status: accepted. Extends 0013 (sync framework).

## 1. A refused record is not recorded as seen
Problem: the ingest refuses a record (an edge whose column is not in the catalog yet, an attribute the metamodel rejects) and reports it through `onReject`, but the run still wrote `record_state` for it. An unchanged record was then never sent again.

Decision:
- `SignalSink.submit` may return `{ rejected: string[] }`, the keys of signals it refused (`@dmc/contracts`, additive; sinks that return nothing behave as before). `CatalogIngest` returns the keys it reported through `onReject`.
- `SyncService.commit` writes `record_state` only for records the sink accepted. A refused new record has no state, so it is `created` again next run. A refused change keeps the last accepted hash, so it is `updated` again. A refused `missing` stays `active` and is retried. This applies to node and edge records alike.
- The run still succeeds and the accepted records are committed. Its note says how many were refused. The ingest keeps reporting a still-refused record on every run (visible, not silent).
- An incremental job does not move its cursor in a run with refused records, so the record is read again; unchanged records are skipped by hash, so only the cost of the re-read is paid.
- Deprecation is unchanged: `complete` still means every page was read and every record mapped. A refused record was read and is in the run's `seen` set, so it cannot cause a false `missing`, and it does not make the run incomplete. (Refusal happens after the deprecation decision, from the catalog's view; making it block deprecation would let one permanently bad record stop all deprecation of a job.) The change limit counts what the run found, as before.
- The signal key is `<record key>@<hash>`; the retry has the same key. The ingest is idempotent, so delivering again is safe. A sink that deduplicates by key must treat a key it rejected as not delivered.

## 2. Scope owner exceptions are re-checked
`scope.owner_unknown` was withdrawn only when the scope record changed. `ScopeOwnerCheck.recheck()` now takes the open exceptions (policy `scope-owner-unknown`, through the `openUnknown` dependency) and withdraws each one whose scope's current owner is a Person (by qualified name or email), or whose scope is gone or deprecated. It never raises. The worker runs it on its own pg-boss queue `worker.scope-owners`, every 15 minutes, the same cadence as the derivations (`apps/worker/src/run.ts`). A separate queue keeps one failing job from blocking the other.

## 3. Value maps in the job target mapping
A `target.map` entry is either a source field (as before) or `{ from: <field>, values: { <source value>: <DMC value> } }`:

    map: { name: title, kind: { from: type, values: { ProcessX: business-process } } }

- Additive: the schema accepts a string or this object; existing jobs are unchanged. The mapped value is what is hashed and sent.
- A source value with no entry is an error for that record: it is counted in `errors`, named in the run note (first three), the run is not complete (so it cannot deprecate), and the record is not sent. A field the record lacks is skipped, as for a plain map.
- At job load the worker calls `checkJobAgainstMetamodel(def, registry)`: the type and mapped attribute must exist, and every target value must be a value of the attribute's enum. A job that fails does not load. Edge jobs are not checked (edge attributes are not type attributes); `compileJob` itself has no registry and stays pure.
- Not matched case-insensitively and no wildcard or default: an unlisted label is a visible decision for a person, not a guess.
