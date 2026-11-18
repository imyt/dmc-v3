# ADR 0009 — Decision worker and ports

Status: accepted (task D1)

- Modules reach each other only through ports defined in `@dmc/contracts` (`PolicyPort`, `ExceptionPort`, `ActionPort`, `Signal`); the apps wire implementations. `@dmc/policy` provides `PolicyService`, `@dmc/workflow` provides `ExceptionService`, `@dmc/actions` will provide `ActionPort` (D2).
- A signal is handled in two steps. Step 1 is one transaction: the signal, every decision (`planned`) and their evidence. Step 2 carries the decisions out through the ports, each idempotent (exception dedupe key; action idempotency key `decision:<id>`). A crash or a failed adapter leaves `planned` or `failed` rows that `resume` finishes; the signal is never decided twice (`unique (source, key)`).
- Outcomes. Shadow policies: recorded, never acted on. Enforced and matching: autonomy = min(ceiling, level allowed by confidence), where confidence = min(signal, policy) and the default thresholds are 0.95 act, 0.8 act_notify, 0.5 propose. Below that, drop (recorded only).
- Effects. State-changing effects (`set_attribute`, `classify`) dispatch an action at act/act_notify; at propose they become a task on the policy's route. Human-facing effects (`raise_exception`, `create_task`, `notify`) always become an exception routed to the policy's route; act_notify also dispatches a notification. A raise_exception policy that stops matching withdraws its exception (decision outcome `cleared`).
- An expression that cannot be evaluated is an `error` decision and does nothing.
- Per-asset ordering is the worker's job (pg-boss singleton key on the subject); the service itself is safe if two run.
