import { Warning, CheckCircle, CircleDashed, DotOutline, Eye, Info, ShieldCheck, XCircle, type Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

/** P10. Colour is never the only signal: every badge has an icon and text. */
export type Lifecycle = 'draft' | 'proposed' | 'active' | 'deprecated' | 'retired';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type PolicyMode = 'shadow' | 'enforced';
export type Tier = 'gold' | 'silver' | 'bronze' | 'unverified';

interface Look { label: string; icon: Icon; className: string }

const STATE: Record<Lifecycle, Look> = {
  draft: { label: 'Draft', icon: CircleDashed, className: 'border-border text-muted-foreground' },
  proposed: { label: 'Proposed', icon: DotOutline, className: 'border-info text-info' },
  active: { label: 'Active', icon: CheckCircle, className: 'border-success text-success' },
  deprecated: { label: 'Deprecated', icon: Warning, className: 'border-warning text-warning' },
  retired: { label: 'Retired', icon: XCircle, className: 'border-border text-muted-foreground' },
};
const SEVERITY: Record<Severity, Look> = {
  low: { label: 'Low', icon: Info, className: 'border-info text-info' },
  medium: { label: 'Medium', icon: Warning, className: 'border-warning text-warning' },
  high: { label: 'High', icon: Warning, className: 'border-destructive text-destructive' },
  critical: { label: 'Critical', icon: XCircle, className: 'border-destructive bg-destructive text-white' },
};
const MODE: Record<PolicyMode, Look> = {
  shadow: { label: 'Shadow', icon: Eye, className: 'border-info text-info' },
  enforced: { label: 'Enforced', icon: ShieldCheck, className: 'border-success text-success' },
};
const TIER: Record<Tier, Look> = {
  gold: { label: 'Gold', icon: ShieldCheck, className: 'border-tier-gold bg-tier-gold text-tier-foreground' },
  silver: { label: 'Silver', icon: ShieldCheck, className: 'border-tier-silver bg-tier-silver text-tier-foreground' },
  bronze: { label: 'Bronze', icon: ShieldCheck, className: 'border-tier-bronze bg-tier-bronze text-tier-foreground' },
  unverified: { label: 'Unverified', icon: CircleDashed, className: 'border-tier-unverified bg-tier-unverified text-tier-foreground' },
};

type Props =
  | { kind: 'state'; value: Lifecycle } | { kind: 'severity'; value: Severity }
  | { kind: 'mode'; value: PolicyMode } | { kind: 'tier'; value: Tier };

export function StatusBadge(p: Props) {
  const table = { state: STATE, severity: SEVERITY, mode: MODE, tier: TIER }[p.kind] as Record<string, Look>;
  const { label, icon: Icon, className } = table[p.value]!;
  return (
    <span data-kind={p.kind} data-value={p.value} className={cn('inline-flex items-center gap-1 rounded-[var(--radius-badge)] border px-1.5 py-0.5 text-xs font-semibold', className)}>
      <Icon aria-hidden className="size-3.5" />{label}
    </span>
  );
}
