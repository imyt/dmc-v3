// @dmc/sdk — generated TypeScript SDK from @dmc/contracts (never hand-written; types live in schema.d.ts)
import createClient from 'openapi-fetch';
import type { paths } from './schema';

export type { paths, components } from './schema';

export function createDmcClient(baseUrl: string, getToken?: () => string | undefined) {
  return createClient<paths>({
    baseUrl,
    fetch: async (req) => {
      const token = getToken?.();
      if (token) req.headers.set('Authorization', `Bearer ${token}`);
      return fetch(req);
    },
  });
}
