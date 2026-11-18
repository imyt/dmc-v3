import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FieldWithSource, type FieldSource } from './field-with-source';
import { PageHeader, type Crumb } from './page-header';
import { PermissionAction, type AllowedAction } from './permission-action';
import { StatusBadge, type Lifecycle, type Tier } from './status-badge';
import { Timeline, type TimelineEvent } from './timeline';

/**
 * P5. The page is described by data, so any metamodel type renders without type-specific code (U1).
 * The API builds this model from the metamodel; nothing here knows what a "dataset" is.
 */
export interface ObjectModel {
  type: string;
  typeLabel: string;
  name: string;
  state: Lifecycle;
  owner?: string;
  tier?: Tier;
  fields: { id: string; label: string; value: ReactNode; source?: FieldSource; onRequestChange?(): void }[];
  relationships: { id: string; label: string; items: { id: string; label: string; typeLabel: string; href?: string }[] }[];
  controls: { id: string; label: string; status: 'met' | 'not-met' | 'unknown' }[];
  events: TimelineEvent[];
  actions: AllowedAction[];
}

const CONTROL_WORD = { met: 'Met', 'not-met': 'Not met', unknown: 'Not assessed' } as const;

export function ObjectPage({ model, crumbs, onAction }: { model: ObjectModel; crumbs?: Crumb[]; onAction(id: string): void }) {
  const primary = model.actions.find((a) => a.allowed) ?? model.actions[0];
  return (
    <>
      <PageHeader
        eyebrow={model.typeLabel}
        title={model.name}
        crumbs={crumbs}
        description={model.owner ? `Owner: ${model.owner}` : undefined}
        actions={<>
          <StatusBadge kind="state" value={model.state} />
          {model.tier && <StatusBadge kind="tier" value={model.tier} />}
          <PermissionAction action={primary} expected onPress={() => primary && onAction(primary.id)} />
        </>}
      />
      <div className="mx-auto max-w-[var(--content-max)] px-8 py-6">
        <Tabs defaultSelectedKey="overview" aria-label={`${model.name} details`}>
          <TabsList variant="line" aria-label="Sections">
            <TabsTrigger id="overview">Overview</TabsTrigger>
            <TabsTrigger id="relationships">Relationships</TabsTrigger>
            <TabsTrigger id="controls">Controls</TabsTrigger>
            <TabsTrigger id="activity">Activity</TabsTrigger>
          </TabsList>
          <TabsContent id="overview" className="pt-6">
            <dl className="grid max-w-3xl grid-cols-2 gap-x-8">{model.fields.map((f) => <FieldWithSource key={f.id} label={f.label} value={f.value} source={f.source} onRequestChange={f.onRequestChange} />)}</dl>
          </TabsContent>
          <TabsContent id="relationships" className="space-y-6 pt-6">
            {model.relationships.length === 0 && <p className="text-muted-foreground">No relationships yet.</p>}
            {model.relationships.map((r) => (
              <section key={r.id} aria-label={r.label}>
                <h3 className="mb-2 font-semibold">{r.label} ({r.items.length})</h3>
                <ul className="divide-y divide-border border border-border">{r.items.map((i) => <li key={i.id} className="flex justify-between px-3 py-2">{i.href ? <a className="text-brand-text underline underline-offset-2" href={i.href}>{i.label}</a> : i.label}<span className="text-muted-foreground">{i.typeLabel}</span></li>)}</ul>
              </section>
            ))}
          </TabsContent>
          <TabsContent id="controls" className="pt-6">
            {model.controls.length === 0 ? <p className="text-muted-foreground">No controls apply.</p> : (
              <ul className="max-w-2xl divide-y divide-border border border-border">{model.controls.map((c) => <li key={c.id} className="flex justify-between px-3 py-2"><span>{c.label}</span><strong className={c.status === 'met' ? 'text-success' : c.status === 'not-met' ? 'text-destructive' : 'text-muted-foreground'}>{CONTROL_WORD[c.status]}</strong></li>)}</ul>
            )}
          </TabsContent>
          <TabsContent id="activity" className="pt-6"><Timeline events={model.events} /></TabsContent>
        </Tabs>
      </div>
    </>
  );
}
