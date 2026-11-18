import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Completeness, DataTable, DecisionItem, DiffView, EmptyState, ErrorState, FacetPanel, FieldWithSource, LoadingState, MetricPanel, NotificationSettings, PageHeader, PermissionAction, StatusBadge, Timeline, notify, type FacetSelection, type NotificationPrefs, BulkImport, DateRangeField, EnumField, JobMonitor, LinkPicker, MultiSelectField, ObjectPage, ObjectPicker, PolicyEditor, SidePanelEditor, TextInputField, type ObjectModel } from '@/components/patterns';

const ROWS = [
  { id: 'a1', name: 'Customer master', owner: 'Priya Nair', tier: 'gold' as const },
  { id: 'a2', name: 'Payments ledger', owner: 'Tom Reyes', tier: 'silver' as const },
  { id: 'a3', name: 'Marketing leads', owner: 'Aiko Tan', tier: 'unverified' as const },
];
const MODEL: ObjectModel = {
  type: 'dataset', typeLabel: 'Dataset', name: 'Customer master', state: 'active', owner: 'Priya Nair', tier: 'gold',
  fields: [{ id: 'd', label: 'Description', value: 'Golden record of retail customers' }, { id: 'c', label: 'Criticality', value: 'High', source: { tool: 'ARIS', syncedAt: '2026-11-17T06:30:00Z' }, onRequestChange() {} }],
  relationships: [{ id: 'r1', label: 'Applications', items: [{ id: 'app1', label: 'CRM', typeLabel: 'Application' }] }],
  controls: [{ id: 'k1', label: 'Owner is named', status: 'met' }, { id: 'k2', label: 'Classification recorded', status: 'not-met' }],
  events: [{ id: 'e1', at: '2026-11-17T06:30:00Z', actor: { kind: 'sync', name: 'aris-nightly' }, summary: 'updated criticality' }],
  actions: [{ id: 'edit', label: 'Edit', allowed: true }],
};
const BEFORE = 'scope: retail\nmode: shadow\nowner: priya';
const AFTER = 'scope: retail\nmode: enforced\nowner: priya\nreview: yearly';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-b border-border py-8" data-pattern={id}>
      <h2 id={id} className="mb-4 text-2xl">{title}</h2>
      {children}
    </section>
  );
}

