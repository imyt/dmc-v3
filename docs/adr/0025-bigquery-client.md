# 0025. BigQuery client library (`@google-cloud/bigquery`) for the S2 connector

Status: accepted. The owner confirmed the dependency on 2026-11-18 (rule 11). `@google-cloud/bigquery` 9.6.1 is installed in `@dmc/connectors`, and the server image installs the same pinned version beside the bundle (see `deploy/docker/server.Dockerfile`). A first test against a real project is still to do.

## Decision
Add `@google-cloud/bigquery` as a dependency of `@dmc/connectors` only (not of any other module, and not of `apps/web`). It is loaded in one file, `packages/connectors/src/bigquery-google.ts`, by a lazy dynamic import on the first read of a BigQuery connection. Everything else in the module (the connector, the query checks, the fixture client) is written over `BigQueryClientPort`, a small interface the module owns, so nothing outside that file sees a Google type.

The owner accepted this ADR and the package is installed (see the status line). The connector, its tests and the worker's registration of connector type `bigquery` work against the port without a network; the adapter has not yet been run against a real project.

Checked on the npm registry on 2026-11-18: latest version 9.6.1 (published 2026-11-09), licence Apache-2.0, `engines.node >= 22` (the repo requires >= 22), maintained by Google (googleapis/google-cloud-node). Pin the major version (9.x) when installing.

Not verified:
- the size and licences of the full transitive tree (it pulls `apache-arrow`, `big.js`, `@google-cloud/common` and others); run the licence check after install;
- whether it builds and runs on the production image's base;
- its behaviour against the real BigQuery API from the cluster (no GCP access in this task). The adapter was written from the library's documented `createQueryJob` / `getQueryResults` API and is tested only against a stub.

## Why this library
- It is Google's own client, so authentication, retries on transient errors, job polling, result paging, typed named parameters (including NULL) and dry runs are handled and kept current.
- Query jobs give stable results across pages: a job's result table is read by page token, so a run that takes several pages sees one consistent snapshot, which the sync framework's "read everything, then commit" model needs.

## Authentication
- Default (`auth: adc`): application default credentials. On the on-prem Kubernetes cluster this means workload identity federation (the pod's Kubernetes service account is exchanged for a Google service account) or a credential configuration file mounted by the platform team. DMC stores no key.
- Fallback (`auth: key`): a service-account key, only if federation cannot be offered. The connection names it by `secretRef`; the worker resolves it from the secret store at read time, uses it for that call and redacts it from error text. Keys never appear in YAML, overlays, logs, signals or run records. The overlay's `secret:` field is the same `secretRef` every connection already has (`local/none` where there is none).
- The service account needs only permission to create query jobs in the project and to read the one dataset (BigQuery Job User on the project, Data Viewer on the dataset). One connection per dataset (ServiceNow, DQ Hub, DSTORM, DataVisa) keeps each grant narrow.
- `maxBytesBilled` can be set per connection so BigQuery refuses a query that would scan too much.

## Keeping it contained
- The dependency is listed in `packages/connectors/package.json` only. `pnpm run boundaries` stops other modules importing `@dmc/connectors` internals, and they have no reason to name the Google package.
- The lazy import uses a variable specifier, so bundlers (esbuild in `scripts/build.mjs`, Vite) do not try to resolve a package that is not installed. After installation the build must mark `@google-cloud/bigquery` as external and the image must carry it in `node_modules` (a change to ADR 0021's "no node_modules in the image").
- The worker registers connector type `bigquery` at start-up without loading the library.

## Metadata only (rule 8)
- The jobs read governance tables that other teams land in BigQuery: ServiceNow application and integration records, DQ Hub rules and column-level results, DSTORM schedules and holds, DataVisa assessments. These are facts about data, not business data values. Which tables are read is fixed in job YAML, which a human reviews, and the data platform team grants the service account access to those datasets only.
- The connector enforces the shape of what can be read: one read-only SELECT (or WITH ... SELECT), no comments, no scripting, DDL or write keywords, every table inside the connection's `project.dataset`, and a single bound parameter `@since` for the watermark. Query text is never built from values. A DQ Hub job must select rule and result columns, never profiled data values (a DQ Hub table that stores sample values is excluded by column list; a review point for S9).
- Logs carry counts and names (project, dataset, rows, page), never rows, parameters or secrets.

## Alternative: the BigQuery REST API through the existing REST connector (S4)
`POST https://bigquery.googleapis.com/bigquery/v2/projects/{p}/queries` then `GET .../queries/{jobId}?pageToken=...` can be called with no new dependency. Compared honestly:
- Auth. The REST connector supports bearer, basic and a header, with a secret from the store. BigQuery needs an OAuth2 access token, minted from a service-account key (a signed JWT exchanged at the token endpoint) or from workload identity (token exchange plus service-account impersonation), and it expires hourly. The REST connector has no token minting or refresh, so either a new auth type is built and tested there, or a sidecar refreshes a token into a secret. This is the largest part of the work and is security-sensitive code we would own.
- Paging. BigQuery's flow is POST to start a query, poll `jobComplete`, then GET results by `pageToken`. The REST connector only issues GET requests and has no polling, so it would need a POST-then-poll mode.
- Parameters. Query parameters are a typed JSON structure in the POST body (the REST connector builds query strings only), and NULL needs an explicit type.
- Result shape. Rows come back as `{f:[{v:...}]}` with a separate schema and every value as a string, so records would have to be rebuilt, which is what the library does.
- For the alternative: no new dependency and no large transitive tree, nothing for the image. Against: an extension of the REST connector (token minting, POST and poll, typed bodies, result decoding) that we own and keep secure, to avoid one well-maintained package.
- Because the connector is written over `BigQueryClientPort`, this option stays open: a REST-based adapter implements the same port and the connector, the job and the tests do not change.

## Consequences
- One new dependency in one module, Apache-2.0, loaded lazily. The sync framework, the jobs and the tests do not depend on it being installed.
- S6, S9 and S10 add job YAML and one overlay connection per dataset, no code.
- Rollback: remove the package and `bigquery-google.ts`; the connector keeps working with any other implementation of the port.

## What a human must do
1. Confirm or reject this ADR, including the REST alternative.
2. If confirmed: install `@google-cloud/bigquery@9` in `@dmc/connectors`, mark it external in `scripts/build.mjs`, and add it to the image.
3. Provide, per environment (UAT, prod): the GCP project id, the dataset for ServiceNow (later DQ Hub, DSTORM, DataVisa), a service account with the grants above, and how the cluster authenticates (workload identity configuration, or a secret reference for a key). Put project and dataset on the `bq-servicenow` connection in `sync/overlays/<env>.yaml`.
