import { Link } from '@tanstack/react-router';
import { PageHeader } from '@/components/patterns/page-header';
import { visibleItems, type Role } from '@/components/patterns/app-shell/nav-config';
import { EmptyState, LoadingState } from '@/components/patterns/states';
import { StatusBadge, type Severity } from '@/components/patterns/status-badge';
import { useOptionalData, type ApiInbox } from '@/lib/data';
import { useAsync } from '@/lib/use-async';
import { ROLES } from '@/features/help/help-route';

/** What each destination is for, in the words of the PRD. Destinations the person's roles do not include are not shown. */
const PURPOSE: Record<string, string> = {
  '/search': 'Find any application, column, term or scope by name.',
  '/inbox': 'Exceptions and tasks waiting for you. Decide each in one action.',
  '/catalog': 'Browse everything DMC holds, type by type.',
  '/scopes': 'Reports and processes, the data behind them and who still owes a link.',
  '/requirements': 'Control requirements and the policies that implement them.',
  '/classifications': 'Classification proposals waiting for a steward.',
  '/policies': 'The rules DMC applies, in shadow or enforced.',
  '/dashboard': 'Progress against the success targets.',
  '/audit': 'Trace a decision and verify the ledger.',
  '/evidence': 'Trace a decision and verify the ledger.',
  '/admin': 'Versions, kill switches and sync jobs.',
};
const SEVERITY: Severity[] = ['critical', 'high', 'medium', 'low'];
type Item = ApiInbox['items'][number];

/** Most urgent first: escalated, then by severity, then by due date. */
export const mostUrgent = (items: Item[]): Item[] => [...items].sort((a, b) =>
  Number(b.escalated) - Number(a.escalated)
  || SEVERITY.indexOf(a.severity ?? 'medium') - SEVERITY.indexOf(b.severity ?? 'medium')
  || (a.due_at ?? '9999').localeCompare(b.due_at ?? '9999'));

const dueText = (due: string | undefined, now = new Date()) => {
  if (!due) return 'No deadline';
  const h = Math.round((new Date(due).getTime() - now.getTime()) / 36e5);
  return h < 0 ? `Overdue by ${-h} h` : h < 48 ? `Due in ${h} h` : `Due in ${Math.round(h / 24)} days`;
};

const Band = ({ children }: { children: React.ReactNode }) => <div className="mx-auto max-w-[var(--content-max)] space-y-10 px-8 py-8">{children}</div>;

export function Home() {
  const data = useOptionalData();
  if (!data) return <><PageHeader title="Data Management Centre" description="Search for anything, or open your inbox to see what needs a decision." /><Band><p className="text-sm">New here? <Link to="/help" className="underline">Read the help page for your role</Link>.</p></Band></>;
  return <HomeForPerson />;
}

/** The first screen: what needs you, then the screens your roles give you. */
function HomeForPerson() {
  const data = useOptionalData()!;
  const me = useAsync(async () => { try { return await data.me(); } catch { return null; } }, []);
  const inbox = useAsync(async () => data.inbox(), []);
  const roles: Role[] | 'all' = me.status === 'done' && me.value?.roles ? (me.value.roles as Role[]) : 'all';
  const items = visibleItems(roles).filter((i) => i.to !== '/');
  // two nav entries can lead to the same screen while a route is being renamed; show each purpose once
  const tiles = items.filter((i, ix) => items.findIndex((o) => PURPOSE[o.to] === PURPOSE[i.to]) === ix || !PURPOSE[i.to]);
  const helpRoles = (roles === 'all' ? [] : roles).filter((r): r is keyof typeof ROLES => r in ROLES);
  const name = me.status === 'done' && me.value ? me.value.displayName : undefined;

  return (
    <>
      <PageHeader title="Data Management Centre" description={name ? `Welcome, ${name}. Search for anything, or start with what is waiting for you.` : 'Search for anything, or start with what is waiting for you.'} />
      <Band>
        <section aria-labelledby="attention">
          <h2 id="attention" className="mb-3 text-2xl font-semibold">Needs your attention</h2>
          {inbox.status === 'loading' && <LoadingState label="Checking your inbox" rows={2} />}
          {inbox.status === 'error' && <p className="text-muted-foreground">Your inbox could not be loaded. <Link to="/inbox" className="underline">Open it directly</Link>.</p>}
          {inbox.status === 'done' && inbox.value.items.length === 0 && <EmptyState title="Nothing needs your attention right now" doing="DMC applies the policies and records the evidence on its own. Items arrive in your inbox only when a person has to decide." />}
          {inbox.status === 'done' && inbox.value.items.length > 0 && (<>
            <p className="mb-3"><strong>{inbox.value.count}</strong> {inbox.value.count === 1 ? 'item is' : 'items are'} waiting for you. <Link to="/inbox" className="text-brand-text underline underline-offset-2">Open your inbox</Link></p>
            <ul className="divide-y divide-border border border-border">
              {mostUrgent(inbox.value.items).slice(0, 3).map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0"><Link to="/inbox" className="font-semibold text-brand-text underline underline-offset-2">{i.title}</Link><div className="text-sm text-muted-foreground">{i.message}</div></div>
                  <div className="flex items-center gap-3 text-sm">{i.escalated && <strong>Escalated</strong>}<StatusBadge kind="severity" value={i.severity ?? 'medium'} /><span className="text-muted-foreground">{dueText(i.due_at)}</span></div>
                </li>))}
            </ul>
          </>)}
        </section>

        <section aria-labelledby="screens">
          <h2 id="screens" className="mb-3 text-2xl font-semibold">Your screens</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tiles.map((i) => (
              <li key={i.to}>
                <Link to={i.to} className="flex h-full gap-3 border border-border p-4 hover:bg-muted">
                  <i.icon aria-hidden className="mt-1 size-6 shrink-0 text-brand-text" />
                  <span><span className="block text-lg font-semibold">{i.label}</span><span className="block text-sm text-muted-foreground">{PURPOSE[i.to] ?? ''}</span></span>
                </Link>
              </li>))}
          </ul>
        </section>

        <p className="text-sm">New here? {helpRoles.length > 0
          ? helpRoles.map((r, n) => <span key={r}>{n > 0 ? ', ' : ''}<Link to="/help/$role" params={{ role: r }} className="underline">Read the help page for {ROLES[r].title.toLowerCase()}s</Link></span>)
          : <Link to="/help" className="underline">Read the help page for your role</Link>}.</p>
      </Band>
    </>
  );
}

export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <PageHeader eyebrow="Coming soon" title={title} />
      <div className="mx-auto max-w-[var(--content-max)] px-8 py-8"><p className="text-muted-foreground">This area is built in a later task.</p></div>
    </>
  );
}
