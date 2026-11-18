import { Link, useParams } from '@tanstack/react-router';
import { ObjectPage } from '@/components/patterns/object-page';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { ApiProblem, useData } from '@/lib/data';
import { useAsync } from '@/lib/use-async';
import { toObjectModel } from './model';

/** U1. Any catalog object, by qualified name, rendered from what the API and the metamodel say about it. */
export function ObjectRoute() {
  const { qn } = useParams({ strict: false }) as { qn: string };
  const data = useData();
  const state = useAsync(async () => {
    const [node, out, incoming, history] = await Promise.all([data.node(qn), data.relationships(qn, 'out'), data.relationships(qn, 'in'), data.history(qn)]);
    return toObjectModel(node, out, incoming, history);
  }, [qn]);

  if (state.status === 'loading') return <div className="mx-auto max-w-[var(--content-max)] px-8 py-8"><LoadingState label="Loading object" /></div>;
  if (state.status === 'error') {
    const e = state.error;
    const missing = e instanceof ApiProblem && e.status === 404;
    return <div className="mx-auto max-w-[var(--content-max)] px-8 py-8"><ErrorState message={missing ? 'This object does not exist, or you cannot see it.' : e instanceof ApiProblem ? e.detail : 'The object could not be loaded.'} requestId={e instanceof ApiProblem ? e.requestId : undefined} /></div>;
  }
  const m = state.value;
  return (<>
    <ObjectPage model={m} crumbs={[{ label: 'Home', to: '/' }, { label: m.typeLabel }, { label: m.name }]} onAction={() => {}} />
    {(m.typeLabel === 'Column' || m.typeLabel === 'Table') && <p className="mx-auto max-w-[var(--content-max)] px-8 pb-8"><Link to="/lineage/$qn" params={{ qn }} className="underline">View lineage</Link></p>}
  </>);
}
