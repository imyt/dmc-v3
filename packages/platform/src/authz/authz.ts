import { Ajv2020 } from 'ajv/dist/2020.js';
import { Environment } from '@marcbachmann/cel-js';
import { parse } from 'yaml';

export interface Principal {
  id: string;
  /** the name to show people; the id is what rules and the ledger use */
  displayName?: string;
  kind: 'person' | 'service';
  groups: string[];
  /** granted to a service account by its registration */
  scopes?: string[];
  /** set when a script or agent acts for a person: that person's rules apply, and both identities are logged */
  actingFor?: Principal;
}

/** What the module knows about the thing being touched, resolved from the catalog. Unknown facts are simply absent. */
export interface ObjectFacts {
  applicationOwners?: string[];
  domain?: string;
  scopeOwner?: string;
  scopeDelegates?: string[];
  control?: string;
  /** the object has no domain yet, so any steward may look after it */
  unassigned?: boolean;
  assignee?: string;
  /** who raised the request, for separation of duties */
  requestedBy?: string;
  /** field being written and the tool that owns it; anything but `dmc` is read-only here */
  field?: string;
  fieldSource?: string;
  /** a submitted scope, or any object that needs an amendment */
  locked?: boolean;
}

export interface Decision {
  allowed: boolean;
  action: string;
  /** the person whose rules decided it, and the agent acting for them if any */
  subject: string;
  agent?: string;
  role?: string;
  rule?: string;
  /** plain language, shown to the user and kept in the ledger */
  reason: string;
}

