import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { ApiProblem, useData, type ApiEvidence } from '@/lib/data';

/** U3. Auditor view: check the ledger chain, trace everything recorded about one object, and export a proof bundle. */
export function AuditRoute() {
  const data = useData();
  const [chain, setChain] = useState<{ ok: boolean; checked: number; first_bad_seq?: number }>();
  const [qn, setQn] = useState('');
  const [trace, setTrace] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; page?: ApiEvidence; error?: string }>({ status: 'idle' });
  const [err, setErr] = useState<string>();
  const msg = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');

  const verify = async () => { setErr(undefined); try { setChain(await data.verifyLedger()); } catch (e) { setErr(msg(e)); } };
  const load = async () => {
    if (!qn.trim()) return;
    setTrace({ status: 'loading' });
    try { setTrace({ status: 'done', page: await data.nodeEvidence(qn.trim()) }); } catch (e) { setTrace({ status: 'error', error: msg(e) }); }
  };
  const exportProof = async () => {
    try {
      const proof = await data.nodeProof(qn.trim());
      const url = URL.createObjectURL(new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: `proof-${qn.trim()}.json` }).click(); URL.revokeObjectURL(url);
    } catch (e) { setErr(msg(e)); }
  };
  return (
    <>
      <PageHeader title="Audit" description="Prove what happened, to what, and who decided." crumbs={[{ label: 'Home', to: '/' }, { label: 'Audit' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-8 px-8 py-6">
        {err && <ErrorState message={err} />}
        <section aria-labelledby="chain"><h2 id="chain" className="mb-2 text-lg font-semibold">Ledger integrity</h2>
          <Button onPress={() => void verify()}>Verify the ledger now</Button>
          {chain && <p role="status" className="mt-3">{chain.ok ? `The chain is intact: ${chain.checked} entries checked.` : `The chain is broken at entry ${chain.first_bad_seq}.`}</p>}
        </section>
        <section aria-labelledby="trace"><h2 id="trace" className="mb-2 text-lg font-semibold">Trace an object</h2>
          <form className="flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); void load(); }}>
            <Input aria-label="Qualified name of the object" value={qn} onChange={(e) => setQn(e.target.value)} /><Button type="submit">Trace</Button>
          </form>
          {trace.status === 'loading' && <LoadingState label="Loading the trace" />}
          {trace.status === 'error' && <ErrorState message={trace.error ?? ''} />}
          {trace.status === 'done' && (<div className="mt-4 space-y-3">
            <Button variant="outline" onPress={() => void exportProof()}>Export proof bundle</Button>
            <DataTable label="Ledger entries" exportName={`evidence-${qn.trim()}`} rowId={(e) => String(e.seq)} rows={trace.page!.items}
              empty={{ title: 'Nothing recorded', doing: 'No ledger entries exist for this object.' }}
              columns={[{ id: 'seq', header: 'Seq', cell: (e) => e.seq, text: (e) => String(e.seq) }, { id: 'k', header: 'Kind', cell: (e) => e.kind, text: (e) => e.kind },
                { id: 'a', header: 'Actor', cell: (e) => e.actor, text: (e) => e.actor }, { id: 'w', header: 'When', cell: (e) => e.occurred_at, text: (e) => e.occurred_at }]} />
          </div>)}
        </section>
      </div>
    </>
  );
}
