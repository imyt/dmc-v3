import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/patterns/page-header';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');
type Ask = { title: string; body: string; run: () => Promise<unknown>; done: string };

/** U2. What is running, the kill switch for all enforcement, and a pause per policy. Every switch asks for confirmation; the API records who did it. */
export function AdminRoute() {
  const data = useData();
  const [version, setVersion] = useState(0);
  const s = useAsync(() => data.adminStatus(), [version]);
  const [ask, setAsk] = useState<Ask>();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!ask || busy) return;
    setBusy(true);
    try { await ask.run(); notify({ tone: 'success', title: ask.done }); setVersion((v) => v + 1); setAsk(undefined); }
    catch (e) { notify({ tone: 'error', title: 'Could not change it', description: problem(e) }); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Admin" description="What is running, and what can be switched off." crumbs={[{ label: 'Home', to: '/' }, { label: 'Admin' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-6 px-8 py-6">
        {s.status === 'loading' && <LoadingState label="Checking" />}
        {s.status === 'error' && <ErrorState message={problem(s.error)} requestId={s.error instanceof ApiProblem ? s.error.requestId : undefined} />}
        {s.status === 'done' && (() => {
          const st = s.value; const paused = st.enforcement === 'paused';
          return (<>
            <p>Version {st.version}, metamodel {st.metamodel_version}.</p>
            <section aria-labelledby="ks" className="space-y-2 border border-border p-4">
              <h2 id="ks" className="text-lg font-semibold">Enforcement</h2>
              <p>Enforcement is <strong>{paused ? 'paused' : 'running'}</strong>. {paused ? 'Policies still observe and record, but no task is enforced.' : 'Pausing stops every enforced policy from acting; observation continues.'}</p>
              <Button variant={paused ? 'default' : 'destructive'}
                onPress={() => setAsk({ title: paused ? 'Resume enforcement?' : 'Pause all enforcement?', body: paused ? 'Enforced policies start acting again.' : 'No enforced policy will act until you resume. This is recorded in the ledger.', run: () => data.setEnforcement(!paused), done: paused ? 'Enforcement resumed' : 'Enforcement paused' })}>
                {paused ? 'Resume enforcement' : 'Pause all enforcement'}
              </Button>
            </section>
            <section aria-labelledby="pp" className="space-y-2">
              <h2 id="pp" className="text-lg font-semibold">Policies</h2>
              {st.policies.length === 0 && <p className="text-sm text-muted-foreground">No policies are loaded.</p>}
              <ul className="divide-y divide-border border border-border">
                {st.policies.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-2">
                    <span><strong>{p.id}</strong> <span className="text-sm text-muted-foreground">{p.mode}{p.paused ? ', paused' : ''}</span></span>
                    <Button variant="outline" aria-label={`${p.paused ? 'Resume' : 'Pause'} policy ${p.id}`}
                      onPress={() => setAsk({ title: `${p.paused ? 'Resume' : 'Pause'} ${p.id}?`, body: p.paused ? 'The policy acts again on its next run.' : 'The policy stops acting until resumed. This is recorded in the ledger.', run: () => data.pausePolicy(p.id, !p.paused), done: p.paused ? 'Policy resumed' : 'Policy paused' })}>
                      {p.paused ? 'Resume' : 'Pause'}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          </>);
        })()}
      </div>
      <Dialog isOpen={!!ask} onOpenChange={(o) => { if (!o) setAsk(undefined); }} showCloseButton={false}>
        <DialogHeader><DialogTitle>{ask?.title}</DialogTitle><DialogDescription>{ask?.body}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onPress={() => setAsk(undefined)}>Cancel</Button>
          <Button isDisabled={busy} onPress={() => void confirm()}>Confirm</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