export class AuthzConfigError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid authorization config:\n - ${problems.join('\n - ')}`); }
}

interface RoleMap { group: string; role: string; param?: string }
interface ActionDef { write?: boolean; sod?: boolean; service?: boolean; scope?: string; roles: Record<string, string> }
export interface AuthzConfig { roles: RoleMap[]; rules: Record<string, string>; actions: Record<string, ActionDef> }

const schema = {
  type: 'object', required: ['roles', 'rules', 'actions'], additionalProperties: false,
  properties: {
    roles: { type: 'array', items: { type: 'object', required: ['group', 'role'], additionalProperties: false, properties: { group: { type: 'string' }, role: { type: 'string' }, param: { type: 'string' } } } },
    rules: { type: 'object', additionalProperties: { type: 'string' } },
    actions: { type: 'object', additionalProperties: { type: 'object', required: ['roles'], additionalProperties: false, properties: {
      write: { type: 'boolean' }, sod: { type: 'boolean' }, service: { type: 'boolean' }, scope: { type: 'string' }, roles: { type: 'object', additionalProperties: { type: 'string' } } } } },
  },
};
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const ROLES_FROM_DATA = new Set(['viewer', 'app-owner', 'assignee']);
const env = new Environment().registerVariable('principal', 'map').registerVariable('object', 'map');

/** One library, used by the gateway (roles) and by each module (attribute rules), so the rules are written once. */
export class Authz {
  private readonly programs = new Map<string, (ctx: Record<string, unknown>) => unknown>();
  private constructor(private readonly cfg: AuthzConfig) {
    for (const [name, expr] of Object.entries(cfg.rules)) this.programs.set(name, env.parse(expr) as never);
  }

  static load(yamlText: string): Authz {
    let doc: unknown;
    try { doc = parse(yamlText); } catch (e) { throw new AuthzConfigError([`not valid YAML: ${(e as Error).message}`]); }
    if (!validate(doc)) throw new AuthzConfigError((validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`));
    const cfg = doc as unknown as AuthzConfig;
    const problems: string[] = [];
    const roleNames = new Set([...ROLES_FROM_DATA, ...cfg.roles.map((r) => r.role)]);
    for (const [name, expr] of Object.entries(cfg.rules)) {
      try { const c = env.check(expr); if (!c.valid) problems.push(`rule ${name}: ${(c as any).error?.message ?? 'invalid'}`); else if (c.type !== 'bool' && c.type !== 'dyn') problems.push(`rule ${name}: must return a boolean`); }
      catch (e) { problems.push(`rule ${name}: ${(e as Error).message.split('\n')[0]}`); }
    }
    for (const [a, def] of Object.entries(cfg.actions)) {
      for (const [role, grant] of Object.entries(def.roles)) {
        if (!roleNames.has(role)) problems.push(`action ${a}: unknown role ${role}`);
        if (grant !== 'any' && !(grant in cfg.rules)) problems.push(`action ${a}: role ${role} uses unknown rule ${grant}`);
      }
      if (def.service && !def.scope) problems.push(`action ${a}: service actions need a scope`);
    }
    for (const r of cfg.roles) if (r.param && !r.group.includes(`<${r.param}>`)) problems.push(`role ${r.role}: group ${r.group} has no <${r.param}>`);
    if (problems.length) throw new AuthzConfigError(problems);
    return new Authz(cfg);
  }

  /** Roles from IdP groups. A group like `dmc-steward-<domain>` yields the role with its parameter. */
  rolesFor(groups: string[]): { role: string; param?: string }[] {
    const out: { role: string; param?: string }[] = [{ role: 'viewer' }];
    for (const g of groups) {
      for (const m of this.cfg.roles) {
        if (!m.param) { if (g === m.group) out.push({ role: m.role }); continue; }
        const [pre, post] = m.group.split(`<${m.param}>`) as [string, string];
        if (g.startsWith(pre) && g.endsWith(post) && g.length > pre.length + post.length) out.push({ role: m.role, param: g.slice(pre.length, g.length - post.length) });
      }
    }
    return out;
  }

  /** The gateway's coarse check: could this person ever do this? (attribute rules come later, in the module). */
  allowedRoles(p: Principal, action: string): string[] {
    const def = this.cfg.actions[action];
    if (!def) return [];
    const have = new Set(this.rolesFor((p.actingFor ?? p).groups).map((r) => r.role));
    return Object.keys(def.roles).filter((r) => have.has(r) || r === 'app-owner' || r === 'assignee');
  }

  authorize(p: Principal, action: string, object: ObjectFacts = {}): Decision {
    const def = this.cfg.actions[action];
    const person = p.actingFor ?? p;
    const base = { action, subject: person.id, ...(p.actingFor ? { agent: p.id } : {}) };
    const deny = (reason: string): Decision => ({ ...base, allowed: false, reason });
    if (!def) return deny(`Unknown action ${action}`);

    if (p.kind === 'service') {
      const scopes = p.scopes ?? [];
      if (!p.actingFor) {
        if (!def.service || !def.scope) return deny('Service accounts cannot do this without acting for a person');
        if (!scopes.includes(def.scope)) return deny(`Missing scope ${def.scope}`);
        return { ...base, allowed: true, role: 'service', reason: `Allowed by scope ${def.scope}` };
      }
      const needs = action === 'read' ? 'dmc.read' : 'dmc.propose';
      if (!scopes.includes(needs)) return deny(`Missing scope ${needs}`);
    } else if (p.actingFor) return deny('Only a service account acts for someone');

    // restrictions apply whatever the role
    if (def.write && object.field !== undefined && object.fieldSource !== undefined && object.fieldSource !== 'dmc')
      return deny(`${object.field} is owned by ${object.fieldSource}; ask for the change there (DMC will create the task)`);
    if (def.write && object.locked) return deny('This is locked; an amendment creates a new version');
    if (def.sod && object.requestedBy !== undefined && object.requestedBy === person.id) return deny('You cannot approve or decide something you requested yourself');

    const roles = this.rolesFor(person.groups);
    const domains = roles.filter((r) => r.role === 'steward' && r.param).map((r) => r.param!);
    const controls = roles.filter((r) => r.role === 'control-owner' && r.param).map((r) => r.param!);
    const ctx = {
      principal: { id: person.id, groups: person.groups, domains, controls },
      object: { applicationOwners: [], scopeDelegates: [], ...(object as Record<string, unknown>) },
    };
    const held = new Set(roles.map((r) => r.role));
    if ((object.applicationOwners ?? []).includes(person.id)) held.add('app-owner');
    // whoever a task is assigned to by name may decide it, with no IdP group (a task routed to an application owner)
    if (object.assignee !== undefined && object.assignee === person.id) held.add('assignee');
    // a scope's owner (from the scope source) and its active delegates hold the role for that scope without an IdP group
    if (object.scopeOwner === person.id || (object.scopeDelegates ?? []).includes(person.id)) held.add('scope-owner');

    for (const [role, grant] of Object.entries(def.roles)) {
      if (!held.has(role)) continue;
      if (grant === 'any') return { ...base, allowed: true, role, reason: `Allowed as ${role}` };
      let ok = false;
      try { ok = this.programs.get(grant)!(ctx) === true; } catch { ok = false; } // a rule that cannot be evaluated (missing fact) does not grant
      if (ok) return { ...base, allowed: true, role, rule: grant, reason: `Allowed as ${role} by ${grant}` };
    }
    return deny(Object.keys(def.roles).length === 0 ? 'No role may do this' : `Needs one of: ${Object.keys(def.roles).join(', ')}, on an object you are responsible for`);
  }
}
