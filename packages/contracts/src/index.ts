// @dmc/contracts — OpenAPI, event schemas and generated types; the only way modules talk to each other
export const PACKAGE = '@dmc/contracts' as const;
export { loadSpec, checkResponse } from './validate.js';
export * from './generated/metamodel.js';
export * from './ports.js';
