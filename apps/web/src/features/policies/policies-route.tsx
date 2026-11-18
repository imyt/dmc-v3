import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckCircle, Pause, Play, WarningCircle } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { StatusBadge } from '@/components/patterns/status-badge';
import { EnumField, TextInputField } from '@/components/patterns/form-fields';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData, type AdminStatus, type ApiCoverage, type ApiPolicyDetail, type ApiPolicyProposal, type ApiPolicyReport, type ApiPolicySummary, type AuthUser } from '@/lib/data';
import { useAsync } from '@/lib/use-async';
import { SourceEditor } from './source-editor';
import { goldenTemplate, policyTemplate, setTopLevel, topLevel } from './policy-yaml';

const msg = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');
const WRITERS = ['policy-author', 'control-owner'];

export interface PolicyRow {
  id: string; mode?: 'shadow' | 'enforced'; paused?: boolean; implements: string[];
  /** whether the requirement is registered; unknown (undefined) when the coverage could not be read */
  registered?: boolean;
  /** from GET /v1/policies: the policy's source can be opened, the mode the file says, and whether it is in force in this environment */
  fromList?: boolean; sourceMode?: 'shadow' | 'enforced'; effective?: boolean; control?: string;
}

/**
 * One row per policy. With the policy list (GET /v1/policies) every policy is there with its mode, pause state and requirement; the coverage only
 * says whether that requirement is registered. Without it (the caller may not read the list, or it failed) the rows are pieced together from the
 * admin status and the coverage, as before, and the gaps stay blank.
 */
