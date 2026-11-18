// Production build (task F2/ADR 0021): bundles the API and the worker (with the migrate command) into dist/, and copies the data files
// the packages read next to their own source (JSON schemas, the OpenAPI document) into dist/assets/ so the bundle can find them.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true }); mkdirSync(join(dist, 'assets'), { recursive: true });

const copied = new Map();
const copyAsset = (from, isDir) => {
  const id = createHash('sha1').update(from).digest('hex').slice(0, 8);
  if (!copied.has(from)) { cpSync(from, join(dist, 'assets', id, isDir ? '' : basename(from)), { recursive: true }); copied.set(from, id); }
  return copied.get(from);
};

/** `new URL('<relative path>', import.meta.url)` points at a file beside the source; after bundling it must point into dist/assets. */
const assets = {
  name: 'assets',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      if (args.path.includes('node_modules') || !args.path.startsWith(root)) return null;
      let src = readFileSync(args.path, 'utf8');
      if (!src.includes('import.meta.url')) return { contents: src, loader: 'ts' };
      src = src.replace(/new URL\((['`])([^'`]+)\1,\s*import\.meta\.url\)/g, (m, q, rel) => {
        if (!rel.startsWith('.')) return m;
        const dyn = rel.indexOf('${');
        if (dyn >= 0) {
          const dirRel = rel.slice(0, rel.lastIndexOf('/', dyn) + 1);
          const id = copyAsset(resolve(dirname(args.path), dirRel), true);
          return `new URL(${q}./assets/${id}/${rel.slice(dirRel.length)}${q}, import.meta.url)`;
        }
        const file = resolve(dirname(args.path), rel);
        if (!statSync(file).isFile()) return m;
        return `new URL('./assets/${copyAsset(file, false)}/${basename(file)}', import.meta.url)`;
      });
      return { contents: src, loader: 'ts' };
    });
  },
};

const common = {
  bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: true, logLevel: 'info', plugins: [assets],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  external: ['pg-native', '@nestjs/microservices', '@nestjs/microservices/*', '@nestjs/websockets', '@nestjs/websockets/*', '@nestjs/platform-express', 'class-validator', 'class-transformer', 'cache-manager', '@fastify/view', '@fastify/static', '@fastify/cors', '@fastify/formbody', '@fastify/multipart', 'embedded-postgres', '@google-cloud/bigquery'],
};
await build({ ...common, entryPoints: { api: join(root, 'scripts/run.ts') }, outfile: join(dist, 'dmc.mjs') });
console.log(`built dist/dmc.mjs and ${copied.size} asset folders`);
