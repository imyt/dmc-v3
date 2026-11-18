// @dmc/platform — shared platform code: authorization, outbox/inbox, metamodel loader, observability
export const PACKAGE = '@dmc/platform' as const;
export * from './db/types';
export { provisionModule, roleFor, ident } from './db/provision';
export { migrateModule } from './db/migrate';
export * from './db/pools';
export * from './config';
export * from './runtime';
export { writeOutbox, markProcessed, type OutboxEvent } from './db/outbox';
export * from './http/conventions';
export * from './observability/tracing';
export * from './observability/logger';
export * from './observability/metrics';
export * from './metamodel/registry';
export * from './authz/authz';
export * from './authz/testing';
