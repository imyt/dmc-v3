import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { DecisionItem } from '@/components/patterns/decision-item';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData, type ApiInbox } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

type Item = ApiInbox['items'][number];
const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');

/** W2. One queue per person. Each item shows what it is about and offers exactly the decisions its step allows. */
export function InboxRoute() {
  const data = useData();
  const [version, setVersion] = useState(0);
  const state = useAsync(() => data.inbox(), [version]);
  const [busy, setBusy] = useState<string>();

  const decide = async (item: Item, decision: string) => {
    if (busy) return;
    setBusy(item.id);
    try {
      await data.decide(item.id, decision, `${item.id}:${decision}`);
      notify({ tone: 'success', title: 'Decision recorded', description: item.title });
      setVersion((v) => v + 1);
    } catch (e) {
      notify({ tone: 'error', title: 'Could not record the decision', description: problem(e) });
    } finally { setBusy(undefined); }
  };

  return (
    <>
      <PageHeader title="Inbox" description="Everything waiting for you or a group you are in." crumbs={[{ label: 'Home', to: '/' }, { label: 'Inbox' }]}
        actions={<Link to="/classifications" className="text-brand-text underline underline-offset-2">Classification proposals</Link>} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-4 px-8 py-6">
        {state.status === 'loading' && <LoadingState label="Loading your inbox" />}
        {state.status === 'error' && <ErrorState message={problem(state.error)} requestId={state.error instanceof ApiProblem ? state.error.requestId : undefined} />}
        {state.status === 'done' && state.value.items.length === 0 && <EmptyState title="Nothing is waiting for you" doing="New items appear here when a policy raises an exception for you." />}
        {state.status === 'done' && state.value.items.map((i) => (
          <DecisionItem key={i.id} onDecide={(_, d) => void decide(i, d)}
            item={{ id: i.id, title: i.title, context: `${i.message} (${i.subject_ref})`, severity: i.severity ?? 'medium', dueAt: i.due_at, escalated: i.escalated, allowed: [...i.decisions].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)) }} />
        ))}
      </div>
    </>
  );
}
const ORDER = ['approve', 'resolve', 'reject', 'accept_risk', 'modify', 'dismiss'];
