import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData, type ClassificationProposal } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');

/** L2. Classifications DMC proposed by following lineage. A steward accepts or rejects each; accepting writes the classification. */
export function ClassificationsRoute() {
  const data = useData();
  const [version, setVersion] = useState(0);
  const state = useAsync(() => data.classificationProposals(), [version]);
  const [busy, setBusy] = useState<string>();

  const decide = async (p: ClassificationProposal, decision: 'accept' | 'reject') => {
    if (busy) return;
    setBusy(p.id);
    try {
      await data.decideClassification(p.id, decision);
      notify({ tone: 'success', title: decision === 'accept' ? 'Classification accepted' : 'Proposal rejected', description: p.subject });
      setVersion((v) => v + 1);
    } catch (e) {
      notify({ tone: 'error', title: 'Could not record the decision', description: problem(e) });
    } finally { setBusy(undefined); }
  };

  const open = state.status === 'done' ? state.value.filter((p) => p.status === 'open') : [];
  return (
    <>
      <PageHeader title="Classification proposals" description="Classifications DMC worked out from lineage, waiting for a steward." crumbs={[{ label: 'Home', to: '/' }, { label: 'Classifications' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-4 px-8 py-6">
        {state.status === 'loading' && <LoadingState label="Loading proposals" />}
        {state.status === 'error' && <ErrorState message={problem(state.error)} requestId={state.error instanceof ApiProblem ? state.error.requestId : undefined} />}
        {state.status === 'done' && open.length === 0 && <EmptyState title="No proposals waiting" doing="DMC follows lineage and proposes classifications here when a source is classified and its target is not." />}
        {open.map((p) => (
          <article key={p.id} aria-label={p.subject} className="border border-border p-4">
            <h3 className="text-lg font-semibold">{p.subject}</h3>
            <p className="mt-1">Proposed classification: <strong>{p.classification}</strong></p>
            <p className="mt-1 text-sm text-muted-foreground">{p.reason}{p.source ? ` (from ${p.source})` : ''}</p>
            <div className="mt-3 flex gap-2">
              <Button isDisabled={busy === p.id} onPress={() => void decide(p, 'accept')} aria-label={`Accept ${p.classification} for ${p.subject}`}>Accept</Button>
              <Button variant="outline" isDisabled={busy === p.id} onPress={() => void decide(p, 'reject')} aria-label={`Reject ${p.classification} for ${p.subject}`}>Reject</Button>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
