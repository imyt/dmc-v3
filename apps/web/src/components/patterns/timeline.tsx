import { Robot, ArrowsClockwise, User, UserCheck, type Icon } from '@phosphor-icons/react';

export type ActorKind = 'person' | 'delegate' | 'sync' | 'agent';
export interface TimelineEvent { id: string; at: string; actor: { kind: ActorKind; name: string }; summary: string; policyVersion?: string; proofHref?: string }

const ICON: Record<ActorKind, Icon> = { person: User, delegate: UserCheck, sync: ArrowsClockwise, agent: Robot };
const KIND: Record<ActorKind, string> = { person: 'Person', delegate: 'Delegate', sync: 'Sync job', agent: 'Agent' };

/** P11. Who did what, under which policy version, with a link to the ledger proof. */
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol aria-label="Activity" className="relative space-y-4 border-l border-border pl-6">
      {events.map((e) => {
        const Icon = ICON[e.actor.kind];
        return (
          <li key={e.id} className="relative">
            <span className="absolute -left-[37px] flex size-6 items-center justify-center rounded-full border border-border bg-background"><Icon aria-hidden className="size-3.5" /></span>
            <p><strong>{e.actor.name}</strong> <span className="text-muted-foreground">({KIND[e.actor.kind]})</span> {e.summary}</p>
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <time dateTime={e.at}>{e.at.slice(0, 16).replace('T', ' ')} UTC</time>
              {e.policyVersion && <span>Policy {e.policyVersion}</span>}
              {e.proofHref && <a href={e.proofHref} className="text-brand-text underline underline-offset-2">Ledger proof</a>}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
