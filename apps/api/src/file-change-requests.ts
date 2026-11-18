import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChangeRequestPort } from '@dmc/contracts';

/**
 * Stands in for the pull request until the config repositories exist (task R3): the change is written as a folder of the proposed
 * files plus the PR body under `dir/<id>/`, ready to be turned into a branch and a pull request. A GitHub adapter replaces this behind the same port.
 */
export class FileChangeRequests implements ChangeRequestPort {
  constructor(private readonly dir: string) {}
  async open(req: Parameters<ChangeRequestPort['open']>[0]): Promise<{ id: string; url: string }> {
    const id = `${req.repo}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
    const base = join(this.dir, id);
    for (const f of req.files) {
      const p = normalize(f.path);
      if (isAbsolute(p) || p.startsWith('..')) throw new Error(`Refusing path outside the change: ${f.path}`);
      mkdirSync(dirname(join(base, 'files', p)), { recursive: true });
      writeFileSync(join(base, 'files', p), f.content);
    }
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'PULL_REQUEST.md'), `# ${req.title}\n\nAuthor: ${req.author}\n\n${req.body}\n`);
    return { id, url: `file://${base}` };
  }
}
