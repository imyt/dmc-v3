import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiError, parseDryRun, withIdempotency, type Queryable } from '@dmc/platform';
import { CatalogScopes, type NodeRecord } from '@dmc/catalog';
import type { FastifyReply } from 'fastify';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';
import { scopeFacts, slug } from './scopes.js';

const ISO = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
interface Problem { path: string; message: string }

/**
 * C1. A scope is defined by its owner (or a delegate): groups of business elements and the integrations the data flows over.
 * Submitting locks it. A locked scope is read-only; an amendment opens it again as the next version. Earlier versions stay readable
 * through `known_at`, because every change is recorded with when DMC learned it.
 */
@Controller('v1/scopes')
@UseGuards(AuthGuard)
export class ScopesController {
  private readonly scopes: CatalogScopes;
  constructor(@Inject(DEPS) private readonly d: ApiDeps) { this.scopes = new CatalogScopes(d.store); }

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  private async scope(db: Queryable, qn: string, asOf: { knownAt?: Date } = {}): Promise<NodeRecord> {
    const n = await this.d.store.getNode(db, qn, asOf);
    if (!n || n.type !== 'Scope') throw new ApiError('not_found', `No scope ${qn}`);
    return n;
  }

  /** Authorise a change to the scope. People only: agents propose through policies, not here. */
  private async mayChange(req: AuthedRequest, db: Queryable, scope: NodeRecord, action: 'scope_write' | 'scope_amend'): Promise<string> {
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Scopes are defined by their owners; agents and scripts cannot change them');
    const decision = this.d.authz.authorize(req.principal, action, await scopeFacts(this.d, db, scope));
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    return decision.subject;
  }

  private async structure(db: Queryable, scope: NodeRecord, asOf: { knownAt?: Date } = {}) {
    const groupsEdges = await this.d.store.namedEdgesOf(db, scope.qualifiedName, { name: 'includes', direction: 'out', ...asOf });
    const groups = [];
    for (const g of groupsEdges) {
      const node = await this.d.store.getNode(db, g.toQn, asOf);
      if (!node) continue;
      const els = await this.d.store.namedEdgesOf(db, g.toQn, { name: 'includes', direction: 'out', ...asOf });
      const elements = [];
      for (const e of els) {
        const el = await this.d.store.getNode(db, e.toQn, asOf);
        if (!el) continue;
        const links = (await this.d.store.namedEdgesOf(db, e.toQn, { name: 'implemented_by', direction: 'out', ...asOf })).map((l) => ({ target: l.toQn, app: l.attributes?.app as string | undefined, state: (l.attributes?.state as string | undefined) ?? 'confirmed' }));
        elements.push({ qualified_name: el.qualifiedName, name: el.attributes.name, definition: el.attributes.definition, criticality: el.attributes.criticality, links });
      }
      groups.push({ qualified_name: node.qualifiedName, name: node.attributes.name, order: node.attributes.order ?? 0, elements: elements.sort((a, b) => String(a.name).localeCompare(String(b.name))) });
    }
    groups.sort((a, b) => Number(a.order) - Number(b.order) || String(a.name).localeCompare(String(b.name)));
    const flows = (await this.d.store.namedEdgesOf(db, scope.qualifiedName, { name: 'flows_through', direction: 'out', ...asOf })).map((e) => e.toQn).sort();
    return { groups, flows };
  }

