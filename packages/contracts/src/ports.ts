// Ports: how modules reach each other. A module depends on these interfaces only; the apps wire the implementations.

export type Autonomy = 'propose' | 'act_notify' | 'act';
export type Outcome = 'act' | 'act_notify' | 'propose' | 'drop';

export interface PolicyEffect { action: string; message?: string; attribute?: string; value?: unknown; concept?: string }

export interface PolicyEvaluation {
  policyId: string;
  control: string;
  mode: 'shadow' | 'enforced';
  matched: boolean | null;          // null: could not be evaluated
  error?: string;
  effect: PolicyEffect;
  route?: string;
  escalateAfter?: string;           // e.g. "10d"
  autonomy: Autonomy;               // ceiling
  confidence: number;
  inputsHash: string;               // hash of the policy and the asset that were evaluated
}

/** Evaluates the active policies for an asset. Shadow results are recorded by the implementation, never acted on. */
export interface PolicyPort {
  evaluate(assetType: string, subjectRef: string, asset: Record<string, unknown>): Promise<PolicyEvaluation[]>;
}

export interface RaiseExceptionRequest {
  kind: string; severity: 'low' | 'medium' | 'high' | 'critical'; subjectRef: string; message: string;
  route: string; policyId?: string; escalateAfter?: string; actor: string;
}
export interface ExceptionPort {
  raise(req: RaiseExceptionRequest): Promise<{ id: string; created: boolean }>;
  withdraw(req: { policyId: string; subjectRef: string; actor: string }): Promise<boolean>;
}

export interface ActionRequest {
  /** same key, same action: dispatching twice does it once */
  idempotencyKey: string;
  decisionId: string;
  policyId: string;
  subjectRef: string;
  effect: PolicyEffect;
  notify: boolean;
  route?: string;
  /** when a change in a tool is not confirmed by then, it escalates (e.g. "10d") */
  escalateAfter?: string;
}
export interface ActionPort {
  dispatch(req: ActionRequest): Promise<{ id: string }>;
}

export interface Signal {
  /** source + key identify the signal; delivering it twice is safe */
  source: string;
  key: string;
  kind: string;
  subjectRef: string;
  subjectType: string;
  asset: Record<string, unknown>;
  confidence?: number;
  actor?: string;
  /** a proposed write, used by `apply_change` policies: set this attribute to this value */
  change?: { attribute: string; value: unknown };
}

/** The catalog write an action needs. Implemented by `@dmc/catalog`; the action module never touches catalog tables. */
export interface CatalogWritePort {
  /** current value of an attribute (undefined when not set) */
  getAttribute(subjectRef: string, attribute: string): Promise<unknown>;
  /** sets a dmc-sourced attribute; returns what it was before */
  setAttribute(subjectRef: string, attribute: string, value: unknown, actor: string): Promise<{ previous: unknown; changed: boolean }>;
  /** the owning source of an attribute (`dmc` means DMC may write it itself) */
  sourceOf(subjectRef: string, attribute: string): Promise<string | undefined>;
}

export interface NotifyPort {
  send(req: { route: string; subjectRef: string; message: string; actor: string }): Promise<void>;
}

/** A task for the owner of a tool that DMC cannot write to (until a write-back adapter exists). */
export interface ToolTaskPort {
  create(req: { route: string; subjectRef: string; message: string; attribute: string; expected: unknown; dueBy?: string; actor: string; policyId: string }): Promise<{ id: string }>;
}

// ---- Sync (S1) ----

export type SourceRecord = Record<string, unknown>;
export interface ConnectorQuery { text: string; cursorField?: string; pageSize: number }
export interface ReadPage {
  records: SourceRecord[];
  /** pass this back to read the next page; ignored when `done` */
  nextCursor: string | null;
  /** the highest value of the job's cursor field seen on this page (for incremental runs) */
  highWater?: string | null;
  done: boolean;
}
/** Code for one kind of system. Instances are configured as connections; jobs say what to read. */
export interface Connector {
  test(config: Record<string, unknown>): Promise<{ ok: boolean; message?: string }>;
  /** one page at a time; `pageCursor` is null on the first call */
  read(config: Record<string, unknown>, query: ConnectorQuery, pageCursor: string | null, since: string | null): Promise<ReadPage>;
}

/** Where sync output goes. Implemented by the decision path; delivering the same (source, key) twice is safe. */
export interface SignalSink {
  /** A sink that refuses some signals names their keys in `rejected`; the sender then does not treat those records as delivered (ADR 0024). */
  submit(signals: Signal[]): Promise<void | SubmitResult>;
}
export interface SubmitResult { rejected?: string[] }

// ---- Lineage (L1) ----

