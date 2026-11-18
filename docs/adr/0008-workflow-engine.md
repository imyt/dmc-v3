# ADR 0008 — Workflow engine and pg-boss

Status: accepted (task W1)

Decisions
- Definitions are YAML data, checked by JSON Schema and code (references, no cycles, reachability, CEL conditions compile, joins match their parallel). Published versions are immutable (checksum); instances stay on the version they started with.
- Step types: task, action, branch (CEL on `ctx`; a missing key is a non-match), parallel/join, end. No loops in the MVP: because a step is entered at most once per instance, `unique (instance_id, step_id)` is what stops a retry from advancing twice.
- Every mutation locks the instance row, so advances are serial per instance. Decisions are idempotent (same key, or same decision by the same person, replays). Actions are claimed (pending → running, with a 5-minute lease) and then completed, so a job delivered twice runs once and a crashed worker is retried after the lease.
- Queue jobs are sent only after the transaction commits. Timers and action jobs use pg-boss (`pg-boss` 12, Node 22) behind a `Scheduler` port; tests use an in-memory scheduler plus one real pg-boss test.
- Every transition writes an outbox event (ground rule 6).

Open: the pg-boss schema is created by whichever role starts it; F3/F2 should decide whether the platform team pre-creates it. Authorisation beyond "only the assignee decides" belongs to W2 and F4.

## Exceptions (W3)
- An exception is a row plus a workflow instance of the built-in `exception-handling` definition (task for the policy's route; SLA from the policy's `escalate_after` through `sla_context`; escalates to `governance-lead`). Status is a SQL view over the instance, so it cannot disagree with it.
- One open exception per policy and subject (unique `dedupe_key`); a closed one frees the key, so the same problem can return as a new exception. `withdraw` cancels the instance when a later evaluation no longer matches.
- Known gap: `raise` is two commits (instance, then exception row). Two simultaneous raises for the same key can leave one orphan instance; D1 serialises per asset (singleton key) so it should not occur in practice.
