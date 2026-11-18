import addFormatsModule from 'ajv-formats';
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (a: unknown) => void;
import { Ajv2020 } from 'ajv/dist/2020.js';
import { attributeSchema } from './codegen.js';
import type { Registry } from '@dmc/platform';

export interface WriteProblem { path: string; message: string }

export type Writer = { kind: 'user' } | { kind: 'sync'; source: string };

/**
 * Validates attributes for a write (ground rules: one source of truth per attribute; synced fields are read-only).
 * - shape, required fields, enum values and formats come from the metamodel
 * - a user (or workflow) may set only attributes whose source is `dmc`
 * - a sync job may set only attributes whose source is its own source
 * `partial` is for updates: required fields need not be present.
 */
export function makeWriteValidator(reg: Registry) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const full = new Map<string, ReturnType<typeof ajv.compile>>();
  const part = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const t of reg.all()) {
    const s = attributeSchema(t) as { required?: string[] };
    full.set(t.type, ajv.compile(s));
    part.set(t.type, ajv.compile({ ...s, required: undefined }));
  }
  return (type: string, attrs: Record<string, unknown>, writer: Writer, opts: { partial?: boolean } = {}): WriteProblem[] => {
    if (!reg.has(type)) return [{ path: 'type', message: `unknown type ${type}` }];
    const def = reg.get(type);
    const problems: WriteProblem[] = [];
    const v = (opts.partial ? part : full).get(type)!;
    if (!v(attrs)) {
      for (const e of v.errors ?? []) {
        const params = e.params as { missingProperty?: string; additionalProperty?: string };
        const path = e.instancePath.replace(/^\//, '') || params.missingProperty || params.additionalProperty || '';
        const value = e.keyword === 'pattern' ? attrs[path] : undefined;
        const lost = typeof value === 'string' && /^\d+$/.test(value) ? ' (all digits but the wrong length: leading zeros may have been lost; it is not padded)' : '';
        problems.push({ path, message: params.additionalProperty ? 'is not an attribute of this type' : `${e.message ?? 'invalid'}${lost}` });
      }
    }
    const allowed = writer.kind === 'user' ? 'dmc' : writer.source;
    for (const name of Object.keys(attrs)) {
      const a = def.attributes[name];
      if (a && a.source !== allowed)
        problems.push({ path: name, message: `is read-only here: its source is ${a.source}` });
    }
    return problems;
  };
}
