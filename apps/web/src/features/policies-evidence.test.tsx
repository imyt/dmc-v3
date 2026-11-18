import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import { ApiProblem, type ApiPolicyReport, type DataSource } from '@/lib/data';
import { canonical } from '@/features/evidence/verify-proof';
import { buildRows } from '@/features/policies/policies-route';
import { seededPolicies, seededPolicyDetails } from './policies-fixtures';
import { setTopLevel, topLevel } from '@/features/policies/policy-yaml';

// ---- fixtures: what the API returns for the seeded policies, requirements and ledger -------------------------------------------------
// what the local API returned for the six seeded policies; every one that implements a TCR points at one that is not registered yet (only DM-1 and DM-2 are)
const status = { version: '0.0.0', metamodel_version: '29 types, 9a6f04cf', enforcement: 'running' as const, policies: seededPolicies.map((p) => ({ id: p.id, mode: p.mode, paused: p.paused })) };
const coverage = { items: [
  { reference_id: 'DM-1', title: 'Every integration is linked to at least one dataset', kind: 'technical-control-requirement', version: 1, qualified_name: 'req-dm-1', status: 'none' as const, policies: [] },
  { reference_id: 'DM-2', title: 'Every application has an owner', kind: 'operating-instruction', version: 1, qualified_name: 'req-dm-2', status: 'none' as const, policies: [] }],
  summary: { none: 2, shadow_only: 0, enforced: 0 }, unknown_references: [
    { policy: 'classification-proposed', implements: 'TCR-0005' }, { policy: 'cross-border-covered', implements: 'TCR-0004' }, { policy: 'integration-has-dataset', implements: 'TCR-0001' }, { policy: 'required-trust-tier', implements: 'TCR-0003' }] };
const okReport: ApiPolicyReport = { ok: true, problems: [], cases: [{ name: 'missing owner matches', pass: true }, { name: 'owner present does not match', pass: true }], conflicts: [],
  policy: { id: 'integration-has-dataset', control: 'ownership', mode: 'shadow', type: 'Integration', implements: 'TCR-0001' },
  dryRun: { type: 'Integration', sampled: 6, matched: 2, errors: 1, matches: ['int-1', 'int-2'], note: 'Evaluated on each sampled asset’s own attributes.' } };
const badReport: ApiPolicyReport = { ok: false, problems: ['/control must be string'], cases: [], conflicts: [] };
const conflictReport: ApiPolicyReport = { ...okReport, ok: false, conflicts: [{ a: 'integration-has-dataset', b: 'other-policy', reason: 'both set owner ("a" vs "b")', overlap: 'confirmed' }] };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** a proof bundle built the way the ledger builds it (ADR 0017), so the browser check has real hashes to recompute */
function proof(n = 2, tamper = false) {
  const entries: Record<string, unknown>[] = []; const chain: { seq: number; payloadHash: string; hash: string }[] = [];
  let prev = '0'.repeat(64);
  for (let i = 0; i < n; i++) {
    const seq = 26 + i; const f = { kind: i === 0 ? 'node.created' : 'edge.created', subjectRef: 'node/abc', actor: 'seed', sourceModule: 'catalog', sourceId: seq, occurredAt: '2026-11-18T03:47:50.663Z', payload: { changed: ['name'] } };
    const payloadHash = sha(canonical(f)); const hash = sha(`${prev}|${payloadHash}|${seq}`);
    entries.push({ seq, ...f, payloadHash, prevHash: prev, hash }); chain.push({ seq, payloadHash, hash }); prev = hash;
  }
  if (tamper) (entries[0]!.payload as { changed: string[] }).changed = ['owner'];
  return { version: 1 as const, subjects: ['node/abc', 'Application:app-a'], exportedAt: '2026-11-18T08:00:00.000Z', entries, chain, anchorPrev: '0'.repeat(64), head: { seq: 173, hash: chain.at(-1)!.hash } };
}
const entry = (seq: number, kind = 'decision.made') => ({ seq, kind, subject_ref: 'Application:app-a', actor: '43000003', source_module: 'decision', occurred_at: '2026-11-18T03:47:50.663Z', payload: { outcome: 'approved' }, payload_hash: 'p'.repeat(64), prev_hash: 'a'.repeat(64), hash: 'b'.repeat(64) });

