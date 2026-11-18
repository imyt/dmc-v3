# ADR 0016: Writes from people, scripts and agents go through signals (`apply_change`)

Status: accepted. Date: 2026-11-18. Closes task D4.

## Context
The API accepts edits to DMC-owned fields from people, scripts and agents. Ground rules say every write is authorised and evidenced, and the design says low human touch: agents should be able to do work, but a policy, not the caller, decides how far they may go.

## Decision
- New policy effect `apply_change`: apply the write that arrived with the signal. The effect names no attribute or value; the signal carries `change { attribute, value }`.
- A person's authorised edit of a DMC-owned field (`PATCH /v1/nodes/{qn}`, `If-Match`, `Idempotency-Key`, optional `dry_run`) is applied at once, and a `write.applied` signal is emitted.
- A script or agent (a service account acting for a person) writes nothing directly. The API emits a `write.proposed` signal with the change; the decision worker evaluates policies. A policy with autonomy `act` applies it through the action module (undoable); `propose` or low confidence raises a review exception (`proposal:apply_change`). With no matching policy, nothing happens.
- Authorisation is the acting person's, checked before the signal is accepted. The signal actor records both identities (`agent for person`). Synced fields are refused with the owning tool named.
- `apply_change` counts as state-changing and reversible (see `STATE_CHANGING`). A signal without a change (a `write.applied`) makes it a no-op.
- `decision.signal` gains a `change jsonb` column; the decision service passes the change into the action request as the effect's attribute and value, so the action module and undo are unchanged.

## Consequences
- One path for all non-human writes, with the same evidence, autonomy limits, kill switches and undo as any other policy effect.
- The agent gets 202 and must read back later; there is no synchronous apply for agents.
- Subject references from the API use `<Type>:<qualified name>`, matching sync signals.
- Wiring the API's `signals` dependency to `DecisionService.handle` happens in the worker/API composition task.
