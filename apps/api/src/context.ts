import type { Authz, IdempotencyStore, Principal, Queryable, Registry } from '@dmc/platform';
import type { AdminPort, OperationalStats, ChangeRequestPort, ExceptionPort, InboxPort, SignalSink } from '@dmc/contracts';
import type { PolicyIR } from '@dmc/policy';
import type { CatalogStore } from '@dmc/catalog';

export interface Connection extends Queryable { release(): void }

/** Everything the API needs from outside, so tests and production wire it differently. */
export interface ApiDeps {
  version: string;
  /** a connection as the catalog module's role */
  connect(): Promise<Connection>;
  store: CatalogStore;
  /** a connection as the evidence module's role (read side) */
  connectEvidence(): Promise<Connection>;
  registry: Registry;
  authz: Authz;
  /** the loaded policies, as far as coverage needs to see them */
  policies(): { id: string; implements?: string; control?: string; mode: 'shadow' | 'enforced' }[];
  /** the pause switches; without it the admin endpoints answer that they are not available */
  admin?: AdminPort;
  /** exception and decision figures for the dashboard measures; without it those measures are left out */
  stats?(): Promise<OperationalStats>;
  /** the policy editor: the policies in force, and where a saved draft goes as a pull request */
  policyEditor?: { existing(): PolicyIR[] };
  changeRequests?: ChangeRequestPort;
  exceptions: ExceptionPort;
  inbox: InboxPort;
  /** where writes are reported (and, for agents and scripts, proposed): the decision path */
  signals: SignalSink;
  idempotency: IdempotencyStore;
  /** returns the caller, or null when the request carries no valid identity */
  /** where sign-in is handled: the environment decides whether the mock login exists; the secret signs the session cookie */
  session?: { environment: string; secret?: string };
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal | null> | Principal | null;
}

export const DEPS = Symbol('DMC_API_DEPS');
export type AuthedRequest = { principal: Principal; headers: Record<string, string | string[] | undefined>; id: string };
