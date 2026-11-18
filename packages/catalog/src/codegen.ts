import type { AttributeDef, Registry, TypeDef } from '@dmc/platform';

const TS: Record<string, string> = {
  string: 'string', text: 'string', url: 'string', country: 'string', date: 'string', datetime: 'string',
  person: 'string', boolean: 'boolean', integer: 'number', 'string-list': 'string[]',
};

function tsType(a: AttributeDef): string {
  if (a.type === 'enum') return (a.values ?? []).map((v) => JSON.stringify(v)).join(' | ');
  return TS[a.type] ?? 'unknown';
}

/** TypeScript declarations for every metamodel type. Generated; never edited by hand. */
export function generateTypes(reg: Registry): string {
  const types = reg.all().sort((a, b) => a.type.localeCompare(b.type));
  const out = ['// GENERATED from metamodel/types by `npm run gen:metamodel`. Do not edit.', ''];
  out.push(`export type TypeName = ${types.map((t) => JSON.stringify(t.type)).join(' | ')};`, '');
  out.push(`export type Category = ${[...new Set(types.map((t) => t.parent))].sort().map((c) => JSON.stringify(c)).join(' | ')};`, '');
  for (const t of types) {
    out.push(`/** ${t.type} (${t.parent}, v${t.version}) */`, `export interface ${t.type}Attributes {`);
    for (const [name, a] of Object.entries(t.attributes))
      out.push(`  ${name}${a.required ? '' : '?'}: ${tsType(a)};`);
    out.push('}', '');
  }
  out.push('export interface AttributesByType {');
  for (const t of types) out.push(`  ${t.type}: ${t.type}Attributes;`);
  out.push('}', '');
  out.push('export const TYPE_CATEGORY: Record<TypeName, Category> = {');
  for (const t of types) out.push(`  ${t.type}: ${JSON.stringify(t.parent)},`);
  out.push('};', '');
  return out.join('\n');
}

const JSON_PROP: Record<string, object> = {
  string: { type: 'string' }, text: { type: 'string' }, url: { type: 'string', format: 'uri' },
  country: { type: 'string', pattern: '^[A-Z]{2}$' }, date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' }, person: { type: 'string', minLength: 1 },
  boolean: { type: 'boolean' }, integer: { type: 'integer' }, 'string-list': { type: 'array', items: { type: 'string' } },
};

/** JSON Schema for one type's attributes. Used by write validators and the API schemas. */
export function attributeSchema(t: TypeDef): object {
  const properties: Record<string, object> = {};
  for (const [name, a] of Object.entries(t.attributes))
    properties[name] = a.type === 'enum' ? { enum: a.values } : { ...(JSON_PROP[a.type] ?? {}), ...(a.pattern ? { pattern: a.pattern } : {}) };
  const required = Object.entries(t.attributes).filter(([, a]) => a.required).map(([n]) => n);
  return { type: 'object', additionalProperties: false, properties, ...(required.length && { required }) };
}

/** components.schemas fragment: `<Type>Attributes` for each type. Generated into contracts. */
export function generateSchemas(reg: Registry): Record<string, object> {
  const out: Record<string, object> = {};
  for (const t of reg.all().sort((a, b) => a.type.localeCompare(b.type))) out[`${t.type}Attributes`] = attributeSchema(t);
  return out;
}
