import type { Queryable } from './types';
import { ident } from './provision';

export interface OutboxEvent {
  type: string;
  subjectRef: string;
  actor: string;
  payload: Record<string, unknown>;
}

/** Call inside the same transaction as the state change (ground rule 6). */
export async function writeOutbox(tx: Queryable, moduleName: string, event: OutboxEvent): Promise<number> {
  const r = await tx.query<{ id: string }>(
    `insert into ${ident(moduleName)}.outbox (event_type, subject_ref, actor, payload) values ($1, $2, $3, $4) returning id`,
    [event.type, event.subjectRef, event.actor, JSON.stringify(event.payload)],
  );
  return Number(r.rows[0]!.id);
}

/** Returns true the first time an event id is seen, false on a replay (idempotent consumers). */
export async function markProcessed(tx: Queryable, moduleName: string, eventId: string): Promise<boolean> {
  const r = await tx.query(
    `insert into ${ident(moduleName)}.inbox (event_id) values ($1) on conflict do nothing`,
    [eventId],
  );
  return r.rowCount === 1;
}
