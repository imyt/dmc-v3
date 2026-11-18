import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Authz } from './authz/authz';
import { loadRegistry, loadSourceOfTruth, type Registry } from './metamodel/registry';
import { repoPath, type AppConfig } from './config';

/** What every process loads from the repository at start: the metamodel (with the source-of-truth switch applied) and the access rules. */
export function loadRuntime(cfg: AppConfig): { registry: Registry; authz: Authz } {
  const base = loadRegistry(repoPath(cfg, 'metamodel/types'));
  const switchFile = repoPath(cfg, 'config/source-of-truth.yaml');
  const registry = existsSync(switchFile) ? base.withSourceOfTruth(loadSourceOfTruth(switchFile)) : base;
  const authz = Authz.load(readFileSync(repoPath(cfg, 'config/authz.yaml'), 'utf8'));
  return { registry, authz };
}
