import addFormatsModule from 'ajv-formats';
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (a: unknown) => void;
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

type Json = Record<string, any>;

const SPEC_URL = new URL('../openapi/dmc.yaml', import.meta.url);

export function loadSpec(): Json {
  return parse(readFileSync(SPEC_URL, 'utf8')) as Json;
}

/**
 * Contract-test helper: check a response body against the OpenAPI schema for
 * (path, method, status). Used by every module's contract tests.
 * Returns a list of problems; empty means the body matches the contract.
 */
export function checkResponse(spec: Json, path: string, method: string, status: number | 'default', body: unknown): string[] {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  if (!op) return [`${method} ${path} is not in the contract`];
  let res = op.responses?.[String(status)] ?? op.responses?.default;
  if (!res) return [`${method} ${path} has no ${status} response in the contract`];
  if (res.$ref) res = resolve(spec, res.$ref);
  const media = res.content?.['application/json'] ?? res.content?.['application/problem+json'];
  if (!media) return [];
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema({ $id: 'spec', components: spec.components });
  const validate = ajv.compile({ ...rewrite(media.schema), $defs: undefined });
  return validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

function resolve(spec: Json, ref: string): Json {
  return ref.replace(/^#\//, '').split('/').reduce<Json>((o, k) => o[k], spec);
}

/** Point `#/components/...` refs at the registered spec document. */
function rewrite(node: any): any {
  if (Array.isArray(node)) return node.map(rewrite);
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? v.replace(/^#/, 'spec#') : rewrite(v)]),
    );
  }
  return node;
}