export function buildRows(list: ApiPolicySummary[] | undefined, status: AdminStatus | undefined, cov: ApiCoverage | undefined): PolicyRow[] {
  const known = cov ? new Set(cov.items.map((i) => i.reference_id)) : undefined;
  if (list) {
    return list.map((p) => ({
      id: p.id, mode: p.mode, paused: p.paused, implements: p.implements ? [p.implements] : [], registered: p.implements && known ? known.has(p.implements) : undefined,
      fromList: true, sourceMode: p.source_mode, effective: p.effective, control: p.control,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }
  const rows = new Map<string, PolicyRow>();
  const row = (id: string) => { let r = rows.get(id); if (!r) { r = { id, implements: [], registered: false }; rows.set(id, r); } return r; };
  for (const p of status?.policies ?? []) { const r = row(p.id); r.mode = p.mode as PolicyRow['mode']; r.paused = p.paused; }
  for (const it of cov?.items ?? []) for (const p of it.policies) { const r = row(p.id); r.mode ??= p.mode as PolicyRow['mode']; r.implements.push(it.reference_id); r.registered = true; }
  for (const u of cov?.unknown_references ?? []) { const r = row(u.policy); r.implements.push(u.implements); }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** P3, P4, U2. Every policy with its mode and requirement; open one to write, check, dry-run and save it as a pull request. */
export function PoliciesRoute() {
  const data = useData();
  const load = useCallback(async () => {
    const [me, list, cov] = await Promise.allSettled([data.me(), data.listPolicies(), data.requirementCoverage()]);
    const val = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : undefined);
    // the admin status is only a fallback for when the list cannot be read (and only an administrator can read it)
    const status = list.status === 'rejected' ? await data.adminStatus().then((v) => v, () => undefined) : undefined;
    if (list.status === 'rejected' && !status && cov.status === 'rejected') throw list.reason;
    return { me: val(me) ?? null, list: val(list), listError: list.status === 'rejected' ? list.reason : undefined, status, cov: val(cov) };
  }, [data]);
  const s = useAsync(load, [load]);
  const [open, setOpen] = useState<PolicyRow | 'new'>();

  return (
    <>
      <PageHeader title="Policies" description="What DMC checks, how firmly, and which control requirement each policy implements." crumbs={[{ label: 'Home', to: '/' }, { label: 'Policies' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-6 px-8 py-6">
        {s.status === 'loading' && <LoadingState label="Loading policies" />}
        {s.status === 'error' && <ErrorState message={msg(s.error)} requestId={s.error instanceof ApiProblem ? s.error.requestId : undefined} />}
        {s.status === 'done' && (() => {
          const { me, list, listError, status, cov } = s.value;
          const canWrite = !me?.roles || me.roles.some((r) => WRITERS.includes(r));
          const rows = buildRows(list, status, cov);
          return (<>
            {!list && (
              <div role="alert" className="border border-warning p-3 text-sm">
                <p className="font-semibold">The policy list could not be loaded{listError instanceof ApiProblem ? `: ${listError.detail}` : ''}</p>
                <p>{status || cov ? 'Showing what the status and coverage pages offer: some policies, modes and pause states may be missing, and an existing policy opens from a template, not from its stored source.' : 'Nothing else is available to show.'}</p>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {list ? 'Mode and pause state come from the running system.' : status ? 'Mode and pause state come from the admin status.' : 'Your role cannot see which policies are paused, so that column is blank.'}{' '}
                {canWrite ? 'Policies change only by merge: saving opens a pull request.' : <>You can read policies but not change them: writing needs the policy author role.</>}
              </p>
              {canWrite
                ? <Button onPress={() => setOpen('new')}>New policy</Button>
                : <span className="inline-flex flex-col items-start gap-1"><Button isDisabled aria-describedby="why-new-policy">New policy</Button><span id="why-new-policy" className="text-xs text-muted-foreground">Needs the policy author role</span></span>}
            </div>
            <DataTable label="Policies" exportName="policies" rowId={(r: PolicyRow) => r.id} rows={rows}
              empty={{ title: 'No policies loaded', doing: 'DMC reads policies from the policies repository when it starts. Once one is merged it appears here.' }}
              columns={[
                { id: 'id', header: 'Policy', cell: (r) => <button type="button" className="font-semibold underline" onClick={() => setOpen(r)}>{r.id}<span className="sr-only"> (open)</span></button>, text: (r) => r.id },
                { id: 'mode', header: 'Mode', cell: (r) => (r.mode ? <span className="inline-flex flex-wrap items-center gap-2"><StatusBadge kind="mode" value={r.mode} />{r.sourceMode && r.sourceMode !== r.mode && <span className="text-xs text-muted-foreground">file says {r.sourceMode}</span>}</span> : <span className="text-muted-foreground">Not shown</span>), text: (r) => r.mode ?? '' },
                { id: 'impl', header: 'Implements', cell: (r) => (r.implements.length ? r.implements.map((i, n) => <span key={i}>{n > 0 && ', '}{i}{r.registered === false && <span className="text-muted-foreground"> (not registered)</span>}</span>) : <span className="text-muted-foreground">None declared</span>), text: (r) => r.implements.join('; ') },
                { id: 'paused', header: 'State', cell: (r) => (r.effective === false ? <span className="text-muted-foreground">Not in force here</span> : r.paused === undefined ? <span className="text-muted-foreground">Not shown</span> : r.paused
                  ? <span className="inline-flex items-center gap-1 font-semibold text-warning"><Pause aria-hidden className="size-4" />Paused</span> : <span className="inline-flex items-center gap-1"><Play aria-hidden className="size-4" />Running</span>), text: (r) => (r.effective === false ? 'not in force' : r.paused === undefined ? '' : r.paused ? 'paused' : 'running') },
              ]} />
            {(status || me?.roles?.includes('admin')) && <p className="text-sm">Pause or resume a policy on the <Link to="/admin" className="underline">Admin page</Link>.</p>}
            {open && <PolicyWorkspace key={open === 'new' ? 'new' : open.id} row={open === 'new' ? undefined : open} canWrite={canWrite} me={me} onClose={() => setOpen(undefined)} />}
          </>);
        })()}
      </div>
    </>
  );
}

/** Opens a policy: loads its stored YAML and golden cases first (GET /v1/policies/{id}), then hands them to the editor. */
function PolicyWorkspace({ row, canWrite, me, onClose }: { row?: PolicyRow; canWrite: boolean; me: AuthUser | null; onClose(): void }) {
  const data = useData();
  const fetchable = !!row?.fromList;
  const d = useAsync<ApiPolicyDetail | undefined>(() => (fetchable ? data.getPolicy(row!.id) : Promise.resolve(undefined)), [data, row?.id, fetchable]);
  if (fetchable && d.status === 'loading') return <section aria-label={`Policy ${row!.id}`} className="border border-border p-4"><LoadingState label={`Loading ${row!.id}`} /></section>;
  return <PolicyEditor row={row} detail={d.status === 'done' ? d.value : undefined} detailError={d.status === 'error' ? d.error : undefined} canWrite={canWrite} me={me} onClose={onClose} />;
}

function PolicyEditor({ row, detail, detailError, canWrite, me, onClose }: { row?: PolicyRow; detail?: ApiPolicyDetail; detailError?: unknown; canWrite: boolean; me: AuthUser | null; onClose(): void }) {
  const data = useData();
  const [yaml, setYaml] = useState(() => detail?.yaml ?? policyTemplate(row?.id ?? 'new-policy', { mode: row?.mode, implements: row?.implements[0] }));
  const [golden, setGolden] = useState(() => (detail ? detail.golden ?? '' : goldenTemplate));
  const [report, setReport] = useState<ApiPolicyReport>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string>();
  const [showDry, setShowDry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState(false);
  const [title, setTitle] = useState('');
  const [result, setResult] = useState<ApiPolicyProposal>();
  const [saveError, setSaveError] = useState<string>();
  const top = useMemo(() => topLevel(yaml), [yaml]);

  const run = useCallback(async (y: string, g: string) => {
    setChecking(true); setCheckError(undefined);
    try { setReport(await data.checkPolicy({ yaml: y, golden: g })); } catch (e) { setCheckError(msg(e)); } finally { setChecking(false); }
  }, [data]);
  // validation as you type: a short pause after the last edit, then the server compiles it
  useEffect(() => {
    if (!canWrite || !yaml.trim()) return;
    const t = setTimeout(() => void run(yaml, golden), 600);
    return () => clearTimeout(t);
  }, [yaml, golden, canWrite, run]);
  const edit = (setter: (v: string) => void) => (v: string) => { setter(v); setResult(undefined); setSaveError(undefined); setShowDry(false); };

  const problems = report ? [...report.problems, ...report.cases.filter((c) => !c.pass).map((c) => `Golden case "${c.name}": ${c.detail ?? 'failed'}`)] : [];
  const valid = !!report && report.ok;
  const field = (key: string, label: string, description?: string) => <TextInputField label={label} value={top[key] ?? ''} onChange={edit((v) => setYaml((y) => setTopLevel(y, key, v)))} description={description} />;

  const save = async () => {
    setSaving(true); setSaveError(undefined);
    try { const r = await data.proposePolicy({ yaml, golden, message: title.trim() || undefined }); setResult(r); setAsk(false); notify({ tone: 'success', title: 'Pull request opened', description: r.id }); }
    catch (e) { setSaveError(msg(e)); setAsk(false); }
    finally { setSaving(false); }
  };

  return (
    <section aria-label={row ? `Policy ${row.id}` : 'New policy'} className="space-y-4 border border-border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{row ? row.id : 'New policy'}</h2>
          {row && <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">{row.mode && <StatusBadge kind="mode" value={row.mode} />}{row.implements.length > 0 && <span>Implements {row.implements.join(', ')}</span>}{row.paused && <span className="font-semibold text-warning">Paused</span>}</p>}
        </div>
        <Button variant="outline" onPress={onClose}>Close</Button>
      </div>

      {!canWrite && (
        <div role="note" className="border border-border bg-muted p-3 text-sm">
          <p className="font-semibold">Read-only</p>
          <p>Editing, checking and saving a policy needs the policy author role{me ? ` (you have: ${(me.roles ?? []).join(', ') || 'no roles'})` : ''}. Ask a policy author to open the pull request.</p>
        </div>
      )}
      {detailError !== undefined && (
        <div role="alert" className="border border-warning p-3 text-sm">
          <p className="font-semibold">The stored source of {row?.id} could not be loaded{detailError instanceof ApiProblem ? `: ${detailError.detail}` : ''}</p>
          {canWrite && <p>This starts from a template instead. Paste the file from the policies repository, then edit.</p>}
        </div>
      )}
      {canWrite && row && detailError === undefined && !detail && (
        <div role="note" className="border border-border bg-muted p-3 text-sm">
          The stored source is not available from this list, so this starts from a template for {row.id}. Paste the file from the policies repository, then edit.
        </div>
      )}
      {detail && (
        <p className="text-sm text-muted-foreground">
          Stored in <code>{detail.path}</code>{detail.golden === null ? ', with no golden cases file' : ''}. Version <code title={detail.checksum}>{detail.checksum.slice(0, 12)}</code>.
          {!detail.effective && ' This environment does not run this policy.'}
          {detail.mode !== detail.source_mode && ` The file says ${detail.source_mode}; this environment runs it as ${detail.mode}.`}
        </p>
      )}

      {canWrite ? (
        <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
          <Tabs defaultSelectedKey="form" aria-label="Policy views" className="lg:col-span-2">
            <TabsList variant="line" aria-label="View"><TabsTrigger id="form">Form</TabsTrigger><TabsTrigger id="source">YAML / CEL</TabsTrigger></TabsList>
            <TabsContent id="form">
              <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => e.preventDefault()} aria-label="Policy form">
                {field('policy', 'Policy id', 'Lower case letters, numbers and hyphens. The file is named after it.')}
                {field('control', 'Control')}
                <EnumField label="Mode" value={top.mode === 'enforced' ? 'enforced' : 'shadow'} onChange={edit((v) => setYaml((y) => setTopLevel(y, 'mode', v)))} options={[{ value: 'shadow', label: 'Shadow (records only)' }, { value: 'enforced', label: 'Enforced (acts)' }]} />
                {field('implements', 'Implements requirement', 'The control requirement reference, for example TCR-0001')}
                {field('route', 'Route to')}
                {field('escalate_after', 'Escalate after', 'for example 5d')}
                {field('autonomy', 'Autonomy')}
                <div className="sm:col-span-2">{field('when', 'When (CEL)', 'As written in the YAML. The scope and effect are edited in the YAML view.')}</div>
              </form>
            </TabsContent>
            <TabsContent id="source">
              <div className="grid gap-4 lg:grid-cols-2">
                <SourceEditor id="policy-yaml" label="Policy (YAML with CEL)" value={yaml} onChange={edit(setYaml)} invalid={!!report && !valid} describedBy="policy-issues" />
                <SourceEditor id="policy-golden" label="Golden cases (YAML)" value={golden} onChange={edit(setGolden)} />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      ) : detail ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SourceEditor id="policy-yaml" label="Policy (YAML with CEL)" value={yaml} onChange={() => undefined} readOnly />
          <SourceEditor id="policy-golden" label="Golden cases (YAML)" value={golden || '# no golden cases file'} onChange={() => undefined} readOnly />
        </div>
      ) : (
        <EmptyState title="Source not available" doing="The stored source of this policy could not be loaded, so there is nothing to read here." />
      )}

      {canWrite && (<>
        <div id="policy-issues" role="status" aria-label="Validation" className="text-sm">
          {checking && !report && <p>Checking…</p>}
          {checkError && <ErrorState message={checkError} />}
          {report && (valid
            ? <p className="flex items-center gap-2 text-success"><CheckCircle aria-hidden className="size-5" />Valid: it compiles, {report.cases.length} golden cases pass{report.conflicts.length === 0 ? ', and it conflicts with no other policy' : ''}.{checking && ' Rechecking…'}</p>
            : <div className="text-destructive"><p className="flex items-center gap-2 font-semibold"><WarningCircle aria-hidden className="size-5" />Not valid yet{checking && ' (rechecking…)'}</p>
              <ul className="ml-6 list-disc">{problems.map((p, i) => <li key={i}>{p}</li>)}{report.conflicts.map((c, i) => <li key={`c${i}`}>Conflicts with {c.a === report.policy?.id ? c.b : c.a}: {c.reason}</li>)}</ul></div>)}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" isDisabled={!report || !report.policy || checking} onPress={() => { void run(yaml, golden).then(() => setShowDry(true)); }}>Dry run</Button>
          <Button isDisabled={!valid || checking || saving} onPress={() => { setTitle(`Policy ${report?.policy?.id ?? ''}`.trim()); setAsk(true); }}>Open pull request</Button>
        </div>
        {!valid && <p className="text-xs text-muted-foreground">Open pull request is available once the draft is valid.</p>}

        {showDry && report?.dryRun && (
          <section aria-label="Dry-run report" className="space-y-3 border border-border p-3">
            <h3 className="font-semibold">Dry run over {report.dryRun.sampled} sampled {report.dryRun.type} assets</h3>
            <dl className="grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Would match</dt><dd><strong>{report.dryRun.matched}</strong> of {report.dryRun.sampled}</dd>
              <dt>Could not be evaluated</dt><dd>{report.dryRun.errors}</dd>
              <dt>Outcome</dt><dd>{report.policy?.mode === 'enforced' ? 'Each match would raise the policy’s effect' : 'Each match would be recorded only (shadow)'}</dd>
            </dl>
            {report.dryRun.matches.length > 0 ? <ul className="list-disc pl-5 text-sm">{report.dryRun.matches.map((m) => <li key={m}>{m}</li>)}</ul> : <p className="text-sm text-muted-foreground">No sampled asset matches.</p>}
            <p className="text-xs text-muted-foreground">{report.dryRun.note}</p>
            <h4 className="font-semibold">Conflicts with other policies</h4>
            {report.conflicts.length === 0 ? <p className="text-sm">None found.</p>
              : <ul className="list-disc pl-5 text-sm text-destructive">{report.conflicts.map((c, i) => <li key={i}>{c.a} and {c.b}: {c.reason} ({c.overlap} overlap)</li>)}</ul>}
          </section>
        )}
        {showDry && !report?.dryRun && <p className="text-sm text-muted-foreground">There is no dry run until the policy compiles.</p>}

        {saveError && <ErrorState message={saveError} />}
        {result && (
          <div role="status" aria-label="Pull request" className="space-y-1 border border-success p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold text-success"><CheckCircle aria-hidden className="size-5" />Pull request opened</p>
            <p>Reference <code>{result.id}</code></p>
            <p className="break-all">Location <code>{result.url}</code></p>
            <p className="text-muted-foreground">The dry-run report is attached. The policy takes effect when the pull request is merged.</p>
          </div>
        )}
      </>)}

      <Dialog isOpen={ask} onOpenChange={setAsk} showCloseButton={false}>
        <DialogHeader><DialogTitle>Open a pull request?</DialogTitle><DialogDescription>The policy and its golden cases are proposed as files, with the dry-run report attached. Nothing changes until it is merged.</DialogDescription></DialogHeader>
        <label className="block text-sm">Title<Input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <DialogFooter><Button variant="outline" onPress={() => setAsk(false)}>Cancel</Button><Button isDisabled={saving} onPress={() => void save()}>Open pull request</Button></DialogFooter>
      </Dialog>
    </section>
  );
}
