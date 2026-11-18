import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiError, checkIfMatch, decodeCursor, etagOf, parseDryRun, parseLimit, toPage, withIdempotency } from '@dmc/platform';
import type { Signal } from '@dmc/contracts';
import { CatalogLineage, PostgresSearch, type NodeRecord } from '@dmc/catalog';
import type { LineageQuery } from '@dmc/contracts';
import type { FastifyReply } from 'fastify';
import { SCOPE_TYPES, scopeFacts } from './scopes.js';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';

const GLOSSARY = new Set(['BusinessTerm', 'DataCategory', 'DataDomain']);
const codeOf = (qn: string): string => qn.slice(qn.lastIndexOf(':') + 1);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const date = (raw: string | undefined, name: string): Date | undefined => {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new ApiError('validation_failed', `${name} must be a date-time`, [{ path: name, message: 'not a valid date-time' }]);
  return d;
};

@Controller('v1')
export class HealthController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}
  @Get('health') health() { return { status: 'ok', version: this.d.version }; }
}

@Controller('v1/search')
@UseGuards(AuthGuard)
export class SearchController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  /** Words are prefixes, so results appear as the person types. Ranking and facets cover the best matches; `facets_sampled` says when that is a sample. */
  @Get()
  async search(@Query() q: Record<string, string>) {
    const text = (q.q ?? '').trim();
    if (!text) throw new ApiError('validation_failed', 'q is required', [{ path: 'q', message: 'required' }]);
    const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    const types = list(q.type);
    for (const t of types ?? []) if (!this.d.registry.has(t)) throw new ApiError('validation_failed', `Unknown type ${t}`, [{ path: 'type', message: 'not in the metamodel' }]);
    const limit = parseLimit(q.limit, 100, 20);
    const offset = q.offset === undefined ? 0 : Number(q.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000) throw new ApiError('validation_failed', 'offset must be 0..1000; refine the query instead of paging deeper', [{ path: 'offset', message: '0 to 1000' }]);
    const c = await this.d.connect();
    try {
      const r = await new PostgresSearch(c).search({ text, types, lifecycles: list(q.lifecycle) as never, limit, offset });
      return { hits: r.hits.map((h) => ({ qualified_name: h.qualifiedName, type: h.type, name: h.name, lifecycle: h.lifecycle })), facets: r.facets, facets_sampled: r.facetsSampled };
    } finally { c.release(); }
  }
}

