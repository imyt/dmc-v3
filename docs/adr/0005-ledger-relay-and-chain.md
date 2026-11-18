# ADR 0005 — Ledger relay and hash chain

Status: accepted (task E1)

Decision:
- Entry hash = SHA-256(prev_hash | payload_hash | seq). payload_hash covers kind, subject, actor, source module and id, occurred_at (ms) and the canonical (sorted-key) JSON payload. Genesis prev_hash is 64 zeros.
- One writer: `appendBatch` takes a transaction-level advisory lock, reads the chain head and inserts a batch with one statement.
- The relay (`relayOutbox`) runs under the `dmc_evidence` role in one transaction: read unpublished outbox rows with `for update skip locked`, chain them, mark them published. All or nothing.
- The ledger table accepts INSERT and SELECT for `dmc_evidence`; UPDATE, DELETE and TRUNCATE are revoked, and triggers raise on them for every other role, including owners.

Exception to ground rule 3 (one schema per module): `dmc_evidence` gets SELECT and UPDATE(published_at) on every module's outbox table, via `grantRelay`. It is the only cross-schema grant and exists so the single writer can see every outbox. Rejected alternative: each module pushes events to a queue; that adds a second delivery path to keep exactly-once.

Deferred: monthly partitioning of `ledger_entry` (system design) — the volume at MVP does not need it; revisit before E2 checkpoints or at about 50M rows. Entries with source ids repeat protection via a unique (source_module, source_id) constraint.
