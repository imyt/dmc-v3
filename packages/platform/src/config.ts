import { join } from 'node:path';

export const ENVIRONMENTS = ['local', 'uat', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Every module has its own database role and schema (ground rule 3); each role has its own password. */
export const MODULES = ['catalog', 'decision', 'workflow', 'policy', 'actions', 'connectors', 'evidence', 'trust'] as const;
export type ModuleName = (typeof MODULES)[number];

export interface AppConfig {
  environment: Environment;
  /** the repository layout: metamodel/, config/, policies/, packages/, sync/ */
  root: string;
  db: { host: string; port: number; name: string; adminUser: string; adminPassword?: string; passwords: Partial<Record<ModuleName, string>> };
  http: { host: string; port: number };
  /** the separate audit database (E2); absent when DMC_AUDIT_DB_HOST is not set */
  /** where email goes; absent when DMC_SMTP_HOST is not set (notifications are then written to the log) */
  smtp?: { host: string; port: number; secure: boolean; user?: string; passwordRef?: string; from: string };
  /** the address people reach the web app on, for links in email */
  publicUrl: string;
  audit?: { host: string; port: number; name: string; adminUser: string; adminPassword?: string; writerPassword?: string };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid configuration:\n - ${problems.join('\n - ')}`); }
}

/**
 * Reads the process environment. Nothing secret has a default outside `local`, and a missing value is named, not guessed.
 * DMC_ENVIRONMENT, DMC_ROOT, DMC_DB_HOST/PORT/NAME, DMC_DB_ADMIN_USER/PASSWORD, DMC_DB_PASSWORD_<MODULE>, DMC_HTTP_HOST/PORT.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const problems: string[] = [];
  const environment = (env.DMC_ENVIRONMENT ?? 'local') as Environment;
  if (!ENVIRONMENTS.includes(environment)) problems.push(`DMC_ENVIRONMENT must be one of ${ENVIRONMENTS.join(', ')} (got ${env.DMC_ENVIRONMENT})`);
  const local = environment === 'local';
  const num = (name: string, fallback: number): number => {
    const v = env[name];
    if (v === undefined || v === '') return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) { problems.push(`${name} must be a port number (got ${v})`); return fallback; }
    return n;
  };
  const passwords: AppConfig['db']['passwords'] = {};
  for (const m of MODULES) {
    const v = env[`DMC_DB_PASSWORD_${m.toUpperCase()}`];
    if (v) passwords[m] = v;
    else if (local) passwords[m] = m; // local stack only: password equals the module name
  }
  const adminPassword = env.DMC_DB_ADMIN_PASSWORD ?? (local ? 'dmc' : undefined);
  const cfg: AppConfig = {
    environment, root: env.DMC_ROOT ?? process.cwd(),
    db: { host: env.DMC_DB_HOST ?? (local ? 'localhost' : ''), port: num('DMC_DB_PORT', 5432), name: env.DMC_DB_NAME ?? 'dmc', adminUser: env.DMC_DB_ADMIN_USER ?? 'dmc', adminPassword, passwords },
    http: { host: env.DMC_HTTP_HOST ?? '0.0.0.0', port: num('DMC_HTTP_PORT', 8080) },
    publicUrl: env.DMC_PUBLIC_URL ?? (local ? 'http://localhost:5173' : ''),
  };
  if (env.DMC_SMTP_HOST) {
    const from = env.DMC_SMTP_FROM ?? (local ? 'dmc@localhost' : undefined);
    if (!from) problems.push('DMC_SMTP_FROM is required when DMC_SMTP_HOST is set');
    cfg.smtp = { host: env.DMC_SMTP_HOST, port: num('DMC_SMTP_PORT', 587), secure: env.DMC_SMTP_SECURE === 'true', ...(env.DMC_SMTP_USER ? { user: env.DMC_SMTP_USER } : {}), ...(env.DMC_SMTP_PASSWORD_REF ? { passwordRef: env.DMC_SMTP_PASSWORD_REF } : {}), from: from ?? '' };
  }
  if (env.DMC_AUDIT_DB_HOST) {
    const writerPassword = env.DMC_AUDIT_DB_WRITER_PASSWORD ?? (local ? 'audit-writer' : undefined);
    if (!writerPassword) problems.push('DMC_AUDIT_DB_WRITER_PASSWORD is required when DMC_AUDIT_DB_HOST is set');
    cfg.audit = { host: env.DMC_AUDIT_DB_HOST, port: num('DMC_AUDIT_DB_PORT', 5432), name: env.DMC_AUDIT_DB_NAME ?? 'audit', adminUser: env.DMC_AUDIT_DB_ADMIN_USER ?? 'audit', adminPassword: env.DMC_AUDIT_DB_ADMIN_PASSWORD ?? (local ? 'audit' : undefined), ...(writerPassword ? { writerPassword } : {}) };
  }
  if (!cfg.db.host) problems.push('DMC_DB_HOST is required');
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

/** The password for a module's role, or an error naming the variable to set. */
export function passwordFor(cfg: AppConfig, m: ModuleName): string {
  const p = cfg.db.passwords[m];
  if (!p) throw new ConfigError([`DMC_DB_PASSWORD_${m.toUpperCase()} is required`]);
  return p;
}

export const repoPath = (cfg: AppConfig, ...parts: string[]): string => join(cfg.root, ...parts);

/** Connector secrets: a job names a secret reference, and the value comes from DMC_SECRET_<REF> (upper case, other characters as `_`). */
export function secretFromEnv(env: Record<string, string | undefined> = process.env): (ref: string) => Promise<string> {
  return async (ref) => {
    const name = `DMC_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const v = env[name];
    if (!v) throw new ConfigError([`${name} is not set (secret "${ref}")`]);
    return v;
  };
}
