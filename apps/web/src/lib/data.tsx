import { createContext, useContext, type ReactNode } from 'react';
import { createDmcClient, type components } from '@dmc/sdk';

export type ApiNode = components['schemas']['Node'];
export type ApiEdgeList = components['schemas']['EdgeList'];
export type ApiHistory = components['schemas']['NodeHistory'];
export type ApiSearch = components['schemas']['SearchResult'];
export type ApiInbox = components['schemas']['Inbox'];
export type Tier = 'bronze' | 'silver' | 'gold';
/** `required_tier` is the trust tier the scope owner asks for; the API returns it once the backend field lands. */
export type ApiScope = components['schemas']['ScopeDetail'] & { required_tier?: Tier };
export type ApiLineage = components['schemas']['Lineage'];
export type ApiRequirementInput = components['schemas']['RequirementInput'];
export type ApiRequirementReport = components['schemas']['RequirementReport'];
/** Who is signed in: what the corporate login puts in the session cookie (display name, staff ID, Active Directory groups). */
export interface AuthUser { displayName: string; staffID: string; groups: string[]; /** what DMC maps the groups to (steward, scope-owner, admin, ...); absent from an older API */ roles?: string[] }
export interface ClassificationProposal { id: string; subject: string; classification: string; reason: string; source?: string; status: 'open' | 'accepted' | 'rejected' }
export interface AdminStatus { version: string; metamodel_version: string; enforcement: 'running' | 'paused'; policies: { id: string; mode: string; paused: boolean }[] }
export interface DashboardMeasure { id: string; label: string; value: number; target: number; unit?: string }
export type ApiCompleteness = components['schemas']['ScopeCompleteness'];
export type ApiDatasets = components['schemas']['IntegrationDatasets'];
export type ApiDatasetInput = components['schemas']['DatasetInput'];
export type ApiCoverage = components['schemas']['RequirementCoverage'];
export type ApiEvidence = components['schemas']['EvidencePage'];
export type ApiProof = components['schemas']['ProofBundle'];

/** What the API said when it refused: shown to the person, with the request id for support. */
export class ApiProblem extends Error {
  constructor(readonly status: number, readonly detail: string, readonly requestId?: string) { super(detail); }
}

/** Everything the screens read. The real one calls the API through the generated SDK; tests pass a fake. */
export interface DataSource {
  search(q: string, opts?: { types?: string[]; lifecycles?: string[]; limit?: number }): Promise<ApiSearch>;
  node(qn: string): Promise<ApiNode>;
  relationships(qn: string, direction: 'out' | 'in'): Promise<ApiEdgeList>;
  history(qn: string): Promise<ApiHistory>;
  inbox(): Promise<ApiInbox>;
  decide(taskId: string, decision: string, key: string): Promise<{ replayed: boolean }>;
  scope(qn: string): Promise<ApiScope>;
  scopeCompleteness(qn: string): Promise<ApiCompleteness>;
  scopeAction(qn: string, action: 'submit' | 'amend'): Promise<unknown>;
  addScopeGroup(qn: string, name: string): Promise<unknown>;
  addScopeElement(qn: string, group: string, name: string, definition?: string): Promise<unknown>;
  linkScopeElement(qn: string, link: { element: string; target: string; app: string }): Promise<unknown>;
  datasets(integration: string): Promise<ApiDatasets>;
  saveDataset(integration: string, qn: string | undefined, input: ApiDatasetInput): Promise<unknown>;
  requirementCoverage(): Promise<ApiCoverage>;
  verifyLedger(): Promise<{ ok: boolean; checked: number; first_bad_seq?: number }>;
  nodeEvidence(qn: string): Promise<ApiEvidence>;
  nodeProof(qn: string): Promise<ApiProof>;
  health(): Promise<{ status: string; version: string }>;
  confirmScopeLink(qn: string, link: { element: string; target: string }): Promise<unknown>;
  setScopeFlows(qn: string, integrations: string[]): Promise<unknown>;
  /** The scope owner chooses the trust tier the scope has to reach. */
  setScopeTier(qn: string, tier: Tier): Promise<unknown>;
  saveRequirement(input: ApiRequirementInput, dryRun?: boolean): Promise<ApiRequirementReport>;
  importRequirements(csv: string, dryRun?: boolean): Promise<ApiRequirementReport>;
  lineage(qn: string, direction: 'upstream' | 'downstream', depth?: number): Promise<ApiLineage>;
  /** The signed-in person, or null when there is no session. */
  me(): Promise<AuthUser | null>;
  /** Local only: pretend to be the corporate login. */
  mockLogin(user: AuthUser): Promise<AuthUser>;
  logout(): Promise<void>;
  classificationProposals(): Promise<ClassificationProposal[]>;
  decideClassification(id: string, decision: 'accept' | 'reject'): Promise<unknown>;
  adminStatus(): Promise<AdminStatus>;
  setEnforcement(paused: boolean): Promise<unknown>;
  pausePolicy(id: string, paused: boolean): Promise<unknown>;
  dashboardMeasures(): Promise<DashboardMeasure[]>;
}