/** Every pattern, in every state, on one page. Used for review, axe tests and (later) visual tests. */
export function Gallery() {
  const [facets, setFacets] = useState<FacetSelection>({});
  const [panel, setPanel] = useState(false);
  const [owner, setOwner] = useState<{ id: string; label: string } | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<NotificationPrefs>({ digest: 'daily', email: true, teams: false });
  return (
    <>
      <PageHeader eyebrow="Design system" title="Pattern gallery" description="Every pattern in its states." crumbs={[{ label: 'Home', to: '/' }, { label: 'Gallery' }]} actions={<Button>Primary action</Button>} />
      <div className="mx-auto max-w-[var(--content-max)] px-8">
        <Section id="p10" title="P10 Status and tier badges">
          <div className="flex flex-wrap gap-2">
            {(['draft', 'proposed', 'active', 'deprecated', 'retired'] as const).map((v) => <StatusBadge key={v} kind="state" value={v} />)}
            {(['low', 'medium', 'high', 'critical'] as const).map((v) => <StatusBadge key={v} kind="severity" value={v} />)}
            {(['shadow', 'enforced'] as const).map((v) => <StatusBadge key={v} kind="mode" value={v} />)}
            {(['gold', 'silver', 'bronze', 'unverified'] as const).map((v) => <StatusBadge key={v} kind="tier" value={v} />)}
          </div>
        </Section>
        <Section id="p6" title="P6 Field with source">
          <dl className="max-w-md">
            <FieldWithSource label="Owner" value="Priya Nair" />
            <FieldWithSource label="Business criticality" value="High" source={{ tool: 'ARIS', syncedAt: '2026-11-17T06:30:00Z' }} onRequestChange={() => {}} />
          </dl>
        </Section>
        <Section id="p20" title="P20 Permission-aware actions">
          <div className="flex gap-6">
            <PermissionAction action={{ id: 'approve', label: 'Approve', allowed: true }} onPress={() => {}} />
            <PermissionAction action={{ id: 'edit', label: 'Edit owner', allowed: false, reason: 'Owner is managed in ARIS' }} onPress={() => {}} expected />
            <PermissionAction action={{ id: 'delete', label: 'Delete', allowed: false }} onPress={() => {}} />
          </div>
        </Section>
        <Section id="p11" title="P11 Activity timeline">
          <Timeline events={[
            { id: '1', at: '2026-11-17T06:30:00Z', actor: { kind: 'sync', name: 'aris-nightly' }, summary: 'updated 12 applications', policyVersion: 'v14', proofHref: '#proof-1' },
            { id: '2', at: '2026-11-16T10:02:00Z', actor: { kind: 'person', name: 'Priya Nair' }, summary: 'approved the scope', proofHref: '#proof-2' },
            { id: '3', at: '2026-11-15T09:00:00Z', actor: { kind: 'agent', name: 'steward-agent' }, summary: 'proposed a link to Customer ID' },
          ]} />
        </Section>
        <Section id="p12" title="P12 Progress and completeness">
          <div className="max-w-md"><Completeness label="Scope submission" steps={[{ label: 'Owner assigned', done: true }, { label: 'Datasets linked', done: true }, { label: 'Business elements linked', done: false }, { label: 'Attestation', done: false }]} /></div>
        </Section>
        <Section id="p18" title="P18 Empty, loading and error states">
          <div className="grid gap-6 md:grid-cols-3">
            <LoadingState label="Loading datasets" />
            <EmptyState title="No exceptions" doing="DMC is checking every sync run against your policies and will list anything that needs a decision here." />
            <ErrorState message="We could not load this scope." requestId="req_8fd2c1" action={<Button>Try again</Button>} />
          </div>
        </Section>
        <Section id="p3" title="P3 Data table">
          <DataTable
            label="Datasets" rows={ROWS} rowId={(r) => r.id} exportName="datasets"
            columns={[
              { id: 'name', header: 'Name', cell: (r) => r.name, text: (r) => r.name, sortable: true },
              { id: 'owner', header: 'Owner', cell: (r) => r.owner, text: (r) => r.owner, sortable: true },
              { id: 'tier', header: 'Trust tier', cell: (r) => <StatusBadge kind="tier" value={r.tier} />, text: (r) => r.tier },
            ]}
            paging={{ hasPrevious: false, hasNext: true, onPrevious() {}, onNext() {}, total: 128 }}
            bulkActions={() => <Button size="sm" variant="outline">Assign owner</Button>}
          />
        </Section>
        <Section id="p4" title="P4 Facet panel">
          <FacetPanel selected={facets} onChange={setFacets} groups={[
            { id: 'type', label: 'Type', values: [{ value: 'dataset', label: 'Dataset', count: 84 }, { value: 'application', label: 'Application', count: 31 }] },
            { id: 'tier', label: 'Trust tier', values: [{ value: 'gold', label: 'Gold', count: 12 }, { value: 'silver', label: 'Silver', count: 40 }] },
          ]} />
        </Section>
        <Section id="p9" title="P9 Inbox and decision item">
          <DecisionItem now={new Date('2026-11-17T12:00:00Z')} onDecide={() => {}} item={{ id: 'x1', title: 'Exception: Payments ledger missing owner', context: 'The nightly sync found no owner for this dataset for 14 days.', recommendation: 'Assign Tom Reyes, the owner of the parent application.', severity: 'high', dueAt: '2026-11-18T12:00:00Z', allowed: ['approve', 'reject', 'modify'] }} />
        </Section>
        <Section id="p16" title="P16 Diff view"><DiffView title="Scope changes" before={BEFORE} after={AFTER} /></Section>
        <Section id="p19" title="P19 Feedback">
          <Button onPress={() => notify({ title: 'Scope submitted', description: 'The owner has been notified.', tone: 'success' })}>Show a toast</Button>
        </Section>
        <Section id="p23" title="P23 Metric panel">
          <MetricPanel title="Critical elements with a named owner" value={92} target={95} delta={3} breakdownLabel="By business line" breakdown={[{ label: 'Retail', value: 97 }, { label: 'Commercial', value: 90 }, { label: 'Markets', value: 85 }]} />
        </Section>
        <Section id="p5" title="P5 Object page"><div className="border border-border"><ObjectPage model={MODEL} onAction={() => {}} /></div></Section>
        <Section id="p7" title="P7 Side panel editor">
          <Button onPress={() => setPanel(true)}>Edit owner</Button>
          <SidePanelEditor title="Edit owner" isOpen={panel} onClose={() => setPanel(false)} dirty={owner !== null} onSave={async () => []}>
            {() => <ObjectPicker label="Owner" value={owner} onChange={setOwner} search={async (q) => [{ id: 'p1', label: 'Priya Nair' }, { id: 'p2', label: 'Tom Reyes' }].filter((o) => o.label.toLowerCase().includes(q.toLowerCase()))} />}
          </SidePanelEditor>
        </Section>
        <Section id="p8" title="P8 Form fields">
          <form className="grid max-w-xl gap-4" onSubmit={(e) => e.preventDefault()}>
            <TextInputField label="Name" value="" onChange={() => {}} required />
            <TextInputField label="Description" value="" onChange={() => {}} multiline />
            <EnumField label="Classification" value="internal" onChange={() => {}} options={[{ value: 'public', label: 'Public' }, { value: 'internal', label: 'Internal' }, { value: 'restricted', label: 'Restricted' }]} />
            <MultiSelectField label="Scopes" value={scopes} onChange={setScopes} options={[{ value: 'aris', label: 'ARIS' }, { value: 'rris', label: 'RRIS' }]} />
            <DateRangeField label="Review period" />
          </form>
        </Section>
        <Section id="p13" title="P13 Link picker">
          <LinkPicker label="Link columns" onConfirm={() => {}} candidates={[{ id: 'c1', label: 'customer_id', group: 'customers' }, { id: 'c2', label: 'email', group: 'customers' }, { id: 'c3', label: 'amount', group: 'payments' }]} />
        </Section>
        <Section id="p14" title="P14 Bulk import">
          <BulkImport fields={[{ id: 'name', label: 'Name', required: true }, { id: 'owner', label: 'Owner' }]} onCommit={async () => {}} />
        </Section>
        <Section id="p15" title="P15 Policy editor">
          <PolicyEditor initialYaml={'id: owner-required\nmode: shadow'} validate={async () => []} dryRun={async () => [{ subject: 'Payments ledger', outcome: 'escalate', reason: 'No owner for 14 days' }]} onOpenPullRequest={() => {}} />
        </Section>
        <Section id="p22" title="P22 Job monitor">
          <JobMonitor onRunNow={() => {}} onTogglePause={() => {}} jobs={[
            { id: 'j1', name: 'aris-nightly', environment: 'prod', status: 'succeeded', lastRunAt: '2026-11-17T06:30:00Z', counts: { created: 2, updated: 12, unchanged: 400, deprecated: 0 }, paused: false },
            { id: 'j2', name: 'rris-weekly', environment: 'uat', status: 'failed', lastRunAt: '2026-11-16T02:00:00Z', error: 'Source returned 503', paused: false },
          ]} />
        </Section>
        <Section id="p24" title="P24 Notification settings"><NotificationSettings value={prefs} onChange={setPrefs} /></Section>
      </div>
    </>
  );
}
