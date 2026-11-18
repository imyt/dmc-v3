import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/patterns/status-badge';
import { useOptionalData, type DataSource } from '@/lib/data';

/** ADR 0026: a person is keyed by the staff ID, a string of exactly 8 digits. */
export const STAFF_ID = /^\d{8}$/;
export const looksLikeStaffId = (v: unknown): v is string => typeof v === 'string' && STAFF_ID.test(v);

export interface Person { id: string; name?: string; /** the person has left the organisation: their record is deprecated */ left: boolean }

const cache = new WeakMap<DataSource, Map<string, Promise<Person | undefined>>>();

/** One lookup per person per data source. Anything that is not a Person record (or cannot be read) is simply not known. */
export function lookupPerson(data: DataSource, id: string): Promise<Person | undefined> {
  let m = cache.get(data);
  if (!m) { m = new Map(); cache.set(data, m); }
  let p = m.get(id);
  if (!p) {
    p = data.node(id).then((n): Person | undefined => (n.type === 'Person'
      ? { id, left: n.lifecycle === 'deprecated', ...(typeof n.attributes.name === 'string' && n.attributes.name ? { name: n.attributes.name } : {}) }
      : undefined), () => undefined);
    m.set(id, p);
  }
  return p;
}

/** The people behind these staff IDs, as they become known. */
export function usePeople(ids: string[]): Record<string, Person | undefined> {
  const data = useOptionalData();
  const [found, setFound] = useState<Record<string, Person | undefined>>({});
  const key = [...new Set(ids.filter(looksLikeStaffId))].sort().join(',');
  useEffect(() => {
    if (!data || !key) return;
    let live = true;
    void Promise.all(key.split(',').map((id) => lookupPerson(data, id))).then((ps) => { if (live) setFound(Object.fromEntries(key.split(',').map((id, i) => [id, ps[i]]))); });
    return () => { live = false; };
  }, [data, key]);
  return found;
}

/**
 * A person as the catalog names them: their name when it is known, the staff ID otherwise, and a visible flag when they have left.
 * `role` is the word used in the flag ("Owner", "Delegate", "Steward"), so it reads "Owner has left".
 */
export function PersonRef({ id, role = 'Person' }: { id: string; role?: string }) {
  const p = usePeople([id])[id];
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{p?.name ? `${p.name} (${id})` : id}</span>
      {p?.left && <StatusBadge kind="person" value="left" label={`${role} has left`} />}
    </span>
  );
}

/** Several people (delegates, for example), each with their own flag. */
export function PersonRefs({ ids, role }: { ids: string[]; role?: string }) {
  if (ids.length === 0) return <>None</>;
  return <ul className="flex flex-col gap-1">{ids.map((i) => <li key={i}><PersonRef id={i} role={role} /></li>)}</ul>;
}
