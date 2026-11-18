# 0013. Sync framework (S1)

Status: accepted

## Decision
- The sync framework lives in `@dmc/connectors`, schema `connectors` (the system design calls the tables `sync.*`; the module and schema name win under ground rule 3, so they are `connectors.connection|job|run|cursor|record_state|staging`).
- `Connector` and `SignalSink` are ports in `@dmc/contracts`. A connector reads one page at a time; jobs and connections are data.
- Job YAML is validated by JSON Schema. An environment overlay sets connection, schedule, `enabled` and the parameters a query uses (`${project}`); a missing parameter fails when the job is resolved, not at run time.
- A run reads every page and holds what it found in `staging`. Nothing leaves the module until the whole run is read and has passed its limit check. Then signals go out (idempotent by `source + key`) and the record state and cursor move in one transaction. A failed run changes nothing; a retry of a page uses exponential backoff.
- Change detection compares a hash of the mapped attributes with `record_state`; no catalog read is needed. Signal key is `<record key>@<hash>`, so redelivery dedupes.
- Deprecation: only a full run that read every page with no record errors may deprecate. Missing records become `sync.missing` signals; policy decides what happens. A record that reappears becomes an update.
- Change limit: `(created + updated + missing) / active records before` above `max_changes_pct` pauses the run (`paused_limit`), raises a `sync.change_limit` exception to `platform-admin`, and later runs of that job are skipped until an admin approves (signals go out) or discards. The first load is never limited.
- Schedules and run-now use pg-boss (queue `sync.run`; singleton key `<env>/<job>`).

## Open
- `subjectRef` for synced records is `<Type>:<key>`. Decision and catalog have used `node/<id>` in fixtures; the final convention is set when the catalog sink (S2) is wired.
- The "no successful run in 24 hours lowers the sync dimension" rule has its query (`stale`); the trust module consumes it later.
- Confirming pending changes on sync (D3) will read `record_state`/run results through a port, not these tables.

## D3 (confirm on sync, else escalate)
`ActionRequest.escalateAfter` carries the policy's deadline; the actions module stores `due_by` on the pending change. `ActionService.confirmOnSync(source, observations)` confirms a pending change when the source that owns the attribute shows the expected value (a different source cannot confirm it). `escalateOverdue(now)` runs on a timer and raises one `pending_change.overdue` exception to the tool's route; a later confirmation of an escalated change withdraws that exception. Changes with no deadline never escalate. The worker wires sync signals into `confirmOnSync`.
