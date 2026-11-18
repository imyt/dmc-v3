import { ApiError, type Queryable } from '@dmc/platform';
import type { CatalogStore, NodeRecord } from './store.js';

const TYPE = 'Delegation';
const DAY = 86_400_000;
export const MAX_MONTHS = 12;
export const REMIND_DAYS = 14;

export interface DelegationView {
  qualifiedName: string; owner: string; delegate: string; covers: 'one-scope' | 'all-scopes'; scopeQn?: string;
  validFrom: string; validTo: string; reason?: string; ended?: string; remindedOn?: string;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const addMonths = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return isoDay(target);
};

/**
 * Scope delegations (access-control.md): the owner grants named people the right to prepare and submit, for at most 12 months.
 * A delegation is a catalog node, so every grant, revoke and ending is in the ledger through the catalog's outbox.
 * It expires on its own (it is simply not active after `valid_to`), is revoked by its owner, and ends when the source system changes the scope's owner.
 */
export class CatalogDelegations {
  constructor(private readonly store: CatalogStore) {}

  private async view(db: Queryable, n: NodeRecord): Promise<DelegationView> {
    const a = n.attributes;
    const scopeQn = a.covers === 'one-scope' ? (await this.store.namedEdgesOf(db, n.qualifiedName, { name: 'delegates', direction: 'out' }))[0]?.toQn : undefined;
    return {
      qualifiedName: n.qualifiedName, owner: String(a.owner), delegate: String(a.delegate), covers: a.covers as DelegationView['covers'], ...(scopeQn ? { scopeQn } : {}),
      validFrom: String(a.valid_from), validTo: String(a.valid_to), ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
      ...(typeof a.ended_reason === 'string' ? { ended: a.ended_reason } : {}),
      ...(typeof a.reminded_on === 'string' ? { remindedOn: a.reminded_on } : {}),
    };
  }

  /** Delegations that have not been revoked or ended (they may still have expired by date). */
  async all(db: Queryable): Promise<DelegationView[]> {
    const nodes = await this.store.listByType(db, TYPE, { limit: 5000 });
    return Promise.all(nodes.filter((n) => n.lifecycle !== 'deprecated').map((n) => this.view(db, n)));
  }

  /** The people who may act for this scope today. */
  async delegatesOf(db: Queryable, scope: NodeRecord, today = new Date()): Promise<string[]> {
    const day = isoDay(today);
    const owner = scope.attributes.owner;
    const out = new Set<string>();
    for (const d of await this.all(db)) {
      if (d.validFrom > day || d.validTo < day) continue;
      if (d.covers === 'one-scope' ? d.scopeQn === scope.qualifiedName && d.owner === owner : d.owner === owner) out.add(d.delegate);
    }
    return [...out];
  }

  async create(db: Queryable, a: { owner: string; delegate: string; covers: string; scopeQn?: string; validFrom?: string; validTo: string; reason?: string; actor: string; today?: Date }): Promise<DelegationView> {
    const today = isoDay(a.today ?? new Date());
    const problems: { path: string; message: string }[] = [];
    const delegate = a.delegate?.trim?.() ?? '';
    if (!delegate) problems.push({ path: 'delegate', message: 'name the person who receives the delegation' });
    else if (delegate === a.owner) problems.push({ path: 'delegate', message: 'you already own this scope' });
    if (a.covers !== 'one-scope' && a.covers !== 'all-scopes') problems.push({ path: 'covers', message: 'one-scope or all-scopes' });
    if (a.covers === 'one-scope' && !a.scopeQn) problems.push({ path: 'scope', message: 'name the scope' });
    const from = a.validFrom ?? today;
    if (!DATE.test(from)) problems.push({ path: 'valid_from', message: 'a date, YYYY-MM-DD' });
    if (!DATE.test(a.validTo ?? '')) problems.push({ path: 'valid_to', message: 'a date, YYYY-MM-DD' });
    if (problems.length === 0) {
      if (from < today) problems.push({ path: 'valid_from', message: 'cannot be in the past' });
      if (a.validTo <= from) problems.push({ path: 'valid_to', message: 'must be after valid_from' });
      else if (a.validTo > addMonths(from, MAX_MONTHS)) problems.push({ path: 'valid_to', message: `a delegation lasts at most ${MAX_MONTHS} months (until ${addMonths(from, MAX_MONTHS)} from this start)` });
    }
    if (problems.length) throw new ApiError('validation_failed', 'The delegation is not valid', problems);
    const dup = (await this.all(db)).find((d) => d.owner === a.owner && d.delegate === delegate && d.covers === a.covers && d.scopeQn === a.scopeQn && d.validTo >= today);
    if (dup) throw new ApiError('conflict', `${delegate} already has this delegation (${dup.qualifiedName}); revoke it first to change it`);

    const qn = `delegation-${a.covers === 'one-scope' ? a.scopeQn : 'all'}-${delegate}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
    await this.store.applyNode(db, { type: TYPE, qualifiedName: qn, lifecycle: 'confirmed', writer: { kind: 'user' }, actor: a.actor,
      attributes: { owner: a.owner, delegate, covers: a.covers, valid_from: from, valid_to: a.validTo, ...(a.reason ? { reason: a.reason } : {}) } });
    if (a.covers === 'one-scope') await this.store.link(db, { name: 'delegates', fromQn: qn, toQn: a.scopeQn!, source: 'dmc', actor: a.actor });
    return this.view(db, (await this.store.getNode(db, qn))!);
  }

  /** Revoke. Only the owner who granted it. */
  async revoke(db: Queryable, qn: string, by: string, reason: DelegationView['ended'] = 'revoked'): Promise<void> {
    const n = await this.store.getNode(db, qn);
    if (!n || n.type !== TYPE || n.lifecycle === 'deprecated') throw new ApiError('not_found', 'No such active delegation');
    if (reason === 'revoked' && n.attributes.owner !== by) throw new ApiError('forbidden', 'Only the owner who granted a delegation can revoke it');
    await this.store.applyNode(db, { type: TYPE, qualifiedName: qn, attributes: { ended_reason: reason }, writer: { kind: 'user' }, actor: by });
    await this.store.setLifecycle(db, qn, 'deprecated', by);
  }

  /** A scope whose owner changed in the source system no longer honours the old owner's delegations on it. */
  async endForOwnerChange(db: Queryable, actor = 'system/delegations'): Promise<string[]> {
    const ended: string[] = [];
    for (const d of await this.all(db)) {
      if (d.covers !== 'one-scope' || !d.scopeQn) continue;
      const scope = await this.store.getNode(db, d.scopeQn);
      if (scope && scope.attributes.owner !== d.owner) { await this.store.tx(db, () => this.revoke(db, d.qualifiedName, actor, 'owner-changed')); ended.push(d.qualifiedName); }
    }
    return ended;
  }

  /** Record that the owner was reminded, so a closed reminder is not raised again. */
  async markReminded(db: Queryable, qn: string, today = new Date(), actor = 'system/delegations'): Promise<void> {
    await this.store.tx(db, () => this.store.applyNode(db, { type: TYPE, qualifiedName: qn, attributes: { reminded_on: isoDay(today) }, writer: { kind: 'user' }, actor }));
  }

  /** Active delegations that run out within `days` and have not yet been reminded about. */
  async expiring(db: Queryable, today = new Date(), days = REMIND_DAYS): Promise<DelegationView[]> {
    const from = isoDay(today); const to = isoDay(new Date(today.getTime() + days * DAY));
    return (await this.all(db)).filter((d) => d.validTo >= from && d.validTo <= to && !d.remindedOn);
  }
}
