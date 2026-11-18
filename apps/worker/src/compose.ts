import type { Queryable, Registry } from '@dmc/platform';
import type { CatalogWritePort, NotifyPort, Signal, SignalSink, ToolTaskPort } from '@dmc/contracts';
import { ActionService } from '@dmc/actions';
import { CatalogDelegations, CatalogStore } from '@dmc/catalog';
import { SyncService } from '@dmc/connectors';
import { DecisionService } from '@dmc/decision';
import { PolicyIndex, PolicyService } from '@dmc/policy';
import { ExceptionService, type WorkflowEngine } from '@dmc/workflow';
import { anchorIfDue, checkAnchors, relayOutbox, verifyChain, type VerifyResult } from '@dmc/evidence';
import type { Connector } from '@dmc/contracts';
import { CatalogIngest, confirmLinked } from './ingest.js';
import { ScopeLinkTasks } from './scope-links.js';
import { PersonRefResolver } from './person-refs.js';
import { Derivations } from './derive.js';
import { SCOPE_OWNER_POLICY, ScopeOwnerCheck } from './scope-owners.js';
import type { EmailNotifications } from './notifications.js';

/** One connection per module, each as that module's own role. Every service runs one thing at a time on its connection. */
export interface Connections { catalog: Queryable; decision: Queryable; workflow: Queryable; policy: Queryable; actions: Queryable; connectors: Queryable; evidence: Queryable; trust: Queryable }

/** Modules whose outbox the ledger writer reads. */
export const OUTBOX_MODULES = ['catalog', 'decision', 'workflow', 'policy', 'actions', 'connectors', 'trust'];

export interface WorkerDeps {
  db: Connections;
  registry: Registry;
  policies: PolicyIndex;
  engine: WorkflowEngine;
  connectors: Record<string, Connector>;
  notify: NotifyPort;
  /** emails people about their tasks (U4); absent in tests and wherever notifications are only logged */
  emails?: EmailNotifications;
  /** the separate audit database (E2), when configured: the chain's head hash is copied there and checked against it */
  audit?: Queryable;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** called when a source record is refused by the metamodel */
  onReject?: (s: Signal, reason: string) => Promise<void> | void;
}

const split = (ref: string): { type: string; qn: string } => {
  const i = ref.indexOf(':');
  if (i < 1) throw new Error(`Not a subject reference (expected <Type>:<name>): ${ref}`);
  return { type: ref.slice(0, i), qn: ref.slice(i + 1) };
};

/** The catalog as the action module sees it. Subject references are `<Type>:<qualified name>`. */
export function catalogWritePort(db: Queryable, store: CatalogStore, registry: Registry): CatalogWritePort {
  return {
    async getAttribute(ref, attribute) { return (await store.getNode(db, split(ref).qn))?.attributes[attribute]; },
    async sourceOf(ref, attribute) {
      const t = split(ref).type;
      return registry.has(t) ? (registry.get(t).attributes as Record<string, { source?: string }>)[attribute]?.source ?? undefined : undefined;
    },
    async setAttribute(ref, attribute, value, actor) {
      const { type, qn } = split(ref);
      const previous = (await store.getNode(db, qn))?.attributes[attribute];
      const r = await store.tx(db, () => store.applyNode(db, { type, qualifiedName: qn, attributes: { [attribute]: value }, writer: { kind: 'user' }, actor }));
      return { previous, changed: r.changed };
    },
  };
}

