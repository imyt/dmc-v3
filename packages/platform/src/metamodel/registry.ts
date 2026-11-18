import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

export const CATEGORIES = ['Asset', 'Concept', 'ControlRecord', 'GovernanceObject', 'Party'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface AttributeDef {
  type: string;
  values?: string[];
  required?: boolean;
  /** regular expression a string value must match */
  pattern?: string;
  /** the value is the key of a node of this type; a sync resolves it before writing (a Person by email, for example) */
  identifies?: string;
  source: string;
}
export interface EdgeDef {
  to: string;
  cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  propagate?: { concepts: string[]; min_confidence: number };
}
export interface TypeDef {
  type: string;
  version: number;
  parent: Category;
  identity: { qualified_name: string; /** every qualified name of the type must match (checked on create) */ pattern?: string };
  attributes: Record<string, AttributeDef>;
  edges?: Record<string, EdgeDef[]>;
  inherit?: { attribute: string; along: string; direction: 'in' | 'out' }[];
  lifecycle: 'default';
  controls: string[];
}

export class MetamodelError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid metamodel:\n - ${problems.join('\n - ')}`);
  }
}

export class Registry {
  private readonly byName: Map<string, TypeDef>;
  /** per type switched to DMC: the source systems that owned its attributes before (ADR 0018) */
  private former = new Map<string, string[]>();
  constructor(types: TypeDef[]) {
    this.byName = new Map(types.map((t) => [t.type, t]));
  }
  get(name: string): TypeDef {
    const t = this.byName.get(name);
    if (!t) throw new Error(`Unknown type: ${name}`);
    return t;
  }
  has(name: string): boolean {
    return this.byName.has(name);
  }
  all(): TypeDef[] {
    return [...this.byName.values()];
  }
  byParent(parent: Category): TypeDef[] {
    return this.all().filter((t) => t.parent === parent);
  }
  /** Is `to` a valid target for an edge declared with target `declared`? Category names and Any match by parent. */
  matchesTarget(declared: string, actual: string): boolean {
    if (declared === actual || declared === 'Any') return true;
    return this.has(actual) && this.get(actual).parent === declared;
  }
  /** Edge definitions a type may use for `edge`, or [] when not allowed. */
  edgesFor(type: string, edge: string): EdgeDef[] {
    return this.get(type).edges?.[edge] ?? [];
  }
  /**
   * The same metamodel after a cutover: for each listed type set to `dmc`, attributes that the old system of record (Collibra) owned become DMC's.
   * Types set to `collibra` are left as they are. A type with nothing to switch is an error, so a typo cannot pass silently.
   */
  withSourceOfTruth(switches: Record<string, string>): Registry {
    const problems: string[] = [];
    for (const [type, to] of Object.entries(switches)) {
      if (!this.has(type)) { problems.push(`${type}: unknown type`); continue; }
      if (to !== 'dmc' && to !== 'collibra') { problems.push(`${type}: source must be dmc or collibra, not ${to}`); continue; }
      if (!Object.values(this.get(type).attributes).some((a) => a.source === 'collibra')) problems.push(`${type}: has no attributes that Collibra owns`);
    }
    if (problems.length) throw new MetamodelError(problems);
    const next = new Registry(this.all().map((t) => switches[t.type] === 'dmc'
      ? { ...t, attributes: Object.fromEntries(Object.entries(t.attributes).map(([k, a]) => [k, a.source === 'collibra' ? { ...a, source: 'dmc' } : a])) }
      : t));
    for (const [type, to] of Object.entries(switches)) if (to === 'dmc') next.former.set(type, ['collibra']);
    return next;
  }
  /** Source systems that used to own this type and no longer do (switched to DMC): they must not write its edges either. */
  formerOwners(type: string): string[] { return this.former.get(type) ?? []; }
  canLink(from: string, edge: string, to: string): boolean {
    return this.edgesFor(from, edge).some((e) => this.matchesTarget(e.to, to));
  }
}

const SCHEMA_PATH = new URL('../../../../metamodel/schema/type.schema.json', import.meta.url);

/** Load and validate every `*.yaml` under `dir`. Throws MetamodelError listing all problems. */
export function loadRegistry(dir: string): Registry {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as object;
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  const problems: string[] = [];
  const types: TypeDef[] = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      problems.push(`${file}: not valid YAML (${(e as Error).message})`);
      continue;
    }
    if (!validate(doc)) {
      for (const err of validate.errors ?? []) problems.push(`${file}: ${err.instancePath || '/'} ${err.message}`);
      continue;
    }
    const def = doc as TypeDef;
    if (file !== `${def.type}.yaml`) problems.push(`${file}: file name must be ${def.type}.yaml`);
    types.push(def);
  }

  const names = new Set<string>();
  for (const t of types) {
    if (names.has(t.type)) problems.push(`${t.type}: defined twice`);
    names.add(t.type);
  }
  const edgeNames = new Set(types.flatMap((t) => Object.keys(t.edges ?? {})));
  const isTarget = (n: string) => n === 'Any' || (CATEGORIES as readonly string[]).includes(n) || names.has(n);

  for (const t of types) {
    for (const [name, defs] of Object.entries(t.edges ?? {}))
      for (const e of defs) if (!isTarget(e.to)) problems.push(`${t.type}: edge ${name} points at unknown type ${e.to}`);
    for (const [name, defs] of Object.entries(t.edges ?? {}))
      for (const e of defs)
        for (const c of e.propagate?.concepts ?? [])
          if (!names.has(c)) problems.push(`${t.type}: edge ${name} propagates unknown concept ${c}`);
    for (const i of t.inherit ?? []) {
      if (!(i.attribute in t.attributes)) problems.push(`${t.type}: inherits unknown attribute ${i.attribute}`);
      if (!edgeNames.has(i.along)) problems.push(`${t.type}: inherits along unknown edge ${i.along}`);
    }
    for (const [a, d] of Object.entries(t.attributes))
      if (d.type === 'enum' && (d.values?.length ?? 0) === 0) problems.push(`${t.type}.${a}: enum needs values`);
    for (const [where, p] of [[`${t.type} identity`, t.identity.pattern], ...Object.entries(t.attributes).map(([a, d]) => [`${t.type}.${a}`, d.pattern] as const)] as const) {
      if (!p) continue;
      try { new RegExp(p); } catch { problems.push(`${where}: pattern is not a valid regular expression`); }
    }
  }

  if (problems.length) throw new MetamodelError(problems);
  return new Registry(types);
}

/** `config/source-of-truth.yaml`: which system owns each glossary type. Changing a line is the cutover for that type. */
export function loadSourceOfTruth(file: string): Record<string, string> {
  const doc = parse(readFileSync(file, 'utf8')) as { source_of_truth?: Record<string, string> } | null;
  return doc?.source_of_truth ?? {};
}
