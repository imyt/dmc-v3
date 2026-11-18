import type { Principal } from './authz.js';

/** Test helpers: build principals without an IdP. */
export const person = (id: string, ...groups: string[]): Principal => ({ id, kind: 'person', groups });
export const service = (id: string, ...scopes: string[]): Principal => ({ id, kind: 'service', groups: [], scopes });
export const agentFor = (agent: Principal, on: Principal): Principal => ({ ...agent, actingFor: on });
