# ADR 0010 — Actions, undo and kill switches

Status: accepted (task D2)

- `ActionService` implements `ActionPort`. It reaches the catalog, notifications and the owning tools only through ports in `@dmc/contracts` (`CatalogWritePort`, `NotifyPort`, `ToolTaskPort`).
- Kinds: `dmc_change` (a `dmc`-sourced attribute, written now, with `{previous, applied}` stored for undo), `tool_task` (classifications and anything another tool owns: a task to the route plus a `pending_change` holding the expected state, confirmed on the next sync in D3), `notify`.
- Idempotency: `unique (idempotency_key)`; a replay returns the first result. A failed or blocked action is attempted again under the same key.
- Undo restores the previous value only if the current value is still the one the action wrote; otherwise it is refused (a person's newer edit is never overwritten). Undo of a non-reversible action is refused.
- Kill switches (`all`, `policy:<id>`, `effect:<action>`): a matching switch records the action as `blocked` and does nothing; `retryBlocked` sends them after release. Pausing and releasing are evidenced. The admin screen is U2.
