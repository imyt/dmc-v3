// Module boundary rules (implementation plan, ground rules 2 and 13; task F1/R1).
// Modules talk only through @dmc/contracts. Shared code is imported by package name, never by relative path.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const MODULES = [
  'gateway', 'catalog', 'scope', 'policy', 'workflow', 'trust', 'connectors', 'ingest',
  'detect', 'lineage', 'decision', 'actions', 'evidence', 'privacy',
];

// What each package may import from the @dmc/* namespace (itself is always allowed).
export function allowedFor(kind, name) {
  if (kind === 'module') return new Set(['contracts', 'platform']);
  if (name === 'contracts') return new Set();
  if (name === 'platform') return new Set(['contracts']);
  if (name === 'sdk') return new Set(['contracts']);
  if (name === 'web') return new Set(['sdk', 'contracts']);
  // api, worker, connectors deployables compose modules
  return new Set([...MODULES, 'contracts', 'platform']);
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) yield p;
  }
}

function packages(root) {
  const out = [];
  for (const [group, kind] of [['packages', null], ['apps', 'app']]) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (!statSync(dir).isDirectory()) continue;
      out.push({ name, dir, kind: kind ?? (MODULES.includes(name) ? 'module' : 'shared') });
    }
  }
  return out;
}

export function checkBoundaries(root) {
  const violations = [];
  for (const pkg of packages(root)) {
    const allowed = allowedFor(pkg.kind, pkg.name);
    for (const file of walk(pkg.dir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!spec) continue;
        const rel = relative(root, file).split(sep).join('/');
        if (spec.startsWith('.')) {
          const target = resolve(file, '..', spec);
          if (target !== pkg.dir && !target.startsWith(pkg.dir + sep)) {
            violations.push({ file: rel, spec, rule: 'relative import leaves its package; import by package name' });
          }
        } else if (spec.startsWith('/') || spec.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(spec)) {
          violations.push({ file: rel, spec, rule: 'absolute path import; import by package name' });
        } else if (spec.startsWith('@dmc/')) {
          const [, target, ...deep] = spec.split('/');
          if (deep.length) {
            violations.push({ file: rel, spec, rule: 'deep import into another package; use the package entry point' });
          } else if (target !== pkg.name && !allowed.has(target)) {
            violations.push({ file: rel, spec, rule: `${pkg.kind} "${pkg.name}" may not import @dmc/${target}` });
          }
        }
      }
    }
  }
  return violations;
}
