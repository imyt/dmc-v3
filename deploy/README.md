# Deploy

- Local: `docker compose up -d` starts Postgres (5432), the audit Postgres (5433) and Mailpit (SMTP 1025, inbox at http://localhost:8025). `docker compose --profile full up --build` also builds and runs the whole stack: migrate, API (:3000), worker, mock sources, web (:8080).
- Charts: one per deployable in `charts/`. Render per environment:
  `helm template dmc-api charts/api -f env/uat.yaml`
- Environment values live in `env/` (local, uat, prod). Secrets are referenced by name (`secretRefs`), never inlined.
- No Kubernetes CronJobs: schedules run through pg-boss.
- BigQuery (ADR 0025): the server image installs `@google-cloud/bigquery` beside the bundle (the version is pinned in `docker/server.Dockerfile` and must equal `packages/connectors/package.json`). In the cluster authenticate with workload identity; a service-account key is used only through a `secretRef`. A connection reaches one project and dataset, so each source (ServiceNow, DQ Hub, DSTORM, DataVisa) needs its own connection in the overlay.
- Sync overlays: `sync/overlays/uat.yaml` and `prod.yaml` list every connection and job with `REPLACE_ME` values and every job off. A job with a placeholder cannot be enabled. Replace the values per environment, then enable jobs one at a time from the Sync admin screen's data (the screen pauses, runs and approves; it does not edit jobs).
- Migrations: run `migrate` after every code change that adds a migration, including against a long-lived local database (`pnpm run migrate` with the `DMC_DB_*` variables below). A missing migration shows as a bare 500 on the page that reads the new table.
- Load checks: `pnpm run perf` runs the ledger, search and lineage load checks (separate from `pnpm run ci`; slow). Run it on UAT-like hardware before prod.
- Web development: Vite reads `DMC_API_URL` (default `http://localhost:8080`) and `DMC_WEB_PORT` (default 5173), so a second web server can point at another API.

## Running the processes

`pnpm run build` makes `dist/dmc.mjs`; run `node dist/dmc.mjs migrate` (once per deploy, as the admin role), then `node dist/dmc.mjs api` and `node dist/dmc.mjs worker` (this is what the images do; see `deploy/docker/`, ADR 0021). In development `pnpm run migrate|api|worker` do the same through vite-node. Configuration is environment variables only:

| Variable | Meaning |
|---|---|
| `DMC_ENVIRONMENT` | `local`, `uat` or `prod` (default `local`) |
| `DMC_ROOT` | the repository layout: `metamodel/`, `config/`, `policies/`, `packages/*/migrations`, `sync/` (default: current directory) |
| `DMC_DB_HOST`, `DMC_DB_PORT`, `DMC_DB_NAME` | the database (host is required outside `local`) |
| `DMC_DB_ADMIN_USER`, `DMC_DB_ADMIN_PASSWORD` | used by `migrate` and by the job queue's own schema |
| `DMC_DB_PASSWORD_<MODULE>` | the password of each module's role (`CATALOG`, `DECISION`, `WORKFLOW`, `POLICY`, `ACTIONS`, `CONNECTORS`, `EVIDENCE`); no defaults outside `local` |
| `DMC_HTTP_HOST`, `DMC_HTTP_PORT` | the API listener |
| `DMC_AUDIT_DB_HOST`, `_PORT`, `_NAME`, `_ADMIN_USER`, `_ADMIN_PASSWORD`, `_WRITER_PASSWORD` | the separate audit database (E2). When the host is set, `migrate` creates its insert-only `dmc_audit_writer` role and the worker copies the ledger's head hash there every 5 seconds or 5,000 entries; the verifier checks the ledger against those copies. Unset: no copy is made, and the worker logs a warning |
| `DMC_SMTP_HOST`, `_PORT` (587), `_SECURE` (`true` for TLS on connect), `_USER`, `_PASSWORD_REF`, `_FROM` | email for task notifications (ADR 0023). The password is the secret named by `_PASSWORD_REF`, i.e. `DMC_SECRET_<REF>`. Unset host: no email, each message is a log line. Locally set `DMC_SMTP_HOST=localhost DMC_SMTP_PORT=1025` and read the mail in Mailpit |
| `DMC_PUBLIC_URL` | the web address put in email links (local default `http://localhost:5173`) |
| `DMC_SECRET_SESSION` | signs the `dmc_session` cookie; required outside `local` |
| `DMC_SECRET_<REF>` | a connector secret named `<ref>` in a sync overlay |

The API starts with header identity or the mock login only in `local`. UAT and prod read the `dmc_session` cookie the corporate sign-in sets, signed with `DMC_SECRET_SESSION` (ADR 0020); the API refuses to start there without that secret.
Sync jobs are read from `sync/jobs/*.yaml` and `sync/overlays/<environment>.yaml`; with none present the worker runs housekeeping and workflows only.
The worker emails people about new tasks, raised exceptions, escalations and tasks due within a day, once each. Addresses come from the Person record (`staff_id`, `email`) or, locally, `config/local-users.json`; a route or group name (such as `data-steward`) is looked up in `config/notifications.yaml`. An assignee with no address is logged once.

## Local data and sign-in

`pnpm run seed` loads synthetic applications, integrations, datasets, scopes, glossary, record classes, visas and lineage (local only; safe to repeat). `pnpm run mock-sources` serves `sync/fixtures/` on :8099 for the local sync job. `POST /v1/auth/mock-login` signs in as any of the people in `config/local-users.json` (local only).
