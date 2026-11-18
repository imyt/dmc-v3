import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiError, parseDryRun, withIdempotency, type Queryable } from '@dmc/platform';
import { CatalogScopes, type NodeRecord } from '@dmc/catalog';
import type { FastifyReply } from 'fastify';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps, type AuthedRequest } from './context.js';
import { slug } from './scopes.js';

interface Problem { path: string; message: string }
interface DatasetBody { name?: unknown; description?: unknown; business_context?: unknown; categories?: unknown; record_class?: unknown; columns?: unknown }
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x) ? [...new Set(v as string[])].sort() : undefined);

/**
 * C4. Datasets are mastered here by application owners: for each integration, what it carries, with data category, business context,
 * record class and the columns that realise it. Only the owner or a delegate of an application on the integration may change them.
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class DatasetsController {
  private readonly apps: CatalogScopes;
  constructor(@Inject(DEPS) private readonly d: ApiDeps) { this.apps = new CatalogScopes(d.store); }

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  private async integration(db: Queryable, qn: string): Promise<NodeRecord> {
    const n = await this.d.store.getNode(db, qn);
    if (!n || n.type !== 'Integration') throw new ApiError('not_found', `No integration ${qn}`);
    return n;
  }

  private async integrationOf(db: Queryable, dataset: string): Promise<NodeRecord> {
    const up = await this.d.store.namedEdgesOf(db, dataset, { name: 'transfers', direction: 'in' });
    if (!up[0]) throw new ApiError('conflict', `${dataset} is not carried by any integration`);
    return this.integration(db, up[0].fromQn);
  }

  /** People who own or look after an application at either end of the integration. */
  private async owners(db: Queryable, integration: string): Promise<string[]> {
    const out: string[] = [];
    for (const edge of ['source_of', 'target_of']) for (const e of await this.d.store.namedEdgesOf(db, integration, { name: edge, direction: 'in' })) {
      const a = await this.d.store.getNode(db, e.fromQn);
      if (a?.type !== 'Application') continue;
      if (typeof a.attributes.owner === 'string') out.push(a.attributes.owner);
      if (Array.isArray(a.attributes.delegates)) out.push(...a.attributes.delegates.filter((x): x is string => typeof x === 'string'));
    }
    return [...new Set(out)];
  }

  /** People change datasets. An agent acting for an owner may check one with a dry run, which saves nothing. */
  private async mayEdit(req: AuthedRequest, db: Queryable, integration: string, dry = false): Promise<string> {
    if ((req.principal.kind !== 'person' || req.principal.actingFor) && !dry) throw new ApiError('forbidden', 'Datasets are maintained by application owners; agents and scripts can check one with a dry run, and the owner adds it');
    const decision = this.d.authz.authorize(req.principal, 'edit_dataset', { applicationOwners: await this.owners(db, integration) });
    if (!decision.allowed) throw new ApiError('forbidden', decision.reason);
    return decision.subject;
  }

  private async view(db: Queryable, n: NodeRecord, canEdit: boolean) {
    const one = async (name: string) => (await this.d.store.namedEdgesOf(db, n.qualifiedName, { name, direction: 'out' })).map((e) => e.toQn).sort();
    const [categories, record, columns] = [await one('in_category'), await one('recorded_as'), await one('realised_by')];
    return {
      qualified_name: n.qualifiedName, name: n.attributes.name, description: n.attributes.description, business_context: n.attributes.business_context,
      categories, record_class: record[0], columns, can_edit: canEdit,
    };
  }

  @Get('integrations/:qn/datasets')
  async list(@Req() req: AuthedRequest, @Param('qn') qn: string) {
    return this.withDb(async (db) => {
      await this.integration(db, qn);
      const can = this.d.authz.authorize(req.principal, 'edit_dataset', { applicationOwners: await this.owners(db, qn) }).allowed && req.principal.kind === 'person' && !req.principal.actingFor;
      const out = [];
      for (const e of await this.d.store.namedEdgesOf(db, qn, { name: 'transfers', direction: 'out' })) {
        const n = await this.d.store.getNode(db, e.toQn);
        if (n) out.push(await this.view(db, n, can));
      }
      return { integration: qn, datasets: out.sort((a, b) => String(a.name).localeCompare(String(b.name))) };
    });
  }

  /** Check the references, then replace the dataset's edges to match. */
  private async validate(db: Queryable, b: DatasetBody, partial: boolean): Promise<{ categories?: string[]; columns?: string[]; recordClass?: string | null }> {
    const problems: Problem[] = [];
    const out: { categories?: string[]; columns?: string[]; recordClass?: string | null } = {};
    for (const k of ['name', 'description', 'business_context'] as const) if (b[k] !== undefined && (typeof b[k] !== 'string' || (k === 'name' && !(b[k] as string).trim()))) problems.push({ path: k, message: 'text' });
    if (!partial && !(typeof b.name === 'string' && slug(b.name))) problems.push({ path: 'name', message: 'required' });
    const check = async (field: 'categories' | 'columns', type: string, one: string) => {
      if (b[field] === undefined) return;
      const list = strings(b[field]);
      if (!list) { problems.push({ path: field, message: 'list of names' }); return; }
      for (const [i, qn] of list.entries()) if ((await this.d.store.getNode(db, qn))?.type !== type) problems.push({ path: `${field}.${i}`, message: `${qn} is not ${one} in the catalog` });
      out[field] = list;
    };
    await check('categories', 'DataCategory', 'a data category');
    await check('columns', 'Column', 'a column');
    if (b.record_class !== undefined) {
      if (b.record_class === null) out.recordClass = null;
      else if (typeof b.record_class !== 'string' || (await this.d.store.getNode(db, b.record_class))?.type !== 'RecordClass') problems.push({ path: 'record_class', message: 'not a record class in the catalog' });
      else out.recordClass = b.record_class;
    }
    if (problems.length) throw new ApiError('validation_failed', 'The dataset is not valid', problems);
    return out;
  }

  private async replace(db: Queryable, from: string, name: string, want: string[], actor: string): Promise<void> {
    const have = (await this.d.store.namedEdgesOf(db, from, { name, direction: 'out' })).map((e) => e.toQn);
    for (const w of want.filter((x) => !have.includes(x))) await this.d.store.link(db, { name, fromQn: from, toQn: w, source: 'dmc', actor });
    for (const h of have.filter((x) => !want.includes(x))) await this.d.store.unlink(db, { name, fromQn: from, toQn: h, actor });
  }

  private async apply(db: Queryable, qn: string, refs: { categories?: string[]; columns?: string[]; recordClass?: string | null }, actor: string) {
    if (refs.categories) await this.replace(db, qn, 'in_category', refs.categories, actor);
    if (refs.columns) await this.replace(db, qn, 'realised_by', refs.columns, actor);
    if (refs.recordClass !== undefined) await this.replace(db, qn, 'recorded_as', refs.recordClass ? [refs.recordClass] : [], actor);
  }

  private async run<T>(res: FastifyReply, key: string | undefined, dryRaw: unknown, body: unknown, work: (db: Queryable) => Promise<{ status: number; body: T }>) {
    const dry = parseDryRun(dryRaw);
    const go = async () => {
      const c = await this.d.connect();
      try {
        await c.query('begin');
        let out;
        try { out = await work(c); } catch (e) { await c.query('rollback'); throw e; }
        await c.query(dry ? 'rollback' : 'commit');
        return dry ? { status: 200, body: { dry_run: true } as unknown as T } : out;
      } finally { c.release(); }
    };
    const out = dry ? await go() : await withIdempotency(this.d.idempotency, key, body, go);
    void res.status(out.status);
    return out.body;
  }

  @Post('integrations/:qn/datasets')
  async create(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Body() body: DatasetBody, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    return this.run(res, key, q.dry_run, body, async (db) => {
      await this.integration(db, qn);
      const actor = await this.mayEdit(req, db, qn, parseDryRun(q.dry_run));
      const refs = await this.validate(db, body ?? {}, false);
      const name = (body.name as string).trim();
      const dqn = `${qn}--${slug(name)}`;
      if (await this.d.store.getNode(db, dqn)) throw new ApiError('conflict', `Dataset ${dqn} already exists`);
      const attributes: Record<string, unknown> = { name, ...(typeof body.description === 'string' ? { description: body.description } : {}), ...(typeof body.business_context === 'string' ? { business_context: body.business_context } : {}) };
      await this.d.store.applyNode(db, { type: 'Dataset', qualifiedName: dqn, attributes, writer: { kind: 'user' }, actor });
      await this.d.store.link(db, { name: 'transfers', fromQn: qn, toQn: dqn, source: 'dmc', actor });
      await this.apply(db, dqn, refs, actor);
      return { status: 201, body: { qualified_name: dqn, name } };
    });
  }

  /** Change what is sent: fields left out stay as they are; a list sent replaces the one held. */
  @Patch('datasets/:qn')
  async update(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: FastifyReply, @Param('qn') qn: string, @Body() body: DatasetBody, @Query() q: Record<string, string>, @Headers('idempotency-key') key?: string) {
    return this.run(res, key, q.dry_run, body, async (db) => {
      const ds = await this.d.store.getNode(db, qn);
      if (!ds || ds.type !== 'Dataset') throw new ApiError('not_found', `No dataset ${qn}`);
      const actor = await this.mayEdit(req, db, (await this.integrationOf(db, qn)).qualifiedName, parseDryRun(q.dry_run));
      const refs = await this.validate(db, body ?? {}, true);
      const attributes: Record<string, unknown> = {};
      for (const k of ['name', 'description', 'business_context'] as const) if (typeof body[k] === 'string') attributes[k] = k === 'name' ? (body[k] as string).trim() : body[k];
      if (Object.keys(attributes).length) await this.d.store.applyNode(db, { type: 'Dataset', qualifiedName: qn, attributes, writer: { kind: 'user' }, actor });
      await this.apply(db, qn, refs, actor);
      return { status: 200, body: { qualified_name: qn } };
    });
  }
}