const author = { displayName: 'Polly', staffID: '43000006', groups: ['dmc-policy-author'], roles: ['policy-author', 'viewer'] };
const admin = { displayName: 'Anil', staffID: '43000009', groups: ['dmc-platform-admin'], roles: ['admin', 'viewer'] };
const auditor = { displayName: 'Ava', staffID: '43000008', groups: ['dmc-auditor'], roles: ['auditor', 'viewer'] };
const forbidden = () => new ApiProblem(403, 'Needs one of: admin, on an object you are responsible for');

const fake = (over: Record<string, unknown> = {}) => ({
  me: async () => author, listPolicies: async () => seededPolicies, getPolicy: async (id: string) => seededPolicyDetails[id]!, adminStatus: async () => { throw forbidden(); }, requirementCoverage: async () => coverage,
  checkPolicy: async () => okReport, proposePolicy: async () => ({ id: 'policies-2026-11-18-38f3290c', url: 'file://C:\\projects\\dmc\\pull-requests\\policies-2026-11-18-38f3290c', report: okReport }),
  verifyLedger: async () => ({ ok: true, checked: 173 }), nodeEvidence: async () => ({ items: [entry(1)], next_cursor: null }), nodeProof: async () => proof(),
  search: async () => ({ hits: [], facets: { type: {}, lifecycle: {} }, facets_sampled: false }), inbox: async () => ({ items: [], count: 0 }),
  ...over,
}) as unknown as DataSource;
const mount = async (ds: DataSource, path: string) => {
  const router = buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />); await screen.findByRole('banner'); return router;
};
afterEach(() => vi.restoreAllMocks());

