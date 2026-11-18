import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Authz, AuthzConfigError, agentFor, person, service } from '../packages/platform/src/index';

const yaml = readFileSync(join(import.meta.dirname, '../config/authz.yaml'), 'utf8');
const az = Authz.load(yaml);

describe('F4: roles from groups', () => {
  it('everyone signed in is a viewer; groups add roles with parameters', () => {
    expect(az.rolesFor([])).toEqual([{ role: 'viewer' }]);
    expect(az.rolesFor(['dmc-steward-payments', 'dmc-control-owner-privacy', 'dmc-auditor', 'other'])).toEqual([
      { role: 'viewer' }, { role: 'steward', param: 'payments' }, { role: 'control-owner', param: 'privacy' }, { role: 'auditor' }]);
    expect(az.rolesFor(['dmc-steward-'])).toEqual([{ role: 'viewer' }]); // empty parameter is not a role
  });
});

describe('F4: deny by default', () => {
  it('a viewer reads and nothing else', () => {
    const v = person('u1');
    expect(az.authorize(v, 'read')).toMatchObject({ allowed: true, role: 'viewer' });
    for (const a of ['edit_dataset', 'write_policy', 'read_evidence', 'sync_admin', 'scope_write']) expect(az.authorize(v, a).allowed, a).toBe(false);
    expect(az.authorize(v, 'no_such_action')).toMatchObject({ allowed: false, reason: 'Unknown action no_such_action' });
  });
  it('a denial says why, in plain words', () => {
    const d = az.authorize(person('u1'), 'edit_dataset');
    expect(d.reason).toMatch(/Needs one of: app-owner/);
  });
});

describe('F4: attribute rules', () => {
  const owner = person('alice');
  it('application ownership comes from the catalog, not a group', () => {
    expect(az.authorize(owner, 'edit_dataset', { applicationOwners: ['alice', 'bob'] })).toMatchObject({ allowed: true, role: 'app-owner', rule: 'application_ownership' });
    expect(az.authorize(owner, 'edit_dataset', { applicationOwners: ['bob', 'carol'] }).allowed).toBe(false);
    expect(az.authorize(owner, 'edit_dataset', {}).allowed).toBe(false);
  });
  it('a steward edits only their own domain', () => {
    const s = person('sam', 'dmc-steward-payments');
    expect(az.authorize(s, 'edit_glossary', { domain: 'payments' }).allowed).toBe(true);
    expect(az.authorize(s, 'edit_glossary', { domain: 'lending' }).allowed).toBe(false);
    expect(az.authorize(s, 'edit_glossary', {}).allowed).toBe(false); // missing fact never grants
  });
  it('a scope owner or an active delegate writes the scope', () => {
    const o = person('olga', 'dmc-scope-owner');
    expect(az.authorize(o, 'scope_write', { scopeOwner: 'olga' }).allowed).toBe(true);
    expect(az.authorize(o, 'scope_write', { scopeOwner: 'other' }).allowed).toBe(false);
    expect(az.authorize(person('dee', 'dmc-scope-owner'), 'scope_write', { scopeOwner: 'olga', scopeDelegates: ['dee'] }).allowed).toBe(true);
  });
  it('a scope’s owner and delegates hold the role through the data, with no IdP group', () => {
    expect(az.authorize(person('olga'), 'scope_write', { scopeOwner: 'olga' }).allowed).toBe(true);
    expect(az.authorize(person('dee'), 'scope_write', { scopeOwner: 'olga', scopeDelegates: ['dee'] }).allowed).toBe(true);
    expect(az.authorize(person('dee'), 'scope_write', { scopeOwner: 'olga', scopeDelegates: [] }).allowed).toBe(false);
    expect(az.authorize(person('dee'), 'scope_delegate', { scopeOwner: 'olga', scopeDelegates: [] }).allowed).toBe(false);   // a delegate cannot re-delegate
    expect(az.authorize(person('olga'), 'scope_delegate', { scopeOwner: 'olga', scopeDelegates: [] }).allowed).toBe(true);
  });
  it('a control owner merges only their control type', () => {
    const c = person('cat', 'dmc-control-owner-privacy');
    expect(az.authorize(c, 'pause_policy', { control: 'privacy' }).allowed).toBe(true);
    expect(az.authorize(c, 'pause_policy', { control: 'data-movement' }).allowed).toBe(false);
    expect(az.authorize(person('ann', 'dmc-platform-admin'), 'pause_policy', {}).allowed).toBe(true);
  });
  it('only the assignee decides a task', () => {
    const o = person('alice', 'dmc-steward-payments');
    expect(az.authorize(o, 'decide_task', { assignee: 'alice' }).allowed).toBe(true);
    expect(az.authorize(o, 'decide_task', { assignee: 'dmc-steward-payments' }).allowed).toBe(true); // assigned to their group
    expect(az.authorize(o, 'decide_task', { assignee: 'bob' }).allowed).toBe(false);
  });
});

