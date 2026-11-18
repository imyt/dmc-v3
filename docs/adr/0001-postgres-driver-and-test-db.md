# ADR 0001: `pg` driver and `embedded-postgres` for tests

Status: accepted (task F3)

- **Runtime:** `pg` (node-postgres) in `@dmc/platform`. Plain SQL, no ORM, so schemas and grants stay explicit and each module's DB role can be enforced by Postgres itself.
- **Tests:** `embedded-postgres` (dev only) starts a real Postgres from npm binaries (needs the postinstall allow-listed in pnpm-workspace.yaml), so role and schema isolation is tested against the real engine without Docker.
- **Alternatives:** an ORM (hides grants), PGlite (single-user, weak role semantics).
