// @dmc/app-api: deployable. Composes modules behind /v1 (NestJS on Fastify).
export const PACKAGE = '@dmc/app-api' as const;
export { createApi } from './app.js';
export { devAuthenticator, cookieAuthenticator, encodeSession, decodeSession, SESSION_COOKIE, type Session } from './auth.js';
export type { ApiDeps, Connection } from './context.js';
export { startApi, main, type StartedApi } from './main.js';
export * from './file-change-requests.js';
