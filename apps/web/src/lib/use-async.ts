import { useEffect, useState } from 'react';

export type Async<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'done'; value: T };

/** Runs `load` when `deps` change and ignores answers that arrive late. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    load().then((value) => live && setState({ status: 'done', value }), (error: unknown) => live && setState({ status: 'error', error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