@Controller('v1/nodes')
@UseGuards(AuthGuard)
export class CatalogController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  /** Glossary types are edited by the stewards of their domain; everything else by its application's owners. */
  private editAction(type: string): 'edit_glossary' | 'edit_dmc_fields' | 'scope_write' { return GLOSSARY.has(type) ? 'edit_glossary' : SCOPE_TYPES.has(type) ? 'scope_write' : 'edit_dmc_fields'; }

  /** The code of the domain a glossary node sits in: a domain is its own, a category's is its domain's, a term's is its category's. */
  private async domainOf(db: import('@dmc/platform').Queryable, n: NodeRecord): Promise<string | undefined> {
    let cur: NodeRecord | undefined = n;
    for (let hops = 0; cur && hops < 3; hops++) {
      if (cur.type === 'DataDomain') return codeOf(cur.qualifiedName);
      const up: { toQn: string }[] = await this.d.store.namedEdgesOf(db, cur.qualifiedName, { name: 'part_of', direction: 'out' });
      cur = up[0] ? await this.d.store.getNode(db, up[0].toQn) : undefined;
    }
    return undefined;
  }

  /** Who owns what, as far as this node and its place in the glossary say. Walking edges to an owning application comes with the relationship rules (C-track). */
  private async facts(n: NodeRecord) {
    if (SCOPE_TYPES.has(n.type)) return this.withDb((db) => scopeFacts(this.d, db, n));
    const a = n.attributes;
    const owners = n.type === 'Application' ? [a.owner, ...(Array.isArray(a.delegates) ? a.delegates : [])].filter((x): x is string => typeof x === 'string') : [];
    const domain = GLOSSARY.has(n.type) ? await this.withDb((db) => this.domainOf(db, n)) : typeof a.domain === 'string' ? a.domain : undefined;
    return { applicationOwners: owners, ...(domain !== undefined ? { domain } : {}) };
  }

  private async toJson(n: NodeRecord, req: AuthedRequest) {
    const def = this.d.registry.has(n.type) ? this.d.registry.get(n.type) : undefined;
    const sources = Object.fromEntries(Object.entries(def?.attributes ?? {}).map(([k, v]) => [k, (v as { source?: string }).source ?? 'dmc']));
    const action = this.editAction(n.type);
    const decision = this.d.authz.authorize(req.principal, action, await this.facts(n));
    return {
      id: n.id, type: n.type, qualified_name: n.qualifiedName, lifecycle: n.lifecycle, attributes: n.attributes, attribute_sources: sources,
      provenance: n.provenance, valid_from: n.validFrom.toISOString(), valid_to: iso(n.validTo), recorded_from: n.recordedFrom.toISOString(),
      allowed_actions: [{ id: action, allowed: decision.allowed, ...(decision.allowed ? {} : { reason: decision.reason }) }],
    };
  }

  private async withDb<R>(fn: (db: import('@dmc/platform').Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  /**
   * Create a glossary node: a data domain (administrators), or a category or term inside a domain its steward looks after.
   * Other types arrive through sync or their own endpoints. Only attributes DMC owns can be set; until a type's cutover they belong to Collibra.
   */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { type?: string; qualified_name?: string; attributes?: Record<string, unknown>; part_of?: string }, @Query() q: Record<string, string>,
    @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const { type, qualified_name: qn, attributes = {}, part_of: parentQn } = body ?? {};
    if (!type || !GLOSSARY.has(type)) throw new ApiError('validation_failed', 'type must be BusinessTerm, DataCategory or DataDomain', [{ path: 'type', message: 'glossary types only' }]);
    if (!qn) throw new ApiError('validation_failed', 'qualified_name is required', [{ path: 'qualified_name', message: 'required' }]);
    if (req.principal.kind !== 'person' || req.principal.actingFor) throw new ApiError('forbidden', 'Glossary entries are created by people; agents propose changes to existing ones');
    const dry = parseDryRun(q.dry_run);
    const parentType = type === 'BusinessTerm' ? 'DataCategory' : type === 'DataCategory' ? 'DataDomain' : undefined;
    const run = async () => {
      const def = this.d.registry.get(type);
      let domain: string | undefined;
      if (parentType) {
        if (!parentQn) throw new ApiError('validation_failed', `part_of is required: the ${parentType} it belongs to`, [{ path: 'part_of', message: `a ${parentType}` }]);
        const parent = await this.withDb((db) => this.d.store.getNode(db, parentQn));
        if (!parent || parent.type !== parentType) throw new ApiError('validation_failed', `${parentQn} is not a ${parentType}`, [{ path: 'part_of', message: `must be a ${parentType}` }]);
        domain = await this.withDb((db) => this.domainOf(db, parent));
      } else if (parentQn) throw new ApiError('validation_failed', 'a data domain has no parent', [{ path: 'part_of', message: 'not allowed' }]);
      let decision = this.d.authz.authorize(req.principal, type === 'DataDomain' ? 'create_domain' : 'edit_glossary', domain !== undefined ? { domain } : {});
      for (const field of Object.keys(attributes)) {
        const a = (def.attributes as Record<string, { source?: string }>)[field];
        if (!a) throw new ApiError('validation_failed', 'Attributes are invalid', [{ path: `attributes.${field}`, message: `${type} has no attribute "${field}"` }]);
        if (type !== 'DataDomain') decision = this.d.authz.authorize(req.principal, 'edit_glossary', { domain, field, fieldSource: a.source ?? 'dmc' });
        else if (decision.allowed && (a.source ?? 'dmc') !== 'dmc') throw new ApiError('forbidden', `${field} is owned by ${a.source}; ask for the change there`);
        if (!decision.allowed) break;
      }
      if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
      if (await this.withDb((db) => this.d.store.getNode(db, qn))) throw new ApiError('conflict', `${qn} already exists`);
      const c = await this.d.connect();
      try {
        await c.query('begin');
        try {
          await this.d.store.applyNode(c, { type, qualifiedName: qn, attributes, writer: { kind: 'user' }, actor: decision.subject });
          if (parentQn) await this.d.store.link(c, { name: 'part_of', fromQn: qn, toQn: parentQn, source: 'dmc', actor: decision.subject });
        } catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
      } finally { c.release(); }
      if (dry) return { status: 200, body: { dry_run: true, type, qualified_name: qn } };
      const made = (await this.withDb((db) => this.d.store.getNode(db, qn)))!;
      await this.d.signals.submit([{ source: 'api', key: `${key}:create`, kind: 'write.applied', subjectRef: `${type}:${qn}`, subjectType: type, asset: { ...made.attributes, qualified_name: qn }, actor: decision.subject }]);
      return { status: 201, etag: etagOf(made.id, made.recordedFrom.getTime()), body: await this.toJson(made, req) };
    };
    const out = dry ? await run() : await withIdempotency(this.d.idempotency, key, body, run);
    void res.status(out.status);
    if ('etag' in out && out.etag) void res.header('ETag', out.etag);
    return out.body;
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    if (!q.type) throw new ApiError('validation_failed', 'type is required', [{ path: 'type', message: 'required' }]);
    if (!this.d.registry.has(q.type)) throw new ApiError('validation_failed', `Unknown type ${q.type}`, [{ path: 'type', message: 'not in the metamodel' }]);
    const limit = parseLimit(q.limit);
    const after = decodeCursor<{ qn: string }>(q.cursor)?.qn;
    const rows = await this.withDb((db) => this.d.store.listByType(db, q.type!, { limit, afterQn: after, validAt: date(q.valid_at, 'valid_at'), knownAt: date(q.known_at, 'known_at') }));
    const page = toPage(rows, limit, (last) => ({ qn: last.qualifiedName }));
    return { items: await Promise.all(page.items.map((n) => this.toJson(n, req))), next_cursor: page.next_cursor };
  }

  @Get(':qn')
  async get(@Req() req: AuthedRequest, @Param('qn') qn: string, @Query() q: Record<string, string>, @Res({ passthrough: true }) res: FastifyReply) {
    const n = await this.withDb((db) => this.d.store.getNode(db, qn, { validAt: date(q.valid_at, 'valid_at'), knownAt: date(q.known_at, 'known_at') }));
    if (!n) throw new ApiError('not_found', `No ${qn} in the catalog`);
    void res.header('ETag', etagOf(n.id, n.recordedFrom.getTime()));
    return this.toJson(n, req);
  }

  /**
   * Edit DMC-owned fields. A person's authorised edit applies at once and is reported as a signal.
   * An agent or script (a service account, or anyone acting for a person) only proposes: the write travels as a signal,
   * and a policy with the `apply_change` effect decides whether it is applied or sent for review.
   */
  @Patch(':qn')
  async edit(@Req() req: AuthedRequest, @Param('qn') qn: string, @Body() body: { attributes?: Record<string, unknown> }, @Query() q: Record<string, string>,
    @Headers('if-match') ifMatch: string | undefined, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const attrs = body?.attributes;
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || Object.keys(attrs).length === 0)
      throw new ApiError('validation_failed', 'attributes must name at least one field', [{ path: 'attributes', message: 'required' }]);
    const dry = parseDryRun(q.dry_run);
    const run = async () => {
      const n = await this.withDb((db) => this.d.store.getNode(db, qn));
      if (!n) throw new ApiError('not_found', `No ${qn} in the catalog`);
      const current = etagOf(n.id, n.recordedFrom.getTime());
      checkIfMatch(ifMatch, current);
      const def = this.d.registry.get(n.type);
      const problems: { path: string; message: string }[] = [];
      let decision;
      const facts = await this.facts(n);
      for (const field of Object.keys(attrs)) {
        const a = (def.attributes as Record<string, { source?: string }>)[field];
        if (!a) { problems.push({ path: `attributes.${field}`, message: `${n.type} has no attribute "${field}"` }); continue; }
        decision = this.d.authz.authorize(req.principal, this.editAction(n.type), { ...facts, field, fieldSource: a.source ?? 'dmc' });
        if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
      }
      if (problems.length) throw new ApiError('validation_failed', 'Attributes are invalid', problems);
      const byAgent = req.principal.kind === 'service' || !!req.principal.actingFor;
      const who = decision!.agent ? `${decision!.agent} for ${decision!.subject}` : decision!.subject;
      const asset = { ...n.attributes, qualified_name: n.qualifiedName };
      const subjectRef = `${n.type}:${n.qualifiedName}`;
      const signals: Signal[] = Object.entries(attrs).map(([attribute, value]) => ({
        source: 'api', key: `${key}:${attribute}`, kind: byAgent ? 'write.proposed' : 'write.applied', subjectRef, subjectType: n.type, asset, actor: who,
        ...(byAgent ? { change: { attribute, value } } : {}),
      }));
      if (byAgent) {
        if (!dry) await this.d.signals.submit(signals);
        return { status: 202, body: { status: 'proposed', qualified_name: n.qualifiedName, fields: Object.keys(attrs), dry_run: dry } };
      }
      const c = await this.d.connect();
      try {
        await c.query('begin');
        try { await this.d.store.applyNode(c, { type: n.type, qualifiedName: n.qualifiedName, attributes: attrs, writer: { kind: 'user' }, actor: who }); }
        catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
      } finally { c.release(); }
      if (dry) return { status: 200, body: await this.toJson(n, req) };
      await this.d.signals.submit(signals);
      const after = (await this.withDb((db) => this.d.store.getNode(db, qn)))!;
      return { status: 200, etag: etagOf(after.id, after.recordedFrom.getTime()), body: await this.toJson(after, req) };
    };
    const out = dry ? await run() : await withIdempotency(this.d.idempotency, key, { qn, attrs }, run);
    void res.status(out.status);
    if ('etag' in out && out.etag) void res.header('ETag', out.etag);
    return out.body;
  }

  @Get(':qn/relationships')
  async relationships(@Param('qn') qn: string, @Query() q: Record<string, string>) {
    const direction = q.direction === 'in' ? 'in' : q.direction === undefined || q.direction === 'out' ? 'out' : undefined;
    if (!direction) throw new ApiError('validation_failed', 'direction must be out or in', [{ path: 'direction', message: 'out or in' }]);
    const edges = await this.withDb(async (db) => {
      if ((await this.d.store.history(db, qn)).length === 0) throw new ApiError('not_found', `No ${qn} in the catalog`);
      return this.d.store.namedEdgesOf(db, qn, { name: q.name, direction, validAt: date(q.valid_at, 'valid_at'), knownAt: date(q.known_at, 'known_at') });
    });
    return { items: edges.map((e) => ({ name: e.name, from: e.fromQn, to: e.toQn, lifecycle: e.lifecycle, source: e.source, valid_from: e.validFrom.toISOString(), valid_to: iso(e.validTo) })) };
  }

  private lineageQuery(q: Record<string, string>, direction: LineageQuery['direction']): LineageQuery {
    const int = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isInteger(n)) throw new ApiError('validation_failed', `${name} must be an integer`, [{ path: name, message: 'integer' }]);
      return n;
    };
    const conf = q.min_confidence === undefined ? undefined : Number(q.min_confidence);
    if (conf !== undefined && !(conf >= 0 && conf <= 1)) throw new ApiError('validation_failed', 'min_confidence must be between 0 and 1', [{ path: 'min_confidence', message: '0 to 1' }]);
    return { direction, depth: int(q.depth, 'depth'), maxNodes: int(q.max_nodes, 'max_nodes'), minConfidence: conf };
  }

  /** Where a node comes from (upstream) or what is built from it (downstream), column to column. Depth and size are capped; `truncated` says when the walk stopped early. */
  @Get(':qn/lineage')
  async lineage(@Param('qn') qn: string, @Query() q: Record<string, string>) {
    const direction = q.direction === 'downstream' ? 'downstream' : q.direction === undefined || q.direction === 'upstream' ? 'upstream' : undefined;
    if (!direction) throw new ApiError('validation_failed', 'direction must be upstream or downstream', [{ path: 'direction', message: 'upstream or downstream' }]);
    const query = this.lineageQuery(q, direction);
    const r = await this.withDb((db) => new CatalogLineage(db).traverse(qn, query));
    if (!r) throw new ApiError('not_found', `No ${qn} in the catalog`);
    return { root: r.root, direction: r.direction, truncated: r.truncated,
      nodes: r.nodes.map((n) => ({ qualified_name: n.qualifiedName, type: n.type, depth: n.depth, ...(n.container ? { container: n.container } : {}) })),
      edges: r.edges.map((e) => ({ from: e.from, to: e.to, source: e.source, ...(e.job ? { job: e.job } : {}), ...(e.confidence !== undefined ? { confidence: e.confidence } : {}) })) };
  }

  /** What changing this node would reach: counts by type and by table, and the nearest affected columns. */
  @Get(':qn/impact')
  async impact(@Param('qn') qn: string, @Query() q: Record<string, string>) {
    const r = await this.withDb((db) => new CatalogLineage(db).traverse(qn, this.lineageQuery(q, 'downstream')));
    if (!r) throw new ApiError('not_found', `No ${qn} in the catalog`);
    const affected = r.nodes.filter((n) => n.qualifiedName !== qn);
    const count = <K extends string>(key: (n: (typeof affected)[number]) => K | undefined) => {
      const m = new Map<K, number>();
      for (const n of affected) { const k = key(n); if (k !== undefined) m.set(k, (m.get(k) ?? 0) + 1); }
      return m;
    };
    return {
      root: qn, affected: affected.length, truncated: r.truncated,
      by_type: Object.fromEntries(count((n) => n.type)),
      by_container: [...count((n) => n.container)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50).map(([container, count]) => ({ container, count })),
      nearest: affected.slice(0, 50).map((n) => ({ qualified_name: n.qualifiedName, type: n.type, depth: n.depth, ...(n.container ? { container: n.container } : {}) })),
    };
  }

  @Get(':qn/history')
  async history(@Param('qn') qn: string) {
    const versions = await this.withDb((db) => this.d.store.history(db, qn));
    if (versions.length === 0) throw new ApiError('not_found', `No ${qn} in the catalog`);
    return { items: versions.map((v) => ({ lifecycle: v.lifecycle, attributes: v.attributes, valid_from: v.validFrom.toISOString(), valid_to: iso(v.validTo), recorded_from: v.recordedFrom.toISOString(), actor: v.actor })) };
  }
}
