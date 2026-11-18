# ADR 0006 — Catalog store and metamodel generation

Status: accepted (tasks M2, M3)

Decisions
- Identity is the qualified name, unique across all types. Re-applying the same record is a no-op and writes no evidence.
- Bitemporal: `node_version` and `edge` carry valid time (`valid_from`/`valid_to`) and record time (`recorded_from`/`recorded_to`). A change closes the old row in record time and inserts a closed copy for the past period plus the new open row. Queries take `validAt` and `knownAt`.
- Not yet supported: backdated corrections (a `valid_from` before the current version is refused). Add when a connector needs it.
- Writes are checked against the metamodel: shape, required, enums, and one source per attribute (users write only `dmc` attributes; a sync job writes only its own source). Edges must be allowed by the type's edge list; to-one cardinality is enforced.
- Every real change writes one outbox event in the same transaction (ground rule 6). Authorisation (ground rule 5) is applied in the API layer in M4, once F4 exists; the store takes an `actor`.
- Generated outputs (`contracts/src/generated/metamodel.ts`, `contracts/openapi/metamodel.generated.json`) come from `pnpm run gen:metamodel`; CI fails when stale. The generator runs under `vite-node` (already installed with vitest; now an explicit devDependency).

## Search (M5)
- Postgres full text (`simple` config, prefix matching on every word) over `catalog.search_doc`, kept current by the store in the same transaction. Behind `SearchPort`, so a different engine can replace it.
- Ranking and facets cover at most the first 5,000 matches (flagged `facetsSampled`): exact for narrow queries, approximate for very broad ones. This is what keeps p95 at about 160 ms on 1M nodes (target 400 ms; measured in the embedded-Postgres test, run with `DMC_PERF=1 npx vitest run tests/search.test.ts`).
- Paging is limit/offset, offset capped at 1,000; users refine instead of paging deep.