  /** What the scope contains now, or as DMC knew it at `known_at`; with its locked history so a screen can offer every version. */
  @Get(':qn')
  async get(@Param('qn') qn: string, @Query() q: Record<string, string>) {
    const knownAt = q.known_at ? new Date(q.known_at) : undefined;
    if (knownAt && Number.isNaN(knownAt.getTime())) throw new ApiError('validation_failed', 'known_at must be a date-time', [{ path: 'known_at', message: 'invalid' }]);
    return this.withDb(async (db) => {
      const s = await this.scope(db, qn, { knownAt });
      const hist = await this.d.store.history(db, qn);
      // one entry per time the scope was submitted: that is a version someone committed to
      const versions: { version: number; submitted_at: string }[] = [];
      for (const h of hist) {
        const v = Number(h.attributes.version ?? 1);
        if (h.attributes.status === 'submitted' && !versions.some((x) => x.version === v)) versions.push({ version: v, submitted_at: ISO(h.recordedFrom)! });
      }
      return {
        qualified_name: s.qualifiedName, name: s.attributes.name ?? s.qualifiedName, owner: s.attributes.owner, kind: s.attributes.kind, criticality: s.attributes.criticality, required_tier: s.attributes.required_tier ?? 'bronze',
        version: Number(s.attributes.version ?? 1), status: s.attributes.status ?? 'draft', locked: s.attributes.status === 'submitted', locked_at: s.attributes.locked_at,
        versions, ...(await this.structure(db, s, { knownAt })),
      };
    });
  }

  private async run<T>(req: AuthedRequest, res: FastifyReply, qn: string, action: 'scope_write' | 'scope_amend', key: string | undefined, dryRaw: unknown, body: unknown,
    work: (db: Queryable, scope: NodeRecord, actor: string) => Promise<{ status: number; body: T; signal?: { kind: string; asset: Record<string, unknown> } }>) {
    const dry = parseDryRun(dryRaw);
    const go = async () => {
      const c = await this.d.connect();
      try {
        const scope = await this.scope(c, qn);
        const actor = await this.mayChange(req, c, scope, action);
        await c.query('begin');
        let out;
        try { out = await work(c, scope, actor); } catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
        if (!dry && out.signal) await this.d.signals.submit([{ source: 'api', key: `${key}:${out.signal.kind}`, kind: out.signal.kind, subjectRef: `Scope:${qn}`, subjectType: 'Scope', asset: out.signal.asset, actor }]);
        return dry ? { status: 200, body: { dry_run: true } as unknown as T } : out;
      } finally { c.release(); }
    };
    const out = dry ? await go() : await withIdempotency(this.d.idempotency, key, body, go);
    void res.status(out.status);
    return out.body;
  }


  /** The element, from this scope. */
  private async elementOf(db: Queryable, scope: NodeRecord, element: string): Promise<NodeRecord> {
    for (const g of await this.d.store.namedEdgesOf(db, scope.qualifiedName, { name: 'includes', direction: 'out' }))
      if ((await this.d.store.namedEdgesOf(db, g.toQn, { name: 'includes', direction: 'out' })).some((e) => e.toQn === element)) return (await this.d.store.getNode(db, element))!;
    throw new ApiError('not_found', `${element} is not a business element of ${scope.qualifiedName}`);
  }

