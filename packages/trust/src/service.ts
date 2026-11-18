import { writeOutbox, type Queryable } from '@dmc/platform';
import { meetsTier, type Tier, type TrustResult } from './grade.js';

const M = 'trust';
/** JSON with keys in a fixed order: Postgres returns jsonb keys in its own order. */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export interface StoredGrade { subjectRef: string; tier: Tier; requiredTier: Tier; meets: boolean; weakest: string[] }

/** Stores each asset's latest grade. A change (and only a change) is evidenced. */
export class TrustService {
  async record(db: Queryable, subjectRef: string, r: TrustResult, required: Tier, actor = 'system/trust'): Promise<{ changed: boolean; meets: boolean }> {
    const meets = meetsTier(r.tier, required);
    const old = (await db.query<{ tier: string; required_tier: string; dimensions: unknown }>(`select tier, required_tier, dimensions from ${M}.grade where subject_ref = $1`, [subjectRef])).rows[0];
    const same = old && old.tier === r.tier && old.required_tier === required && stable(old.dimensions) === stable(r.dimensions);
    if (same) return { changed: false, meets };
    await db.query('begin');
    try {
      await db.query(
        `insert into ${M}.grade (subject_ref, dimensions, tier, required_tier, weakest) values ($1,$2,$3,$4,$5)
         on conflict (subject_ref) do update set dimensions=$2, tier=$3, required_tier=$4, weakest=$5, computed_at=now()`,
        [subjectRef, JSON.stringify(r.dimensions), r.tier, required, r.weakest]);
      await writeOutbox(db, M, { type: 'trust.graded', subjectRef, actor, payload: { tier: r.tier, required, meets, weakest: r.weakest, ...(old ? { previous: old.tier } : {}) } });
      await db.query('commit');
    } catch (e) { await db.query('rollback'); throw e; }
    return { changed: true, meets };
  }

  async get(db: Queryable, subjectRef: string): Promise<StoredGrade | undefined> {
    const r = (await db.query<{ subject_ref: string; tier: Tier; required_tier: Tier; weakest: string[] }>(`select subject_ref, tier, required_tier, weakest from ${M}.grade where subject_ref = $1`, [subjectRef])).rows[0];
    return r ? { subjectRef: r.subject_ref, tier: r.tier, requiredTier: r.required_tier, meets: meetsTier(r.tier, r.required_tier), weakest: r.weakest } : undefined;
  }
}
