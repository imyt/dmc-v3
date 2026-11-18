import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData } from '@/lib/data';
import { edgeRows, emptyGraph, hasNeighbour, mergeLineage, tableLevel, type Graph } from './model';

const Canvas = lazy(() => import('./canvas'));
const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');

/** L5 / P17. Start at one node, expand upstream or downstream when asked, switch between columns and tables, and read the same thing as a table. */
export function LineageRoute({ qn, initialView = 'canvas' }: { qn: string; initialView?: 'canvas' | 'table' }) {
  const data = useData();
  const [graph, setGraph] = useState<Graph>(() => emptyGraph(qn));
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [err, setErr] = useState<unknown>();
  const [view, setView] = useState(initialView);
  const [level, setLevel] = useState<'column' | 'table'>('column');
  const [selected, setSelected] = useState<string>(qn);
  const [busy, setBusy] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const expand = async (node: string, direction: 'upstream' | 'downstream') => {
    setBusy(true);
    try {
      const l = await data.lineage(node, direction, 1);
      setGraph((g) => mergeLineage(g, l)); setTruncated((t) => t || l.truncated.depth || l.truncated.nodes);
      if (l.edges.length === 0) notify({ tone: 'info', title: `Nothing ${direction} of this`, description: node });
    } catch (e) { notify({ tone: 'error', title: 'Could not expand', description: problem(e) }); } finally { setBusy(false); }
  };
  useEffect(() => {
    let live = true;
    setGraph(emptyGraph(qn)); setSelected(qn); setState('loading');
    Promise.all([data.lineage(qn, 'upstream', 1), data.lineage(qn, 'downstream', 1)]).then(([u, d]) => {
      if (!live) return;
      setGraph(mergeLineage(mergeLineage(emptyGraph(qn), u), d)); setTruncated(u.truncated.depth || u.truncated.nodes || d.truncated.depth || d.truncated.nodes); setState('ready');
    }, (e: unknown) => { if (live) { setErr(e); setState('error'); } });
    return () => { live = false; };
  }, [qn, data]);

  const shown = useMemo(() => (level === 'table' ? tableLevel(graph) : graph), [graph, level]);
  const sel = shown.nodes.has(selected) ? selected : shown.root;
  return (
    <>
      <PageHeader title="Lineage" description={`Where ${qn} comes from and where it goes.`} crumbs={[{ label: 'Home', to: '/' }, { label: qn, to: `/o/${qn}` }, { label: 'Lineage' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-4 px-8 py-6">
        {state === 'loading' && <LoadingState label="Loading lineage" />}
        {state === 'error' && <ErrorState message={problem(err)} requestId={err instanceof ApiProblem ? err.requestId : undefined} />}
        {state === 'ready' && (<>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onPress={() => setLevel(level === 'column' ? 'table' : 'column')}>{level === 'column' ? 'Show tables' : 'Show columns'}</Button>
            <Button variant="outline" onPress={() => setView(view === 'canvas' ? 'table' : 'canvas')}>{view === 'canvas' ? 'Table view' : 'Canvas view'}</Button>
            <span className="text-sm text-muted-foreground">{shown.nodes.size} {level === 'column' ? 'columns' : 'tables'}, {shown.edges.size} links{truncated ? ' (the walk was capped; expand to see more)' : ''}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="Selected node">
            <span>Selected: <strong>{sel}</strong></span>
            <Button size="sm" variant="outline" isDisabled={busy} onPress={() => void expand(sel, 'upstream')}>Expand upstream</Button>
            <Button size="sm" variant="outline" isDisabled={busy} onPress={() => void expand(sel, 'downstream')}>Expand downstream</Button>
            <Link to="/o/$qn" params={{ qn: sel }} className="underline">Open</Link>
            {!hasNeighbour(shown, sel, 'upstream') && !hasNeighbour(shown, sel, 'downstream') && <span className="text-muted-foreground">No links loaded for this node yet.</span>}
          </div>
          {view === 'canvas' ? (
            <Suspense fallback={<LoadingState label="Loading the canvas" />}><Canvas graph={shown} selected={sel} onSelect={setSelected} /></Suspense>
          ) : (
            <DataTable label="Lineage links" exportName={`${qn}-lineage`} rowId={(r) => `${r.from}>${r.to}`} rows={edgeRows(shown)}
              empty={{ title: 'No lineage recorded', doing: 'Lineage arrives from the dbt and Airflow jobs; a coding agent can also declare it.' }}
              columns={[{ id: 'f', header: 'From', cell: (r) => <button className="underline" onClick={() => setSelected(r.from)}>{r.from}</button>, text: (r) => r.from },
                { id: 't', header: 'To', cell: (r) => <button className="underline" onClick={() => setSelected(r.to)}>{r.to}</button>, text: (r) => r.to },
                { id: 'j', header: 'Job', cell: (r) => r.job, text: (r) => r.job }, { id: 's', header: 'Source', cell: (r) => r.source, text: (r) => r.source }]} />
          )}
        </>)}
      </div>
    </>
  );
}