export function createDataSource(baseUrl: string, getToken?: () => string | undefined): DataSource {
  const client = createDmcClient(baseUrl, getToken);
  const ok = <T,>(r: { data?: T; error?: unknown; response: Response }): T => {
    if (r.data !== undefined) return r.data;
    const e = (r.error ?? {}) as { detail?: string; request_id?: string };
    if (r.response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('dmc:unauthorized'));
    throw new ApiProblem(r.response.status, e.detail ?? `The request failed (${r.response.status})`, e.request_id);
  };
  /** For routes the generated SDK does not know yet; sends the session cookie. */
  const raw = async <T,>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; body: T | undefined }> => {
    const res = await fetch(`${baseUrl}${path}`, { method, credentials: 'include', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    const json = text ? JSON.parse(text) as T & { detail?: string; request_id?: string } : undefined;
    if (!res.ok) { if (res.status === 401 && path !== '/v1/auth/me' && typeof window !== 'undefined') window.dispatchEvent(new Event('dmc:unauthorized')); throw new ApiProblem(res.status, (json as { detail?: string } | undefined)?.detail ?? `The request failed (${res.status})`, (json as { request_id?: string } | undefined)?.request_id); }
    return { status: res.status, body: json };
  };
  return {
    async search(q, o = {}) {
      return ok(await client.GET('/v1/search', { params: { query: { q, type: o.types?.join(','), lifecycle: o.lifecycles?.join(','), limit: o.limit } } }));
    },
    async node(qn) { return ok(await client.GET('/v1/nodes/{qualified_name}', { params: { path: { qualified_name: qn } } })); },
    async relationships(qn, direction) { return ok(await client.GET('/v1/nodes/{qualified_name}/relationships', { params: { path: { qualified_name: qn }, query: { direction } } })); },
    async inbox() { return ok(await client.GET('/v1/inbox')); },
    async decide(id, decision, key) {
      return ok(await client.POST('/v1/inbox/{id}/decision', { params: { path: { id }, header: { 'Idempotency-Key': key } }, body: { decision } }));
    },
    async scope(qn) { return ok(await client.GET('/v1/scopes/{qualified_name}', { params: { path: { qualified_name: qn } } })); },
    async scopeCompleteness(qn) { return ok(await client.GET('/v1/scopes/{qualified_name}/completeness', { params: { path: { qualified_name: qn } } })); },
    async scopeAction(qn, action) {
      const path = action === 'submit' ? '/v1/scopes/{qualified_name}/submit' : '/v1/scopes/{qualified_name}/amend';
      return ok(await client.POST(path, { params: { path: { qualified_name: qn }, header: { 'Idempotency-Key': `${path}:${qn}:${Date.now()}` } } } as never));
    },
    async addScopeGroup(qn, name) { return ok(await client.POST('/v1/scopes/{qualified_name}/groups', { params: { path: { qualified_name: qn }, header: { 'Idempotency-Key': `g:${qn}:${name}:${Date.now()}` } }, body: { name } } as never)); },
    async addScopeElement(qn, group, name, definition) { return ok(await client.POST('/v1/scopes/{qualified_name}/groups/{group}/elements', { params: { path: { qualified_name: qn, group }, header: { 'Idempotency-Key': `e:${group}:${name}:${Date.now()}` } }, body: { name, definition } } as never)); },
    async linkScopeElement(qn, link) { return ok(await client.POST('/v1/scopes/{qualified_name}/links', { params: { path: { qualified_name: qn }, header: { 'Idempotency-Key': `l:${link.element}:${link.target}:${Date.now()}` } }, body: link } as never)); },
    async datasets(i) { return ok(await client.GET('/v1/integrations/{qualified_name}/datasets', { params: { path: { qualified_name: i } } })); },
    async saveDataset(i, qn, input) {
      if (qn) return ok(await client.PATCH('/v1/datasets/{qualified_name}', { params: { path: { qualified_name: qn }, header: { 'Idempotency-Key': `d:${qn}:${Date.now()}` } }, body: input } as never));
      return ok(await client.POST('/v1/integrations/{qualified_name}/datasets', { params: { path: { qualified_name: i }, header: { 'Idempotency-Key': `d:${i}:${Date.now()}` } }, body: input } as never));
    },
    async requirementCoverage() { return ok(await client.GET('/v1/requirements/coverage')); },
    async verifyLedger() { return ok(await client.GET('/v1/evidence/verify', { params: { query: {} } } as never)) as never; },
    async nodeEvidence(qn) { return ok(await client.GET('/v1/nodes/{qualified_name}/evidence', { params: { path: { qualified_name: qn }, query: { limit: 50 } } } as never)); },
    async nodeProof(qn) { return ok(await client.GET('/v1/nodes/{qualified_name}/evidence/proof', { params: { path: { qualified_name: qn } } })); },
    async health() { return ok(await client.GET('/v1/health')); },
    async confirmScopeLink(qn, link) { return ok(await client.POST('/v1/scopes/{qualified_name}/links/confirm', { params: { path: { qualified_name: qn } }, body: link } as never)); },
    async setScopeFlows(qn, integrations) { return ok(await client.PUT('/v1/scopes/{qualified_name}/flows', { params: { path: { qualified_name: qn }, header: { 'Idempotency-Key': `f:${qn}:${Date.now()}` } }, body: { integrations } } as never)); },
    async setScopeTier(qn, tier) { return (await raw('PATCH', `/v1/scopes/${encodeURIComponent(qn)}`, { required_tier: tier }, { 'Idempotency-Key': `t:${qn}:${tier}:${Date.now()}` })).body; },
    async saveRequirement(input, dryRun = false) { return ok(await client.POST('/v1/requirements', { params: { query: { dry_run: dryRun }, header: { 'Idempotency-Key': `r:${input.reference_id}:${Date.now()}` } }, body: input } as never)) as ApiRequirementReport; },
    async importRequirements(csv, dryRun = false) { return ok(await client.POST('/v1/requirements/import', { params: { query: { dry_run: dryRun }, header: { 'Idempotency-Key': `ri:${csv.length}:${Date.now()}` } }, body: { csv } } as never)) as ApiRequirementReport; },
    async lineage(qn, direction, depth = 2) { return ok(await client.GET('/v1/nodes/{qualified_name}/lineage', { params: { path: { qualified_name: qn }, query: { direction, depth } } })); },
    async me() { try { return (await raw<AuthUser>('GET', '/v1/auth/me')).body ?? null; } catch (e) { if (e instanceof ApiProblem && e.status === 401) return null; throw e; } },
    async mockLogin(user) { return (await raw<AuthUser>('POST', '/v1/auth/mock-login', user)).body ?? user; },
    async logout() { await raw('POST', '/v1/auth/logout'); },
    async classificationProposals() { const b = (await raw<ClassificationProposal[] | { items?: ClassificationProposal[]; proposals?: ClassificationProposal[] }>('GET', '/v1/classifications/proposals')).body; return Array.isArray(b) ? b : b?.items ?? b?.proposals ?? []; },
    async decideClassification(id, decision) { return (await raw('POST', `/v1/classifications/proposals/${encodeURIComponent(id)}/decision`, { decision }, { 'Idempotency-Key': `cp:${id}:${decision}` })).body; },
    async adminStatus() { return (await raw<AdminStatus>('GET', '/v1/admin/status')).body as AdminStatus; },
    async setEnforcement(paused) { return (await raw('POST', '/v1/admin/enforcement', { paused }, { 'Idempotency-Key': `en:${paused}:${Date.now()}` })).body; },
    async pausePolicy(id, paused) { return (await raw('POST', `/v1/admin/policies/${encodeURIComponent(id)}/pause`, { paused }, { 'Idempotency-Key': `pp:${id}:${paused}:${Date.now()}` })).body; },
    async dashboardMeasures() { const b = (await raw<DashboardMeasure[] | { items?: DashboardMeasure[]; measures?: DashboardMeasure[] }>('GET', '/v1/dashboard/measures')).body; return Array.isArray(b) ? b : b?.items ?? b?.measures ?? []; },
    async history(qn) { return ok(await client.GET('/v1/nodes/{qualified_name}/history', { params: { path: { qualified_name: qn } } })); },
  };
}

const DataContext = createContext<DataSource | undefined>(undefined);
export const DataProvider = ({ source, children }: { source: DataSource; children: ReactNode }) => <DataContext.Provider value={source}>{children}</DataContext.Provider>;
export function useData(): DataSource {
  const d = useContext(DataContext);
  if (!d) throw new Error('No data source: wrap the app in DataProvider');
  return d;
}
export const useOptionalData = (): DataSource | undefined => useContext(DataContext);
