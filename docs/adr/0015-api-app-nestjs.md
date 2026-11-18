# 0015. API app: NestJS on Fastify (M4)

Status: accepted (stack confirmed in system-design.md)

## Decision
- `apps/api` is a NestJS app on Fastify. Dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-fastify`, `fastify`, `reflect-metadata`, `rxjs`.
- Wiring is injected (`ApiDeps`: connection, catalog store, registry, `Authz`, authenticator) so tests run the real app against a real Postgres, and production passes different pieces.
- Decorators use `experimentalDecorators` (esbuild, used by vitest and Vite, does not emit decorator metadata), so constructor injection always uses an explicit `@Inject(token)`.
- Every error leaves as `application/problem+json` through one filter; unknown errors are logged and returned as a plain 500 with a trace id.
- The gateway guard authenticates, then checks the `read` action; handlers re-check attribute rules because only they know the object. Responses carry `allowed_actions` so the UI never guesses.
- The only authenticator in the repo is `devAuthenticator`, which reads identity from headers and throws unless the environment is `local`. The SSO authenticator replaces it in UAT and prod (F4, deferred).
- Qualified names are path parameters and must be URL-encoded. Lists page by qualified name with an opaque cursor.

## Not yet
Writes (D4), evidence and search endpoints, rate limiting, and reading groups from tokens.
