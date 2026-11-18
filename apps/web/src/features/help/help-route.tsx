import { Link } from '@tanstack/react-router';
import { PageHeader } from '@/components/patterns/page-header';

export const ROLES = {
  'app-owner': { title: 'Application owner', steps: ['Open your inbox: link tasks and exceptions for your applications wait there.', 'Add the datasets each of your integrations carries, with category and record class.', 'Link business elements of submitted scopes to your columns, then say you are done.'], first: { to: '/inbox', label: 'Open your inbox' } },
  'scope-owner': { title: 'Scope owner', steps: ['Create groups of business elements and say which integrations the data flows through.', 'Submit the scope: it locks and application owners get their tasks.', 'Amend it later to make the next version; earlier versions stay on record.'], first: { to: '/scopes', label: 'Open your scopes' } },
  steward: { title: 'Data steward', steps: ['Look after the glossary of your domain: categories and terms.', 'Resolve exceptions routed to you from your inbox.'], first: { to: '/search', label: 'Search the catalogue' } },
  auditor: { title: 'Auditor', steps: ['Verify the ledger chain whenever you need to.', 'Trace one object to see every recorded step and who decided.', 'Export a proof bundle you can check offline.'], first: { to: '/evidence', label: 'Open evidence' } },
  admin: { title: 'Administrator', steps: ['Check the running version and the metamodel in use.', 'Policies are paused through the policy console once it is available.'], first: { to: '/admin', label: 'Open admin' } },
} as const;
export type Role = keyof typeof ROLES;

/** U7. One help page per role; each role's first screen links here. */
export function HelpRoute({ role }: { role: string }) {
  const r = (ROLES as Record<string, (typeof ROLES)[Role]>)[role];
  return (
    <>
      <PageHeader title={r ? `Help for ${r.title.toLowerCase()}s` : 'Help'} crumbs={[{ label: 'Home', to: '/' }, { label: 'Help' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-4 px-8 py-6">
        {r ? (<>
          <ol className="list-decimal space-y-2 pl-5">{r.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <Link to={r.first.to} className="underline">{r.first.label}</Link>
        </>) : (<>
          <p>Pick the role that describes your work.</p>
          <ul className="list-disc pl-5">{Object.entries(ROLES).map(([k, v]) => <li key={k}><Link to="/help/$role" params={{ role: k }} className="underline">{v.title}</Link></li>)}</ul>
        </>)}
      </div>
    </>
  );
}