export interface LineageNode { qualifiedName: string; type: string; depth: number; /** the table (or other container) it belongs to, when known */ container?: string }
export interface LineageEdge { from: string; to: string; job?: string; confidence?: number; source: string }
export interface LineageQuery {
  /** `upstream`: what this is built from. `downstream`: what is built from this (the impact of changing it). */
  direction: 'upstream' | 'downstream';
  /** hops from the start; default 10, at most 20 */
  depth?: number;
  /** stop after this many nodes; default 5000, at most 20000 */
  maxNodes?: number;
  /** ignore edges the source is less sure of than this (edges with no confidence count as 1) */
  minConfidence?: number;
}
export interface LineageResult {
  root: string;
  direction: 'upstream' | 'downstream';
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** the walk stopped early: more exists beyond the depth, or beyond the node cap */
  truncated: { depth: boolean; nodes: boolean };
}
/** Walks column-to-column lineage. Postgres first; a graph database can replace it behind this port. */
export interface LineageStore {
  traverse(qualifiedName: string, q: LineageQuery): Promise<LineageResult | undefined>;
}

/** One waiting task in a person's inbox: what it is about, what they may decide, and by when. */
export interface InboxItem {
  id: string;
  assignee: string;
  /** the exception it belongs to, when it is one */
  exceptionId?: string;
  kind: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
  subjectRef: string;
  decisions: string[];
  raisedAt: string;
  dueAt?: string;
  escalated: boolean;
}
/** How one task of a workflow stands, for screens that show progress rather than ask for a decision. */
export interface TaskStatus {
  id: string; assignee: string; status: 'open' | 'done' | 'cancelled'; decision?: string; dueAt?: string; escalated: boolean;
  context: Record<string, unknown>;
}
export interface InboxPort {
  /** the tasks of every run of `workflow` on one subject, open or finished */
  forSubject(subjectRef: string, workflow: string): Promise<TaskStatus[]>;
  /** open tasks assigned to any of these identities (the person and their groups) */
  list(assignees: string[]): Promise<InboxItem[]>;
  get(taskId: string): Promise<InboxItem | undefined>;
  decide(req: { taskId: string; decision: string; actor: string; assignees: string[]; key?: string }): Promise<{ replayed: boolean }>;
}

/** Opens a change request (a pull request) against a config repository, with files and a report attached. */
export interface ChangeRequestPort {
  open(req: { repo: 'policies' | 'metamodel' | 'sync'; title: string; body: string; files: { path: string; content: string }[]; author: string }): Promise<{ id: string; url: string }>;
}

/** U2. The pause switches for enforcement: all of it, or one policy. A paused policy is still evaluated and recorded as shadow, but acts on nothing. */
export interface AdminPort {
  state(): Promise<{ enforcementPaused: boolean; pausedPolicies: string[] }>;
  /** false when it was already so */
  setEnforcement(paused: boolean, actor: string): Promise<boolean>;
  setPolicy(id: string, paused: boolean, actor: string): Promise<boolean>;
}

/** S12. What the sync admin screen shows of a run. Counts are numbers only; no source values (rule 8). */
export interface SyncRunView {
  id: string; job: string; environment: string; trigger: 'schedule' | 'manual';
  status: 'running' | 'succeeded' | 'failed' | 'paused_limit' | 'discarded' | 'skipped';
  mode: string; complete: boolean; startedAt: string; finishedAt: string | null;
  counts: { read: number; created: number; updated: number; unchanged: number; missing: number; errors: number; refused: number };
  note: string | null; etag: string;
}
/** A job in one environment. `connection` is the connection's name and `connectionType` its kind; the connection's configuration and secret are never shown. */
export interface SyncJobView {
  name: string; environment: string; version: number; enabled: boolean; paused: boolean; schedule: string;
  connection: string; connectionType: string | null; mode: string; maxChangesPct: number | null;
  lastRun: SyncRunView | null; lastSuccessAt: string | null; awaitingReview: string | null; etag: string;
}
/**
 * S12. The connectors module as the API sees it: reads of its own schema, the pause switch, and requests to the worker.
 * Runs happen in the worker (the same pg-boss queue the schedule uses); the API only enqueues. Each method that changes state records who did it.
 */
export interface SyncAdminPort {
  jobs(): Promise<SyncJobView[]>;
  job(environment: string, name: string): Promise<SyncJobView | undefined>;
  runs(environment: string, name: string, page: { limit: number; before?: { startedAt: string; id: string } }): Promise<SyncRunView[]>;
  run(id: string): Promise<SyncRunView | undefined>;
  /** false when it was already so */
  setPaused(environment: string, name: string, paused: boolean, actor: string): Promise<boolean>;
  /** Queues a run for the worker. `conflict` says why it was not queued. */
  runNow(environment: string, name: string, actor: string): Promise<{ queued: true; queueId: string } | { queued: false; conflict: string }>;
  /** Queues the approval of a run held by the change limit. */
  approve(runId: string, actor: string): Promise<{ queued: true } | { queued: false; conflict: string }>;
}

/** U5. What only the workflow and decision modules know, for the management measures. */
export interface OperationalStats {
  /** ages in days of the exceptions open now, and how many are past their due date */
  exceptions: { openAgesDays: number[]; overdue: number };
  /** applied decisions by whether a person was needed */
  decisions: { automatic: number; byPerson: number };
}

/** U4. One email. `key` names the event, so a sender that can be asked twice mails it once. */
export interface MailMessage { to: string[]; subject: string; text: string; key: string }
export interface MailSender { send(m: MailMessage): Promise<void> }
