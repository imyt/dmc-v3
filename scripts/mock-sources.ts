// Local synthetic sources: serves sync/fixtures/<name>.json at /v1/<name> so the worker's REST connector has something to read.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.DMC_MOCK_FIXTURES ?? join(import.meta.dirname, '..', 'sync', 'fixtures');
const port = Number(process.env.DMC_MOCK_PORT ?? 8099);
createServer((req, res) => {
  const name = /^\/v1\/([\w-]+)/.exec(req.url ?? '')?.[1];
  const file = name ? join(dir, `${name}.json`) : '';
  if (!name || !existsSync(file)) { res.writeHead(name ? 404 : 200, { 'content-type': 'application/json' }); res.end(name ? '{"error":"not found"}' : '{"records":[]}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(readFileSync(file));
}).listen(port, () => console.log(`mock sources on :${port}`));
