import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { DownloadSimple, ShieldCheck, ShieldWarning } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { ApiProblem, useData, type ApiEvidence, type ApiProof } from '@/lib/data';
import { verifyProofBundle, type ProofCheck } from './verify-proof';

type Entry = ApiEvidence['items'][number];
type Failure = { message: string; requestId?: string; status?: number };
const problem = (e: unknown): Failure => (e instanceof ApiProblem ? { message: e.detail, requestId: e.requestId, status: e.status } : { message: 'Something went wrong. Try again.' });
const short = (h: string) => `${h.slice(0, 10)}…`;

/** U3. The auditor's view: verify the ledger, trace one object to every entry recorded about it, and export a proof bundle you can check offline. */
export function EvidenceRoute() {
  const data = useData();
  const navigate = useNavigate();
  const { qn: urlQn } = useSearch({ strict: false }) as { qn?: string };
  const [chain, setChain] = useState<{ status: 'idle' | 'running' | 'done' | 'error'; ok?: boolean; checked?: number; bad?: number; reason?: string; error?: Failure }>({ status: 'idle' });
  const [qn, setQn] = useState(urlQn ?? '');
  const [subject, setSubject] = useState<string>();
  /** cursors[i] is the cursor that fetches page i; page 0 has none */
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [trace, setTrace] = useState<{ status: 'idle' | 'loading' | 'done' | 'error'; data?: ApiEvidence; error?: Failure }>({ status: 'idle' });
  const [proof, setProof] = useState<{ status: 'idle' | 'working' | 'done' | 'error'; check?: ProofCheck; bundle?: ApiProof; file?: string; error?: Failure }>({ status: 'idle' });
  const latest = useRef(0);

  const verify = async () => {
    setChain({ status: 'running' });
    try { const r = await data.verifyLedger(); setChain({ status: 'done', ok: r.ok, checked: r.checked, bad: r.first_bad_seq, reason: (r as { reason?: string }).reason }); }
    catch (e) { setChain({ status: 'error', error: problem(e) }); }
  };

  const fetchPage = async (name: string, cursor: string | undefined) => {
    const n = ++latest.current;
    setTrace((t) => ({ status: 'loading', data: t.data }));
    try { const d = await data.nodeEvidence(name, cursor); if (n === latest.current) setTrace({ status: 'done', data: d }); }
    catch (e) { if (n === latest.current) setTrace({ status: 'error', error: problem(e) }); }
  };
  const start = (name: string) => {
    const t = name.trim();
    if (!t) return;
    setSubject(t); setCursors([undefined]); setPage(0); setProof({ status: 'idle' }); setTrace({ status: 'loading' });
    void navigate({ to: '/evidence', search: { qn: t } as never, replace: true });
    void fetchPage(t, undefined);
  };
  const go = (to: number, cursor: string | undefined, next?: string | null) => {
    if (!subject) return;
    if (next) setCursors((c) => { const n = c.slice(0, to + 1); n[to] = next; return n; });
    setPage(to); void fetchPage(subject, cursor);
  };
  useEffect(() => { if (urlQn && urlQn !== subject) { setQn(urlQn); start(urlQn); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [urlQn]);

  const exportProof = async () => {
    if (!subject) return;
    setProof({ status: 'working' });
    try {
      const bundle = await data.nodeProof(subject);
      const check = await verifyProofBundle(bundle);
      const file = `proof-${subject}.json`;
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: file }).click(); URL.revokeObjectURL(url);
      setProof({ status: 'done', check, bundle, file });
    } catch (e) { setProof({ status: 'error', error: problem(e) }); }
  };

  const items = trace.data?.items ?? [];
  const next = trace.data?.next_cursor ?? null;
  const head = proof.bundle?.head as { seq: number; hash: string } | null | undefined;
  return (
    <>
      <PageHeader title="Evidence" description="Prove what happened, to what, and who decided." crumbs={[{ label: 'Home', to: '/' }, { label: 'Evidence' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-8 px-8 py-6">
        <section aria-labelledby="chain" className="space-y-3">
          <h2 id="chain" className="text-lg font-semibold">Ledger integrity</h2>
          <p className="text-sm text-muted-foreground">Recomputes every hash in the ledger, from the first entry to the latest.</p>
          <Button onPress={() => void verify()} isDisabled={chain.status === 'running'}>{chain.status === 'running' ? 'Verifying…' : 'Verify the ledger now'}</Button>
          {chain.status === 'done' && (
            <p role="status" className={`flex items-center gap-2 ${chain.ok ? 'text-success' : 'text-destructive'}`}>
              {chain.ok ? <ShieldCheck aria-hidden className="size-5" /> : <ShieldWarning aria-hidden className="size-5" />}
              {chain.ok ? `The chain is intact: ${chain.checked} entries checked.` : `The chain is broken at entry ${chain.bad ?? 'unknown'}${chain.reason ? `: ${chain.reason}` : ''}.`}
            </p>
          )}
          {chain.status === 'error' && <ErrorState message={chain.error!.message} requestId={chain.error!.requestId} />}
        </section>

        <section aria-labelledby="trace" className="space-y-3">
          <h2 id="trace" className="text-lg font-semibold">Trace an object</h2>
          <p className="text-sm text-muted-foreground">Every ledger entry about one object, oldest first. Enter its qualified name, or <Link to="/search" search={{ q: '' }} className="underline">find it in Search</Link>.</p>
          <form className="flex max-w-xl gap-2" onSubmit={(e) => { e.preventDefault(); start(qn); }}>
            <Input aria-label="Qualified name of the object" value={qn} onChange={(e) => setQn(e.target.value)} placeholder="for example servicenow.APP1" /><Button type="submit">Trace</Button>
          </form>
          {trace.status === 'loading' && !trace.data && <LoadingState label="Loading the trace" />}
          {trace.status === 'error' && <ErrorState message={trace.error!.status === 404 ? `${trace.error!.message}. Check the qualified name.` : trace.error!.message} requestId={trace.error!.requestId} />}
          {trace.data && subject && (
            <div className="space-y-3" aria-busy={trace.status === 'loading'}>
              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" isDisabled={proof.status === 'working'} onPress={() => void exportProof()}><DownloadSimple aria-hidden className="size-4" />{proof.status === 'working' ? 'Exporting…' : 'Export proof bundle'}</Button>
                <span className="text-sm text-muted-foreground">Downloads every entry about {subject} with the chain links between them.</span>
              </div>
              {proof.status === 'error' && <ErrorState message={proof.error!.message} requestId={proof.error!.requestId} />}
              {proof.status === 'done' && proof.check && (
                <div role="status" aria-label="Proof verification" className={`border p-3 text-sm ${proof.check.ok ? 'border-success' : 'border-destructive'}`}>
                  <p className={`flex items-center gap-2 font-semibold ${proof.check.ok ? 'text-success' : 'text-destructive'}`}>
                    {proof.check.ok ? <ShieldCheck aria-hidden className="size-5" /> : <ShieldWarning aria-hidden className="size-5" />}
                    {proof.check.ok ? 'Proof verified' : `Proof failed: ${proof.check.reason}${proof.check.badSeq ? ` at entry ${proof.check.badSeq}` : ''}`}
                  </p>
                  <p className="mt-1">Saved as {proof.file}. {proof.check.ok ? `${proof.check.entries} entries and ${proof.check.links} chain links recompute from their hashes.` : 'Do not rely on this bundle.'}</p>
                  {head && <p className="mt-1 text-muted-foreground">Ledger head at export: entry {head.seq}, hash {short(head.hash)}. Compare it with the audit database copy; this check shows internal consistency only.</p>}
                </div>
              )}
              {items.length === 0 && page === 0 && trace.status === 'done'
                ? <EmptyState title="Nothing recorded yet" doing="DMC has not written any ledger entries about this object. Decisions, actions and exceptions about it appear here as they happen." />
                : <DataTable label="Ledger entries" exportName={`evidence-${subject}-page-${page + 1}`} rowId={(e: Entry) => String(e.seq)} rows={items}
                    paging={{ hasPrevious: page > 0, hasNext: next !== null, onPrevious: () => go(page - 1, cursors[page - 1]), onNext: () => go(page + 1, next ?? undefined, next) }}
                    empty={{ title: 'No more entries', doing: 'This page is empty.' }}
                    columns={[
                      { id: 'seq', header: 'Seq', cell: (e) => e.seq, text: (e) => String(e.seq) },
                      { id: 'k', header: 'Kind', cell: (e) => e.kind, text: (e) => e.kind },
                      { id: 'a', header: 'Actor', cell: (e) => e.actor, text: (e) => e.actor },
                      { id: 'm', header: 'Module', cell: (e) => e.source_module, text: (e) => e.source_module },
                      { id: 'w', header: 'When', cell: (e) => <time dateTime={e.occurred_at}>{e.occurred_at.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}</time>, text: (e) => e.occurred_at },
                      { id: 'd', header: 'Details', cell: (e) => (
                        <details><summary className="cursor-pointer underline">Show<span className="sr-only"> entry {e.seq}</span></summary>
                          <dl className="mt-2 space-y-1 text-xs"><dt className="font-semibold">Subject</dt><dd className="break-all">{e.subject_ref}</dd>
                            <dt className="font-semibold">Payload</dt><dd><pre className="max-w-md overflow-auto bg-muted p-2">{JSON.stringify(e.payload, null, 2)}</pre></dd>
                            <dt className="font-semibold">Hash</dt><dd className="break-all font-mono">{e.hash}</dd><dt className="font-semibold">Previous hash</dt><dd className="break-all font-mono">{e.prev_hash}</dd></dl>
                        </details>), text: (e) => e.subject_ref },
                    ]} />}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
