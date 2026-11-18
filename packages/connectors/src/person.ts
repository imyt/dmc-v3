import type { Registry } from '@dmc/platform';

/**
 * ADR 0026: the Person key is the staff ID, a STRING of exactly 8 digits (leading zeros are part of it). The rule is data: `identity.pattern` of Person in the metamodel.
 * A source gives a person as a staff ID, or as an email address (Collibra, ServiceNow); an email is resolved to the staff ID through the Person's email attribute.
 * A number that is all digits but not 8 long is never padded: it lost its zeros somewhere and only the source can say which person it was.
 */
export const staffIdPattern = (registry: Registry): RegExp => {
  const p = registry.has('Person') ? registry.get('Person').identity.pattern : undefined;
  if (!p) throw new Error('Person has no identity.pattern in the metamodel: the staff ID rule is missing');
  return new RegExp(p);
};

export type PersonRef = { kind: 'staff'; id: string } | { kind: 'email'; email: string } | { kind: 'error'; message: string };

/** Says what a source value is. Pure: it never looks anything up and never changes the digits it was given. */
export function classifyPersonRef(raw: unknown, pattern: RegExp): PersonRef {
  if (typeof raw !== 'string') return { kind: 'error', message: `${JSON.stringify(raw)} is not a staff ID: a staff ID is a string, never a number (leading zeros would be lost)` };
  const v = raw.trim();
  if (pattern.test(v)) return { kind: 'staff', id: v };
  if (/^\d+$/.test(v)) return { kind: 'error', message: `"${v}" is all digits but not a valid staff ID (${pattern.source}): leading zeros have probably been lost at the source. It is not padded; fix it at the source` };
  if (v.includes('@')) return { kind: 'email', email: v.toLowerCase() };
  return { kind: 'error', message: `"${v}" is neither a staff ID (${pattern.source}) nor an email address` };
}

/**
 * email (lower case) -> staff ID, for the Person nodes in a list; an email held by two people is ambiguous and resolves to nothing.
 * A deprecated Person (a leaver) counts only when no active Person has the email (so ownership is not lost), and with `activeOnly` not at all (a new hire may reuse a leaver's email, ADR 0027).
 * A person with no `lifecycle` is treated as active.
 */
export function emailIndex(people: { qualifiedName: string; email?: unknown; lifecycle?: string }[], opts: { activeOnly?: boolean } = {}): Map<string, string | null> {
  const active = new Map<string, string | null>(); const gone = new Map<string, string | null>();
  for (const p of people) {
    if (typeof p.email !== 'string' || !p.email) continue;
    const k = p.email.trim().toLowerCase();
    const m = p.lifecycle === 'deprecated' ? gone : active;
    m.set(k, m.has(k) && m.get(k) !== p.qualifiedName ? null : p.qualifiedName);
  }
  if (!opts.activeOnly) for (const [k, v] of gone) if (!active.has(k)) active.set(k, v);
  return active;
}

/** Staff ID of the person a source value names, or why it cannot be resolved. */
export function resolvePersonRef(raw: unknown, pattern: RegExp, byEmail: Map<string, string | null>): { id: string } | { error: string } {
  const r = classifyPersonRef(raw, pattern);
  if (r.kind === 'staff') return { id: r.id };
  if (r.kind === 'error') return { error: r.message };
  const id = byEmail.get(r.email);
  if (id) return { id };
  return { error: id === null ? `${r.email} is the email of more than one Person: it cannot be resolved to a staff ID` : `no Person has the email ${r.email}: it cannot be resolved to a staff ID` };
}