/** Everything the worker runs, wired. The API and the connectors process use the same pieces. */
export function compose(d: WorkerDeps) {
  const store = new CatalogStore(d.registry);
  const exceptions = new ExceptionService(d.engine);
  const exceptionPort = { raise: (r: Parameters<ExceptionService['raise']>[1]) => exceptions.raise(d.db.workflow, r), withdraw: (r: Parameters<ExceptionService['withdraw']>[1]) => exceptions.withdraw(d.db.workflow, r) };
  const tasks: ToolTaskPort = {
    async create(r) {
      const x = await exceptions.raise(d.db.workflow, { kind: 'tool_task', severity: 'medium', subjectRef: r.subjectRef, message: r.message, route: r.route, policyId: r.policyId, actor: r.actor, escalateAfter: undefined });
      return { id: x.id };
    },
  };
  const actions = new ActionService(d.db.actions, { catalog: catalogWritePort(d.db.catalog, store, d.registry), notify: d.notify, tasks, exceptions: exceptionPort });
  const decision = new DecisionService({ policies: new PolicyService(d.db.policy, d.policies), exceptions: exceptionPort, actions });

  /** Where every signal ends up: a tool change that was waiting for it is confirmed, then policies decide. */
  const decide: SignalSink = {
    async submit(signals) {
      const seen = signals.filter((s) => s.kind === 'sync.upsert');
      if (seen.length) {
        const bySource = new Map<string, { subjectRef: string; attributes: Record<string, unknown> }[]>();
        for (const s of seen) bySource.set(s.source, [...(bySource.get(s.source) ?? []), { subjectRef: s.subjectRef, attributes: s.asset }]);
        // a signal names its job; the owning tool is the source the job writes as
        for (const [job, observed] of bySource) await actions.confirmOnSync(await sync.writerSource(d.db.connectors, job), observed, d.now?.());
      }
      for (const s of signals) await decision.handle(d.db.decision, s);
    },
  };

  // a sync run hands its signals to the ingest, which applies them to the catalog and passes them on; the ingest asks the sync service which source a job writes as
  // S11: owners of scopes synced from ARIS, RRIS and the BCBS inventory must be people in the catalog; otherwise an exception, never a failed run
  const scopeOwners = new ScopeOwnerCheck({ store, connect: async () => ({ query: (q: string, p?: unknown[]) => d.db.catalog.query(q, p), release() {} }), exceptions: exceptionPort, next: decide,
    openUnknown: async () => (await exceptions.list(d.db.workflow, { status: ['open', 'escalated'] })).filter((x) => x.policy_id === SCOPE_OWNER_POLICY).map((x) => x.subject_ref) });
  // ADR 0026: owners named by email are resolved to the staff ID (the Person key) before the ingest; a value that cannot be is refused and reported
  const toIngest: SignalSink = new PersonRefResolver({ store, registry: d.registry, connect: async () => ({ query: (q: string, p?: unknown[]) => d.db.catalog.query(q, p), release() {} }), next: { submit: (s) => ingest.submit(s) }, onReject: (s, r) => d.onReject?.(s, r) });
  const sync = new SyncService({ connectors: d.connectors, signals: toIngest, exceptions: exceptionPort, now: d.now, sleep: d.sleep });
  const ingest = new CatalogIngest({ store, connect: async () => ({ query: (q: string, p?: unknown[]) => d.db.catalog.query(q, p), release() {} }), sourceOf: (job) => sync.writerSource(d.db.connectors, job), next: scopeOwners, onReject: d.onReject,
    // S10: an edge a tool owns (a classification) confirms the pending change that was waiting for it
    linked: confirmLinked(actions, (job) => sync.writerSource(d.db.connectors, job), d.now) });

  const delegations = new CatalogDelegations(store);
  const scopeLinks = new ScopeLinkTasks(store, d.engine, d.db);
  const REMINDER = 'delegation-expiring';
  /** Ends delegations whose scope changed owner in the source system, and reminds owners of delegations about to expire (once each). */
  async function sweepDelegations(): Promise<{ ended: number; reminded: number }> {
    const ended = await delegations.endForOwnerChange(d.db.catalog);
    for (const qn of ended) await exceptionPort.withdraw({ policyId: REMINDER, subjectRef: `Delegation:${qn}`, actor: 'system/delegations' });
    let reminded = 0;
    for (const x of await delegations.expiring(d.db.catalog, d.now?.())) {
      const r = await exceptionPort.raise({ kind: 'delegation.expiring', severity: 'low', subjectRef: `Delegation:${x.qualifiedName}`, policyId: REMINDER, route: x.owner, actor: 'system/delegations',
        message: `Your delegation to ${x.delegate}${x.scopeQn ? ` on ${x.scopeQn}` : ' on all your scopes'} ends on ${x.validTo}. Create a new one if they still need it.` });
      await delegations.markReminded(d.db.catalog, x.qualifiedName, d.now?.());
      if (r.created) reminded++;
    }
    return { ended: ended.length, reminded };
  }

  /** Housekeeping, run every minute: finish what crashed, resend what was blocked, escalate what is overdue, tidy delegations. */
  async function tick(): Promise<{ resumed: number; retried: number; escalated: number; delegationsEnded: number; remindersRaised: number; linkTasksOpened: number; emailsSent?: number }> {
    const resumed = await decision.resume(d.db.decision);
    const retried = await actions.retryBlocked();
    const escalated = await actions.escalateOverdue(d.now?.());
    const swept = await sweepDelegations();
    const links = await scopeLinks.sweep();
    const mail = d.emails ? await d.emails.sweep() : undefined;
    await relay();
    return { resumed, retried, escalated, delegationsEnded: swept.ended, remindersRaised: swept.reminded, linkTasksOpened: links.opened, ...(mail ? { emailsSent: mail.sent } : {}) };
  }

  /** Moves outbox events into the ledger. Safe to run often; one writer at a time (advisory lock). */
  const relay = async (): Promise<number> => relayOutbox(d.db.evidence, OUTBOX_MODULES);

  /**
   * Checks the chain. A divergence stops every automatic action (kill switch `all`) and raises a critical exception for the platform team;
   * people can still decide tasks. Nothing resumes until someone releases the switch.
   */
  async function verify(opts: { recent?: number } = {}): Promise<VerifyResult> {
    let fromSeq: number | undefined;
    if (opts.recent) {
      const head = await d.db.evidence.query<{ seq: string }>('select seq from evidence.ledger_entry order by seq desc limit 1');
      fromSeq = head.rows[0] ? Math.max(1, Number(head.rows[0].seq) - opts.recent + 1) : undefined;
    }
    let r = await verifyChain(d.db.evidence, { fromSeq });
    let unverifiable = false;
    if (r.ok && d.audit) {
      // Fail closed: if the audit database cannot be reached the anchors cannot be checked, so treat the ledger as unverified.
      try { const a = await checkAnchors(d.db.evidence, d.audit); if (!a.ok) r = a; }
      catch (e) { unverifiable = true; r = { ok: false, checked: r.checked, reason: `audit database unreachable, anchors could not be checked: ${(e as Error).message}` }; }
    }
    if (!r.ok) {
      const why = unverifiable ? `Ledger could not be verified: ${r.reason}` : `Ledger verification failed at entry ${r.firstBadSeq}: ${r.reason}`;
      await actions.pause('all', why, 'system/verifier');
      await exceptionPort.raise({ kind: 'ledger.divergence', severity: 'critical', subjectRef: 'ledger/main', message: why, route: 'platform-governance', actor: 'system/verifier' });
      await d.notify.send({ route: 'platform-governance', subjectRef: 'ledger/main', message: why, actor: 'system/verifier' });
    }
    return r;
  }

  /** Copies the chain's head hash to the audit database when due (5 seconds, or 5,000 entries). A no-op where no audit database is configured. */
  const anchor = async (): Promise<boolean> => (d.audit ? (await anchorIfDue(d.db.evidence, d.audit, d.now?.())).anchored : false);

  /** Derived facts (cross-border cover, trust tiers, classification proposals): run every 15 minutes. */
  const derivations = new Derivations(store, { catalog: d.db.catalog, trust: d.db.trust, workflow: d.db.workflow, actions: d.db.actions }, decide, d.now);
  const derive = () => derivations.all();

  return { store, scopeOwners, delegations, scopeLinks, derivations, derive, exceptions, actions, decision, sync, ingest, decide, tick, relay, anchor, verify };
}
export type Composition = ReturnType<typeof compose>;
