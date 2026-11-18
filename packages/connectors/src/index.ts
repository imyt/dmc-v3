// @dmc/connectors: bounded-context module (own Postgres schema: connectors). Sync framework (S1).
export const PACKAGE = '@dmc/connectors' as const;
export * from './definition.js';
export * from './mapping.js';
export * from './service.js';
export * from './schedule.js';
export * from './rest.js';
export * from './manifest.js';
export * from './person.js';
export * from './reconcile.js';
export * from './bigquery.js';
export * from './bigquery-fixture.js';
export * from './bigquery-google.js';
export * from './git-json.js';
export * from './writers.js';