  /** An application owner (or delegate) says where a business element of a submitted scope lives. An agent acting for them proposes; they confirm. */
  @Post(':qn/links')
  async link(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Body() body: { element?: string; target?: string; app?: string }, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const { element, target, app } = body ?? {};
    const problems: Problem[] = [];
    for (const [k, v] of Object.entries({ element, target, app })) if (typeof v !== 'string' || !v) problems.push({ path: k, message: 'required' });
    if (problems.length) throw new ApiError('validation_failed', 'element, target and app are required', problems);
    const byAgent = req.principal.kind === 'service' || !!req.principal.actingFor;
    const dry = parseDryRun(q.dry_run);
    const go = async () => {
      const c = await this.d.connect();
      try {
        const scope = await this.scope(c, qn);
        if (scope.attributes.status !== 'submitted') throw new ApiError('conflict', 'Links are made once the scope is submitted');
        const onFlows = (await this.scopes.applicationsOn(c, qn)).find((a) => a.qn === app);
        if (!onFlows) throw new ApiError('validation_failed', `${app} is not on the flows of ${qn}`, [{ path: 'app', message: 'not an application on this scope’s flows' }]);
        const decision = this.d.authz.authorize(req.principal, 'link_elements', { applicationOwners: [...(onFlows.owner ? [onFlows.owner] : []), ...onFlows.delegates] });
        if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
        await this.elementOf(c, scope, element!);
        const t = await this.d.store.getNode(c, target!);
        if (!t || (t.type !== 'Column' && t.type !== 'Table')) throw new ApiError('validation_failed', `${target} is not a column or table in the catalog`, [{ path: 'target', message: 'a column or table' }]);
        const existing = (await this.d.store.namedEdgesOf(c, element!, { name: 'implemented_by', direction: 'out' })).find((e) => e.toQn === target);
        if (existing && existing.attributes?.app !== app) throw new ApiError('conflict', `${target} is already linked by ${String(existing.attributes?.app)}`);
        const state = byAgent ? 'proposed' : 'confirmed';
        const who = decision.agent ? `${decision.agent} for ${decision.subject}` : decision.subject;
        await c.query('begin');
        try {
          await this.d.store.link(c, { name: 'implemented_by', fromQn: element!, toQn: target!, source: 'dmc', actor: who,
            attributes: { app, state: existing?.attributes?.state === 'confirmed' ? 'confirmed' : state, ...(state === 'confirmed' ? { confirmed_by: decision.subject, confirmed_at: new Date().toISOString() } : {}) } });
        } catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
        return { status: dry ? 200 : 201, body: dry ? { dry_run: true } : { element, target, app, state: existing?.attributes?.state === 'confirmed' ? 'confirmed' : state } };
      } finally { c.release(); }
    };
    const out = dry ? await go() : await withIdempotency(this.d.idempotency, key, body, go);
    void res.status(out.status);
    return out.body;
  }