describe('P3 policies: list', () => {
  const rowsOf = async () => within(await screen.findByRole('grid', { name: 'Policies' })).getAllByRole('row');
  it('a policy author sees all six seeded policies with mode, requirement and paused state', async () => {
    await mount(fake(), '/policies');
    const rows = await rowsOf();
    expect(rows).toHaveLength(7); // header + 6
    expect(within(rows[1]!).getByText('application-has-owner')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Enforced')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Running')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('None declared')).toBeInTheDocument();
    expect(within(rows[5]!).getByText('integration-has-dataset')).toBeInTheDocument();
    expect(within(rows[5]!).getByText('Shadow')).toBeInTheDocument();
    expect(within(rows[5]!).getByText(/TCR-0001/)).toBeInTheDocument();
    expect(screen.queryByText('Not shown')).toBeNull();
    expect(screen.queryByText(/cannot see which policies are paused/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });
  it('shows a paused policy and one this environment does not run, without the admin status (U2)', async () => {
    const list = seededPolicies.map((p) => (p.id === 'classification-proposed' ? { ...p, paused: true } : p.id === 'cross-border-covered' ? { ...p, effective: false } : p.id === 'application-has-owner' ? { ...p, mode: 'shadow' as const } : p));
    await mount(fake({ listPolicies: async () => list }), '/policies');
    const rows = await rowsOf();
    expect(within(rows[2]!).getByText('Paused')).toBeInTheDocument();
    expect(within(rows[4]!).getByText('Not in force here')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('file says enforced')).toBeInTheDocument();
  });
  it('marks a requirement as not registered only when the coverage says so', async () => {
    await mount(fake(), '/policies');
    expect(within((await rowsOf())[2]!).getByText('(not registered)')).toBeInTheDocument();
  });
  it('without the coverage the list still shows, and nothing claims a requirement is unregistered', async () => {
    await mount(fake({ requirementCoverage: async () => { throw new ApiProblem(500, 'Database is down'); } }), '/policies');
    const rows = await rowsOf();
    expect(rows).toHaveLength(7);
    expect(within(rows[2]!).getByText(/TCR-0005/)).toBeInTheDocument();
    expect(screen.queryByText('(not registered)')).toBeNull();
  });
  it('an auditor reads the list too', async () => {
    await mount(fake({ me: async () => auditor }), '/policies');
    expect(await rowsOf()).toHaveLength(7);
  });
  it('shows an empty state when no policy is loaded', async () => {
    await mount(fake({ listPolicies: async () => [], requirementCoverage: async () => ({ ...coverage, items: [], unknown_references: [] }) }), '/policies');
    expect(await screen.findByText('No policies loaded')).toBeInTheDocument();
  });
  it('degrades clearly when the list cannot be read: a notice, and the admin status and coverage fill what they can', async () => {
    await mount(fake({ me: async () => admin, listPolicies: async () => { throw new ApiProblem(500, 'Database is down', 'req-1'); }, adminStatus: async () => status }), '/policies');
    expect(await screen.findByText(/The policy list could not be loaded: Database is down/)).toBeInTheDocument();
    expect(await rowsOf()).toHaveLength(7);
  });
  it('without the list and without the status, only the coverage is left, and what is missing says so', async () => {
    await mount(fake({ listPolicies: async () => { throw forbidden(); } }), '/policies');
    expect(await screen.findByText(/The policy list could not be loaded/)).toBeInTheDocument();
    expect(screen.getAllByText('Not shown').length).toBeGreaterThan(0);
    expect(screen.getByText(/cannot see which policies are paused/)).toBeInTheDocument();
  });
  it('an API failure is an error state with the request id', async () => {
    const boom = () => { throw new ApiProblem(500, 'Database is down', 'req-1'); };
    await mount(fake({ listPolicies: boom, adminStatus: boom, requirementCoverage: boom }), '/policies');
    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent('Database is down');
    expect(screen.getByText('req-1')).toBeInTheDocument();
  });
  it('builds one row per policy from the list, and from the status and coverage when there is no list (PRV, TCR references)', () => {
    expect(buildRows(seededPolicies, undefined, coverage).map((r) => [r.id, r.mode, r.paused, r.implements, r.registered])).toEqual([
      ['application-has-owner', 'enforced', false, [], undefined], ['classification-proposed', 'shadow', false, ['TCR-0005'], false], ['critical-app-review', 'shadow', false, [], undefined],
      ['cross-border-covered', 'shadow', false, ['TCR-0004'], false], ['integration-has-dataset', 'shadow', false, ['TCR-0001'], false], ['required-trust-tier', 'shadow', false, ['TCR-0003'], false]]);
    expect(buildRows(seededPolicies, undefined, undefined).every((r) => r.registered === undefined)).toBe(true);
    expect(buildRows(undefined, status, coverage).map((r) => [r.id, r.mode, r.paused, r.implements])).toEqual([
      ['application-has-owner', 'enforced', false, []], ['classification-proposed', 'shadow', false, ['TCR-0005']], ['critical-app-review', 'shadow', false, []],
      ['cross-border-covered', 'shadow', false, ['TCR-0004']], ['integration-has-dataset', 'shadow', false, ['TCR-0001']], ['required-trust-tier', 'shadow', false, ['TCR-0003']]]);
  });
});

describe('P3, P4 policies: edit, validate, dry run, save', () => {
  const open = async (ds: DataSource) => { await mount(ds, '/policies'); await userEvent.click(await screen.findByRole('button', { name: /integration-has-dataset/ })); return screen.findByRole('region', { name: 'Policy integration-has-dataset' }); };

  it('opens a policy: its facts, a form view and the YAML/CEL view with line numbers', async () => {
    const ws = await open(fake());
    expect(within(ws).getByText('Implements TCR-0001')).toBeInTheDocument();
    expect(within(ws).getByLabelText('Policy id')).toHaveValue('integration-has-dataset');
    await userEvent.click(within(ws).getByRole('tab', { name: 'YAML / CEL' }));
    const yaml = within(ws).getByLabelText('Policy (YAML with CEL)') as HTMLTextAreaElement;
    expect(yaml.value).toContain('policy: integration-has-dataset');
    expect(within(ws).getAllByText('1').length).toBeGreaterThan(0);
  });
  it('opens an existing policy with its stored YAML and golden cases, not a template (P3)', async () => {
    const ws = await open(fake());
    const d = seededPolicyDetails['integration-has-dataset']!;
    expect(within(ws).getByLabelText('Control')).toHaveValue('data-movement');
    expect(within(ws).getByText(d.path)).toBeInTheDocument();
    expect(within(ws).getByText(d.checksum.slice(0, 12))).toBeInTheDocument();
    expect(within(ws).queryByRole('note')).toBeNull();
    expect(within(ws).queryByText(/paste the file/i)).toBeNull();
    await userEvent.click(within(ws).getByRole('tab', { name: 'YAML / CEL' }));
    expect((within(ws).getByLabelText('Policy (YAML with CEL)') as HTMLTextAreaElement).value).toBe(d.yaml);
    expect((within(ws).getByLabelText('Golden cases (YAML)') as HTMLTextAreaElement).value).toBe(d.golden);
  });
  it('the stored text is what is checked and proposed (no template text slips in)', async () => {
    const checks: { yaml: string; golden?: string }[] = [];
    const ws = await open(fake({ checkPolicy: async (d: { yaml: string; golden?: string }) => { checks.push(d); return okReport; } }));
    await within(ws).findByText(/Valid: it compiles/, {}, { timeout: 3000 });
    const d = seededPolicyDetails['integration-has-dataset']!;
    expect(checks.at(-1)).toEqual({ yaml: d.yaml, golden: d.golden });
  });
  it('when the stored source cannot be loaded, says so and falls back to a template to paste into', async () => {
    const ws = await open(fake({ getPolicy: async () => { throw new ApiProblem(500, 'The policy file is unreadable', 'req-2'); } }));
    expect(await within(ws).findByRole('alert')).toHaveTextContent('The policy file is unreadable');
    expect(within(ws).getByText(/starts from a template instead/)).toBeInTheDocument();
    expect(within(ws).getByLabelText('Policy id')).toHaveValue('integration-has-dataset');
  });
  it('edits through the form, validates with the server, dry-runs and opens a pull request', async () => {
    const checks: { yaml: string; golden?: string }[] = []; const saved: unknown[] = [];
    const ws = await open(fake({ checkPolicy: async (d: { yaml: string; golden?: string }) => { checks.push(d); return okReport; }, proposePolicy: async (d: unknown) => { saved.push(d); return { id: 'policies-2026-11-18-38f3290c', url: 'file:///x/pull-requests/policies-2026-11-18-38f3290c', report: okReport }; } }));
    const control = within(ws).getByLabelText('Control');
    await userEvent.clear(control); await userEvent.type(control, 'ownership');
    expect(await within(ws).findByText(/Valid: it compiles, 2 golden cases pass/, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(checks.at(-1)!.yaml).toContain('control: ownership');
    expect(checks.at(-1)!.golden).toContain('cases:');

    await userEvent.click(within(ws).getByRole('button', { name: 'Dry run' }));
    const dry = await within(ws).findByRole('region', { name: 'Dry-run report' });
    expect(dry).toHaveTextContent('Dry run over 6 sampled Integration assets');
    expect(dry).toHaveTextContent('2 of 6');
    expect(within(dry).getByText('int-1')).toBeInTheDocument();
    expect(within(dry).getByText('Each match would be recorded only (shadow)')).toBeInTheDocument();
    expect(dry).toHaveTextContent('None found.');

    await userEvent.click(within(ws).getByRole('button', { name: 'Open pull request' }));
    const dialog = await screen.findByRole('dialog');
    const title = within(dialog).getByLabelText('Title');
    expect(title).toHaveValue('Policy integration-has-dataset');
    await userEvent.clear(title); await userEvent.type(title, 'Datasets for every integration');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open pull request' }));
    const result = await within(ws).findByRole('status', { name: 'Pull request' });
    expect(result).toHaveTextContent('policies-2026-11-18-38f3290c');
    expect(result).toHaveTextContent('pull-requests');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ message: 'Datasets for every integration' });
    expect((saved[0] as { yaml: string }).yaml).toContain('control: ownership');
  });
  it('an invalid draft lists its problems and cannot be saved', async () => {
    const ws = await open(fake({ checkPolicy: async () => badReport }));
    expect(await within(ws).findByText('/control must be string', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(within(ws).getByRole('button', { name: 'Open pull request' })).toBeDisabled();
  });
  it('failing golden cases are reported by name', async () => {
    const ws = await open(fake({ checkPolicy: async () => ({ ...okReport, ok: false, cases: [{ name: 'owner present does not match', pass: false, detail: 'expected false, got true' }] }) }));
    expect(await within(ws).findByText(/Golden case "owner present does not match": expected false, got true/, {}, { timeout: 3000 })).toBeInTheDocument();
  });
  it('a conflict with another policy blocks saving and is shown in the dry-run report (P4)', async () => {
    const ws = await open(fake({ checkPolicy: async () => conflictReport }));
    expect(await within(ws).findByText(/Conflicts with other-policy/, {}, { timeout: 3000 })).toBeInTheDocument();
    await userEvent.click(within(ws).getByRole('button', { name: 'Dry run' }));
    const dry = await within(ws).findByRole('region', { name: 'Dry-run report' });
    expect(dry).toHaveTextContent('integration-has-dataset and other-policy: both set owner');
    expect(dry).toHaveTextContent('confirmed overlap');
    expect(within(ws).getByRole('button', { name: 'Open pull request' })).toBeDisabled();
  });
  it('shows what the API said when saving is refused', async () => {
    const ws = await open(fake({ proposePolicy: async () => { throw new ApiProblem(403, 'Policies are written by people'); } }));
    await within(ws).findByText(/Valid:/, {}, { timeout: 3000 });
    await userEvent.click(within(ws).getByRole('button', { name: 'Open pull request' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Open pull request' }));
    expect(await within(ws).findByRole('alert')).toHaveTextContent('Policies are written by people');
    expect(within(ws).queryByRole('status', { name: 'Pull request' })).toBeNull();
  });
  it('a new policy starts from a template', async () => {
    await mount(fake(), '/policies');
    await userEvent.click(await screen.findByRole('button', { name: 'New policy' }));
    const ws = await screen.findByRole('region', { name: 'New policy' });
    expect(within(ws).getByLabelText('Policy id')).toHaveValue('new-policy');
  });
  it('form view edits only the top-level lines of the YAML', () => {
    const y = 'policy: p\ncontrol: c\nmode: shadow\nscope:\n  type: Application\nwhen: "x"\n';
    expect(topLevel(y)).toMatchObject({ policy: 'p', control: 'c', mode: 'shadow', when: '"x"' });
    expect(setTopLevel(y, 'mode', 'enforced')).toContain('mode: enforced\nscope:\n  type: Application');
    expect(setTopLevel(y, 'implements', 'TCR-1')).toContain('mode: shadow\nimplements: TCR-1\nscope:');
    expect(setTopLevel(y, 'control', '')).not.toContain('control:');
  });
});

describe('P3 authorization: policy author role', () => {
  it('an admin, who cannot write policies, reads the stored source read-only, with the reason', async () => {
    const checks = vi.fn(); const saves = vi.fn();
    await mount(fake({ me: async () => admin, checkPolicy: checks, proposePolicy: saves }), '/policies');
    expect(await screen.findByRole('button', { name: 'New policy' })).toBeDisabled();
    expect(screen.getByText('Needs the policy author role')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /application-has-owner/ }));
    const ws = await screen.findByRole('region', { name: 'Policy application-has-owner' });
    expect(await within(ws).findByRole('note')).toHaveTextContent(/needs the policy author role/);
    expect(within(ws).queryByRole('button', { name: 'Open pull request' })).toBeNull();
    expect(within(ws).queryByRole('button', { name: 'Dry run' })).toBeNull();
    const d = seededPolicyDetails['application-has-owner']!;
    const yaml = within(ws).getByLabelText('Policy (YAML with CEL)') as HTMLTextAreaElement;
    expect(yaml.value).toBe(d.yaml); expect(yaml).toHaveAttribute('readonly');
    const golden = within(ws).getByLabelText('Golden cases (YAML)') as HTMLTextAreaElement;
    expect(golden.value).toBe(d.golden); expect(golden).toHaveAttribute('readonly');
    await userEvent.type(yaml, 'x');
    expect(yaml.value).toBe(d.yaml);
    expect(within(ws).queryByLabelText('Policy id')).toBeNull();
    await new Promise((r) => setTimeout(r, 800));
    expect(checks).not.toHaveBeenCalled(); expect(saves).not.toHaveBeenCalled();
  });
  it('an auditor reads a policy without editing it', async () => {
    await mount(fake({ me: async () => auditor }), '/policies');
    await userEvent.click(await screen.findByRole('button', { name: /critical-app-review/ }));
    const ws = await screen.findByRole('region', { name: 'Policy critical-app-review' });
    expect(await within(ws).findByLabelText('Policy (YAML with CEL)')).toHaveAttribute('readonly');
    expect(within(ws).queryByRole('button', { name: 'Open pull request' })).toBeNull();
  });
  it('a reader whose policy source fails to load sees why, not an editor', async () => {
    await mount(fake({ me: async () => auditor, getPolicy: async () => { throw new ApiProblem(403, 'Needs one of: policy-author'); } }), '/policies');
    await userEvent.click(await screen.findByRole('button', { name: /critical-app-review/ }));
    const ws = await screen.findByRole('region', { name: 'Policy critical-app-review' });
    expect(await within(ws).findByRole('alert')).toHaveTextContent('Needs one of: policy-author');
    expect(within(ws).getByText('Source not available')).toBeInTheDocument();
  });
  it('a control owner may write', async () => {
    await mount(fake({ me: async () => ({ ...author, roles: ['control-owner'] }) }), '/policies');
    expect(await screen.findByRole('button', { name: 'New policy' })).toBeEnabled();
  });
});

describe('U3 evidence', () => {
  it('verifies the ledger: intact, and broken at an entry', async () => {
    await mount(fake({ me: async () => auditor }), '/evidence');
    await userEvent.click(await screen.findByRole('button', { name: 'Verify the ledger now' }));
    expect(await screen.findByText(/chain is intact: 173 entries checked/)).toBeInTheDocument();
  });
  it('reports a broken chain with the first bad entry', async () => {
    await mount(fake({ verifyLedger: async () => ({ ok: false, checked: 40, first_bad_seq: 41, reason: 'hash mismatch' }) }), '/evidence');
    await userEvent.click(await screen.findByRole('button', { name: 'Verify the ledger now' }));
    expect(await screen.findByText(/broken at entry 41: hash mismatch/)).toBeInTheDocument();
  });
  it('traces an object to its entries and pages with the cursor, forward and back', async () => {
    const calls: [string, string | undefined][] = [];
    const nodeEvidence = async (qn: string, cursor?: string) => { calls.push([qn, cursor]); return cursor === 'c1' ? { items: [entry(3, 'action.executed')], next_cursor: null } : { items: [entry(1), entry(2, 'exception.raised')], next_cursor: 'c1' }; };
    await mount(fake({ nodeEvidence }), '/evidence');
    await userEvent.type(await screen.findByLabelText('Qualified name of the object'), 'app-a');
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(await screen.findByText('exception.raised')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('action.executed')).toBeInTheDocument();
    expect(screen.queryByText('exception.raised')).toBeNull();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('exception.raised')).toBeInTheDocument();
    expect(calls).toEqual([['app-a', undefined], ['app-a', 'c1'], ['app-a', undefined]]);
  });
  it('shows an entry’s payload and hashes on demand', async () => {
    await mount(fake(), '/evidence?qn=app-a');
    await userEvent.click(await screen.findByText('Show'));
    expect(await screen.findByText(/"outcome": "approved"/)).toBeInTheDocument();
    expect(screen.getByText('b'.repeat(64))).toBeInTheDocument();
  });
  it('the object to trace can come from the address (a link from elsewhere)', async () => {
    const seen: string[] = [];
    await mount(fake({ nodeEvidence: async (qn: string) => { seen.push(qn); return { items: [entry(1)], next_cursor: null }; } }), '/evidence?qn=int-ledger-to-risk');
    expect(await screen.findByText('decision.made')).toBeInTheDocument();
    expect(screen.getByLabelText('Qualified name of the object')).toHaveValue('int-ledger-to-risk');
    expect(seen).toEqual(['int-ledger-to-risk']);
  });
  it('says so when nothing is recorded, and when the object is unknown', async () => {
    await mount(fake({ nodeEvidence: async () => ({ items: [], next_cursor: null }) }), '/evidence?qn=app-b');
    expect(await screen.findByText('Nothing recorded yet')).toBeInTheDocument();
  });
  it('an unknown object is an error state naming the problem', async () => {
    await mount(fake({ nodeEvidence: async () => { throw new ApiProblem(404, 'No nope in the catalog', 'r-9'); } }), '/evidence?qn=nope');
    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent('No nope in the catalog. Check the qualified name.');
  });
  it('exports a proof bundle as a download and shows the verifier result', async () => {
    const create = vi.fn(() => 'blob:x'); const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await mount(fake(), '/evidence?qn=app-a');
    await userEvent.click(await screen.findByRole('button', { name: 'Export proof bundle' }));
    const out = await screen.findByRole('status', { name: 'Proof verification' });
    expect(out).toHaveTextContent('Proof verified');
    expect(out).toHaveTextContent('2 entries and 2 chain links');
    expect(out).toHaveTextContent('Ledger head at export: entry 173');
    expect(create).toHaveBeenCalledTimes(1); expect(click).toHaveBeenCalledTimes(1);
    const blob = (create.mock.calls[0] as unknown as [Blob])[0];
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
    expect(JSON.parse(text).version).toBe(1);
  });
  it('a tampered bundle fails the verifier and is flagged', async () => {
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await mount(fake({ nodeProof: async () => proof(2, true) }), '/evidence?qn=app-a');
    await userEvent.click(await screen.findByRole('button', { name: 'Export proof bundle' }));
    const out = await screen.findByRole('status', { name: 'Proof verification' });
    expect(out).toHaveTextContent('Proof failed: entry content does not match its hash at entry 26');
  });
  it('an export the API refuses is shown, not downloaded', async () => {
    const create = vi.fn(); Object.assign(URL, { createObjectURL: create, revokeObjectURL: () => {} });
    await mount(fake({ nodeProof: async () => { throw new ApiProblem(422, 'These entries span 300000 ledger entries; export is limited to 200000'); } }), '/evidence?qn=app-a');
    await userEvent.click(await screen.findByRole('button', { name: 'Export proof bundle' }));
    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent('export is limited to 200000');
    expect(create).not.toHaveBeenCalled();
  });
  it('a person without the evidence role gets the API’s refusal on verify', async () => {
    await mount(fake({ verifyLedger: async () => { throw new ApiProblem(403, 'Needs one of: control-owner, auditor, admin'); } }), '/evidence');
    await userEvent.click(await screen.findByRole('button', { name: 'Verify the ledger now' }));
    expect(await within(screen.getByRole('main')).findByRole('alert')).toHaveTextContent('Needs one of: control-owner, auditor, admin');
  });
});

describe('navigation: one evidence screen, no stub', () => {
  it('/audit redirects to the evidence screen', async () => {
    const router = await mount(fake(), '/audit');
    expect(await screen.findByRole('heading', { name: 'Evidence', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/evidence');
  });
  it('/catalog redirects to Search', async () => {
    const router = await mount(fake(), '/catalog');
    expect(await screen.findByRole('heading', { name: 'Search', level: 1 })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/search');
    expect(screen.queryByText('Coming soon')).toBeNull();
  });
  it('the Evidence nav item goes to /evidence', async () => {
    await mount(fake(), '/evidence');
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute('href', '/evidence');
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute('aria-current', 'page');
  });
});