describe('F4: restrictions whatever the role', () => {
  const admin = person('ann', 'dmc-platform-admin');
  const owner = person('alice');
  it('synced fields are read-only for everyone, with a pointer to the owning tool', () => {
    const d = az.authorize(owner, 'edit_dmc_fields', { applicationOwners: ['alice'], field: 'criticality', fieldSource: 'ARIS' });
    expect(d.allowed).toBe(false); expect(d.reason).toMatch(/owned by ARIS/);
    expect(az.authorize(owner, 'edit_dmc_fields', { applicationOwners: ['alice'], field: 'description', fieldSource: 'dmc' }).allowed).toBe(true);
  });
  it('locked scopes are read-only', () => {
    const o = person('olga', 'dmc-scope-owner');
    expect(az.authorize(o, 'scope_write', { scopeOwner: 'olga', locked: true })).toMatchObject({ allowed: false, reason: expect.stringMatching(/locked/) });
  });
  it('nobody approves their own request', () => {
    const c = person('cat', 'dmc-control-owner-privacy');
    expect(az.authorize(c, 'sign_off_policy', { control: 'privacy', requestedBy: 'cat' }).allowed).toBe(false);
    expect(az.authorize(c, 'sign_off_policy', { control: 'privacy', requestedBy: 'dan' }).allowed).toBe(true);
    expect(az.authorize(admin, 'review_metamodel', { requestedBy: 'ann' }).allowed).toBe(false);
    expect(az.authorize(person('alice'), 'decide_task', { assignee: 'alice', requestedBy: 'alice' }).allowed).toBe(false);
  });
  it('no role can edit evidence: there is no such action', () => {
    expect(az.authorize(admin, 'edit_evidence').allowed).toBe(false);
  });
});

describe('F4: service accounts and agents', () => {
  it('a sync job writes signals with its scope and nothing else', () => {
    const job = service('sync:apps', 'dmc.signal.write');
    expect(az.authorize(job, 'signal_write')).toMatchObject({ allowed: true, role: 'service' });
    expect(az.authorize(job, 'read').allowed).toBe(false); // scope missing
    expect(az.authorize(job, 'edit_dataset').allowed).toBe(false);
  });
  it('Fabric reads only', () => {
    const fabric = service('fabric', 'dmc.read');
    expect(az.authorize(fabric, 'read').allowed).toBe(true);
    expect(az.authorize(fabric, 'edit_dataset', { applicationOwners: ['fabric'] }).allowed).toBe(false);
  });
  it('an agent can do no more than the person it acts for, and both are logged', () => {
    const alice = person('alice');
    const agent = agentFor(service('agent-7', 'dmc.read', 'dmc.propose'), alice);
    const yes = az.authorize(agent, 'edit_dataset', { applicationOwners: ['alice'] });
    expect(yes).toMatchObject({ allowed: true, subject: 'alice', agent: 'agent-7', role: 'app-owner' });
    expect(az.authorize(agent, 'edit_dataset', { applicationOwners: ['bob'] })).toMatchObject({ allowed: false, subject: 'alice', agent: 'agent-7' });
    expect(az.authorize(agent, 'sync_admin').allowed).toBe(false);
  });
  it('an agent without the propose scope cannot write even for an owner', () => {
    const agent = agentFor(service('agent-8', 'dmc.read'), person('alice'));
    expect(az.authorize(agent, 'edit_dataset', { applicationOwners: ['alice'] })).toMatchObject({ allowed: false, reason: 'Missing scope dmc.propose' });
    expect(az.authorize(agent, 'read').allowed).toBe(true);
  });
  it('a person cannot be marked as acting for someone', () => {
    expect(az.authorize({ ...person('x'), actingFor: person('y') }, 'read').allowed).toBe(false);
  });
});

describe('F4: the gateway check', () => {
  it('lists roles that could ever do an action', () => {
    expect(az.allowedRoles(person('ann', 'dmc-platform-admin'), 'sync_admin')).toEqual(['admin']);
    expect(az.allowedRoles(person('u'), 'sync_admin')).toEqual([]);
  });
});

describe('F4: config is validated', () => {
  const bad = (edit: (s: string) => string, re: RegExp) => expect(() => Authz.load(edit(yaml))).toThrow(re);
  it('rejects unknown roles, rules and broken CEL', () => {
    bad((s) => s.replace('app-owner: application_ownership', 'app-owner: nope'), /unknown rule nope/);
    bad((s) => s.replace('viewer: any', 'viewr: any'), /unknown role viewr/);
    bad((s) => s.replace('"object.domain in principal.domains"', '"object.domain in"'), /rule domain_stewardship/);
    bad((s) => s.replace('"principal.id in object.applicationOwners"', '"1 + 1"'), /boolean/);
    bad((s) => s.replace('scope: dmc.read, ', ''), /need a scope/);
    expect(() => Authz.load('roles: 5')).toThrow(AuthzConfigError);
  });
});