  /** The application owner confirms a link that was proposed (by an agent, or a suggestion): their attestation. */
  @Post(':qn/links/confirm')
  @HttpCode(200)
  async confirmLink(@Req() req: AuthedRequest, @Param('qn') qn: string, @Body() body: { element?: string; target?: string }) {
    const { element, target } = body ?? {};
    if (typeof element !== 'string' || typeof target !== 'string' || !element || !target) throw new ApiError('validation_failed', 'element and target are required', [{ path: 'element', message: 'required' }]);
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'A link is confirmed by the application’s owner, not by an agent');
    const c = await this.d.connect();
    try {
      const scope = await this.scope(c, qn);
      await this.elementOf(c, scope, element);
      const edge = (await this.d.store.namedEdgesOf(c, element, { name: 'implemented_by', direction: 'out' })).find((e) => e.toQn === target);
      if (!edge) throw new ApiError('not_found', `${element} is not linked to ${target}`);
      const app = (await this.scopes.applicationsOn(c, qn)).find((a) => a.qn === edge.attributes?.app);
      if (!app) throw new ApiError('conflict', 'That application is no longer on this scope’s flows');
      const decision = this.d.authz.authorize(req.principal, 'link_elements', { applicationOwners: [...(app.owner ? [app.owner] : []), ...app.delegates] });
      if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
      await this.d.store.tx(c, () => this.d.store.link(c, { name: 'implemented_by', fromQn: element, toQn: target, source: 'dmc', actor: decision.subject,
        attributes: { ...edge.attributes, state: 'confirmed', confirmed_by: decision.subject, confirmed_at: new Date().toISOString() } }));
      return { element, target, app: app.qn, state: 'confirmed' };
    } finally { c.release(); }
  }

  /** Is the scope complete: every element linked, and every application on its flows has finished its task. */
  @Get(':qn/completeness')
  async completeness(@Param('qn') qn: string) {
    return this.withDb(async (db) => {
      const scope = await this.scope(db, qn);
      const version = Number(scope.attributes.version ?? 1);
      const { groups } = await this.structure(db, scope);
      const elements = groups.flatMap((g) => g.elements);
      const unlinked = elements.filter((e) => !e.links.some((l) => l.state === 'confirmed')).map((e) => e.qualified_name);
      const tasks = (await this.d.inbox.forSubject(`Scope:${qn}`, 'scope-links')).filter((t) => Number(t.context.version) === version && t.status !== 'cancelled');
      const apps = (await this.scopes.applicationsOn(db, qn)).map((a) => {
        const t = tasks.find((x) => x.context.app === a.qn);
        const task = !t ? 'missing' : t.status === 'open' ? 'open' : t.decision === 'none_held' ? 'none_held' : 'done';
        return {
          application: a.qn, name: a.name, ...(a.owner ? { owner: a.owner } : {}), task, ...(t ? { task_id: t.id, escalated: t.escalated } : {}), ...(t?.dueAt ? { due_at: t.dueAt } : {}),
          links: elements.reduce((n, e) => n + e.links.filter((l) => l.app === a.qn && l.state === 'confirmed').length, 0),
        };
      });
      const submitted = scope.attributes.status === 'submitted';
      return {
        qualified_name: qn, version, submitted,
        complete: submitted && unlinked.length === 0 && apps.every((a) => a.task === 'done' || a.task === 'none_held'),
        elements: { total: elements.length, linked: elements.length - unlinked.length, unlinked },
        applications: apps,
      };
    });
  }

  @Post(':qn/groups')
  async addGroup(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Body() body: { name?: unknown; order?: unknown }, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || !slug(name)) throw new ApiError('validation_failed', 'name is required', [{ path: 'name', message: 'required' }]);
    if (body.order !== undefined && !Number.isInteger(body.order)) throw new ApiError('validation_failed', 'order must be a whole number', [{ path: 'order', message: 'integer' }]);
    return this.run(req, res, qn, 'scope_write', key, q.dry_run, body, async (db, scope, actor) => {
      const gqn = `${scope.qualifiedName}--${slug(name)}`;
      if (await this.d.store.getNode(db, gqn)) throw new ApiError('conflict', `Group ${gqn} already exists`);
      // a group without an explicit position goes after the ones already there
      const existing = (await this.d.store.namedEdgesOf(db, scope.qualifiedName, { name: 'includes', direction: 'out' })).length;
      const order = body.order !== undefined ? body.order : existing + 1;
      await this.d.store.applyNode(db, { type: 'ScopeGroup', qualifiedName: gqn, attributes: { name, order }, writer: { kind: 'user' }, actor });
      await this.d.store.link(db, { name: 'includes', fromQn: scope.qualifiedName, toQn: gqn, source: 'dmc', actor });
      return { status: 201, body: { qualified_name: gqn, name } };
    });
  }

  @Post(':qn/groups/:group/elements')
  async addElement(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Param('group') group: string,
    @Body() body: { name?: unknown; definition?: unknown; criticality?: unknown }, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || !slug(name)) throw new ApiError('validation_failed', 'name is required', [{ path: 'name', message: 'required' }]);
    return this.run(req, res, qn, 'scope_write', key, q.dry_run, body, async (db, scope, actor) => {
      const inScope = (await this.d.store.namedEdgesOf(db, scope.qualifiedName, { name: 'includes', direction: 'out' })).some((e) => e.toQn === group);
      if (!inScope) throw new ApiError('not_found', `No group ${group} in ${qn}`);
      const eqn = `${group}--${slug(name)}`;
      if (await this.d.store.getNode(db, eqn)) throw new ApiError('conflict', `Element ${eqn} already exists`);
      const attributes: Record<string, unknown> = { name, ...(body.definition !== undefined ? { definition: body.definition } : {}), ...(body.criticality !== undefined ? { criticality: body.criticality } : {}) };
      await this.d.store.applyNode(db, { type: 'BusinessElement', qualifiedName: eqn, attributes, writer: { kind: 'user' }, actor });
      await this.d.store.link(db, { name: 'includes', fromQn: group, toQn: eqn, source: 'dmc', actor });
      return { status: 201, body: { qualified_name: eqn, name } };
    });
  }

  /** The trust tier the assets behind this scope must reach. The scope owner (or a delegate) chooses; the default is Bronze. */
  @Put(':qn/required-tier')
  @HttpCode(200)
  async setRequiredTier(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Body() body: { required_tier?: unknown }, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const t = body?.required_tier;
    if (t !== 'bronze' && t !== 'silver' && t !== 'gold') throw new ApiError('validation_failed', 'required_tier must be bronze, silver or gold', [{ path: 'required_tier', message: 'bronze, silver or gold' }]);
    return this.run(req, res, qn, 'scope_write', key, q.dry_run, body, async (db, _scope, actor) => {
      await this.d.store.applyNode(db, { type: 'Scope', qualifiedName: qn, attributes: { required_tier: t }, writer: { kind: 'user' }, actor });
      return { status: 200, body: { qualified_name: qn, required_tier: t } };
    });
  }

  /** Replace the integrations the scope's data flows through. */
  @Put(':qn/flows')
  @HttpCode(200)
  async setFlows(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Body() body: { integrations?: unknown }, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    const list = body?.integrations;
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x)) throw new ApiError('validation_failed', 'integrations must be a list of qualified names', [{ path: 'integrations', message: 'list of names' }]);
    const want = [...new Set(list as string[])].sort();
    return this.run(req, res, qn, 'scope_write', key, q.dry_run, body, async (db, scope, actor) => {
      const problems: Problem[] = [];
      for (const [i, w] of want.entries()) { const n = await this.d.store.getNode(db, w); if (n?.type !== 'Integration') problems.push({ path: `integrations.${i}`, message: `${w} is not an integration in the catalog` }); }
      if (problems.length) throw new ApiError('validation_failed', 'Some integrations are unknown', problems);
      const have = (await this.d.store.namedEdgesOf(db, qn, { name: 'flows_through', direction: 'out' })).map((e) => e.toQn);
      for (const w of want.filter((x) => !have.includes(x))) await this.d.store.link(db, { name: 'flows_through', fromQn: qn, toQn: w, source: 'dmc', actor });
      for (const h of have.filter((x) => !want.includes(x))) await this.d.store.unlink(db, { name: 'flows_through', fromQn: qn, toQn: h, actor });
      return { status: 200, body: { integrations: want } };
    });
  }

  /** Submit: complete enough to lock. There is no separate approval; locking is what hands the work to the application owners. */
  @Post(':qn/submit')
  @HttpCode(200)
  async submit(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    return this.run(req, res, qn, 'scope_write', key, q.dry_run, {}, async (db, scope, actor) => {
      const s = await this.structure(db, scope);
      const problems: Problem[] = [];
      if (s.groups.length === 0) problems.push({ path: 'groups', message: 'add at least one group of business elements' });
      for (const g of s.groups) if (g.elements.length === 0) problems.push({ path: `groups.${g.qualified_name}`, message: 'a group needs at least one business element' });
      if (s.flows.length === 0) problems.push({ path: 'flows', message: 'say which integrations the data flows through' });
      if (problems.length) throw new ApiError('validation_failed', 'The scope is not ready to submit', problems);
      const version = Number(scope.attributes.version ?? 1);
      await this.d.store.applyNode(db, { type: 'Scope', qualifiedName: qn, attributes: { version, status: 'submitted', locked_at: new Date().toISOString() }, writer: { kind: 'user' }, actor });
      return { status: 200, body: { qualified_name: qn, version, status: 'submitted' }, signal: { kind: 'scope.submitted', asset: { ...scope.attributes, qualified_name: qn, status: 'submitted', version } } };
    });
  }

  /** Amend a submitted scope: it opens again as the next version; the submitted one stays on record. */
  @Post(':qn/amend')
  @HttpCode(200)
  async amend(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    return this.run(req, res, qn, 'scope_amend', key, q.dry_run, {}, async (db, scope, actor) => {
      if (scope.attributes.status !== 'submitted') throw new ApiError('conflict', 'Only a submitted scope can be amended');
      const version = Number(scope.attributes.version ?? 1) + 1;
      await this.d.store.applyNode(db, { type: 'Scope', qualifiedName: qn, attributes: { version, status: 'amended' }, writer: { kind: 'user' }, actor });
      return { status: 200, body: { qualified_name: qn, version, status: 'amended' }, signal: { kind: 'scope.amended', asset: { ...scope.attributes, qualified_name: qn, status: 'amended', version } } };
    });
  }
}
