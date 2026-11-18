# One image for the API, the worker and the migration job: `docker run <image> api|worker|migrate`.
# Build from the repository root: docker build -f deploy/docker/server.Dockerfile -t dmc/server .
FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && node scripts/build.mjs

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DMC_ROOT=/app
COPY --from=build /src/dist ./dist
# the BigQuery client is loaded lazily and is not bundled (ADR 0025); keep this version equal to packages/connectors/package.json
RUN npm install --omit=dev --no-save --no-package-lock --no-audit --no-fund @google-cloud/bigquery@9.6.1
COPY --from=build /src/metamodel ./metamodel
COPY --from=build /src/config ./config
COPY --from=build /src/policies ./policies
COPY --from=build /src/workflows ./workflows
COPY --from=build /src/sync ./sync
# each module's migrations are read from packages/<module>/migrations
COPY --from=build /src/packages/catalog/migrations ./packages/catalog/migrations
COPY --from=build /src/packages/decision/migrations ./packages/decision/migrations
COPY --from=build /src/packages/workflow/migrations ./packages/workflow/migrations
COPY --from=build /src/packages/policy/migrations ./packages/policy/migrations
COPY --from=build /src/packages/actions/migrations ./packages/actions/migrations
COPY --from=build /src/packages/connectors/migrations ./packages/connectors/migrations
COPY --from=build /src/packages/evidence/migrations ./packages/evidence/migrations
COPY --from=build /src/packages/trust/migrations ./packages/trust/migrations
USER node
EXPOSE 3000
ENTRYPOINT ["node", "dist/dmc.mjs"]
CMD ["api"]
