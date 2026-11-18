# 0021. Production build with esbuild

Status: accepted (the new dev dependency needs a human to confirm it, per rule 11)

## Decision
Add `esbuild` (0.25.12) as a root dev dependency. `pnpm run build` (`scripts/build.mjs`) bundles the API, the worker and the migrate command into `dist/dmc.mjs` (run as `node dist/dmc.mjs <api|worker|migrate>`), and copies the data files that packages read beside their own source (JSON schemas, the OpenAPI document) into `dist/assets/`, rewriting those `new URL(..., import.meta.url)` paths. One image (`deploy/docker/server.Dockerfile`) serves all three commands; the web app is built by Vite and served by nginx (`deploy/docker/web.Dockerfile`), which forwards `/v1` to the API.

## Why
`vite-node` runs TypeScript on the fly, which is a development tool, not something to ship. esbuild is already in the pnpm store (Vite depends on it), so it adds no download; bundling needs no `node_modules` in the image.

## Consequences
- The runtime reads `metamodel/`, `config/`, `policies/`, `workflows/`, `sync/` and each module's `migrations/` from `DMC_ROOT`; the image copies them to `/app`.
- Nest's optional adapters (`@nestjs/microservices`, `@fastify/static`, …) are left external; none is used.
- A test (`tests/build.test.ts`) builds the bundle, migrates a database with it and checks the API answers.
- Rollback: delete `scripts/build.mjs` and run the processes with `vite-node` as before.
