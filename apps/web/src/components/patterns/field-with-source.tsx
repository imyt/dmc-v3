import { Lock } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

export interface FieldSource { tool: string; /** ISO time of the last sync; empty when the tool has never supplied a value */ syncedAt: string }

/** "2026-11-18 03:47", or nothing when there is no usable time (a field the source has not filled in yet has no sync time). */
const syncedOn = (iso: string): string => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') : ''; };

/** P6. A value, where it came from, and when. Synced fields are locked and offer "Request change". */
export function FieldWithSource({ label, value, source, onRequestChange }: { label: string; value: ReactNode; source?: FieldSource; onRequestChange?: () => void }) {
  const locked = Boolean(source);
  return (
    <div className="py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">
        <span className="flex items-center gap-2">
          {value}
          {locked && <Lock aria-label="Synced field, read only" role="img" className="size-3.5 text-muted-foreground" />}
        </span>
        {source && (
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
            <span>Source: {source.tool}</span>
            {syncedOn(source.syncedAt) ? <time dateTime={source.syncedAt}>Synced {syncedOn(source.syncedAt)} UTC</time> : <span>Not synced yet</span>}
            {onRequestChange && <button type="button" onClick={onRequestChange} className="text-brand-text underline underline-offset-2">Request change</button>}
          </span>
        )}
      </dd>
    </div>
  );
}
