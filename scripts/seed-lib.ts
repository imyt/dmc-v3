import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from '../packages/platform/src/index';
import type { CatalogStore } from '../packages/catalog/src/index';

/**
 * Synthetic data for the local environment. Everything goes through the catalog's normal write path with the writer the real source would use
 * (a sync source, or a person for what DMC masters), so validation, provenance and the evidence outbox all apply. Re-running changes nothing.
 */
type W = { kind: 'user' } | { kind: 'sync'; source: string };
const sync = (source: string): W => ({ kind: 'sync', source });
const USER: W = { kind: 'user' };
const ACTOR = 'seed';
const fixture = <T>(root: string, name: string): T[] => (JSON.parse(readFileSync(join(root, 'sync/fixtures', `${name}.json`), 'utf8')) as { records: T[] }).records;

export interface SeedResult { nodes: number; edges: number }

export async function seed(store: CatalogStore, db: Queryable, root: string): Promise<SeedResult> {
  let nodes = 0; let edges = 0;
  const node = async (type: string, qn: string, attributes: Record<string, unknown>, writer: W) => { await store.tx(db, () => store.applyNode(db, { type, qualifiedName: qn, attributes, writer, actor: ACTOR })); nodes++; };
  const link = async (name: string, from: string, to: string, source: string, attributes?: Record<string, unknown>) => { await store.tx(db, () => store.link(db, { name, fromQn: from, toQn: to, source, actor: ACTOR, ...(attributes ? { attributes } : {}) })); edges++; };

  // People as the identity provider holds them: the key is the STAFF ID, a string of 8 digits (ADR 0026), read as text from the local user list so leading zeros survive
  type User = { staffID: string; displayName: string; email?: string };
  for (const u of JSON.parse(readFileSync(join(root, 'config/local-users.json'), 'utf8')) as User[]) await node('Person', u.staffID, { email: u.email ?? `${u.staffID}@example.test`, staff_id: u.staffID, name: u.displayName }, sync('idp'));

  // ServiceNow: applications and integrations (the same fixtures the mock source serves to the sync job)
  type App = { sys_id: string; name: string; owned_by: string; delegates: string[]; criticality: string; install_status: string; country: string };
  for (const a of fixture<App>(root, 'applications')) await node('Application', a.sys_id, { name: a.name, owner: a.owned_by, delegates: a.delegates, criticality: a.criticality, status: a.install_status, hosting_country: a.country }, sync('servicenow'));
  type Int = { sys_id: string; name: string; mechanism: string; frequency: string; status: string; source_app: string; target_app: string };
  for (const i of fixture<Int>(root, 'integrations')) {
    await node('Integration', i.sys_id, { mechanism: i.mechanism, frequency: i.frequency, status: i.status }, sync('servicenow'));
    await link('source_of', i.source_app, i.sys_id, 'servicenow'); await link('target_of', i.target_app, i.sys_id, 'servicenow');
  }

  // Collibra glossary (until cutover), DSTORM record classes, DMC regulations
  await node('DataDomain', 'gl:finance', { name: 'Finance', description: 'Money, positions and the books' }, sync('collibra'));
  await node('DataDomain', 'gl:risk', { name: 'Risk', description: 'Exposure and capital' }, sync('collibra'));
  const cats: [string, string, string, string][] = [['gl:customer-pii', 'Customer personal data', 'Data that identifies a customer', 'gl:finance'], ['gl:account-balance', 'Account balance', 'Money held on an account', 'gl:finance'], ['gl:credit-exposure', 'Credit exposure', 'Amount at risk with a counterparty', 'gl:risk']];
  for (const [qn, name, definition, dom] of cats) { await node('DataCategory', qn, { name, definition }, sync('collibra')); await link('part_of', qn, dom, 'collibra'); }
  const terms: [string, string, string, string][] = [['gl:closing-balance', 'Closing balance', 'Balance at the end of the day', 'gl:account-balance'], ['gl:exposure-at-default', 'Exposure at default', 'Expected exposure if the counterparty defaults', 'gl:credit-exposure']];
  for (const [qn, name, definition, cat] of terms) { await node('BusinessTerm', qn, { name, definition, status: 'approved' }, sync('collibra')); await link('part_of', qn, cat, 'collibra'); }
  await node('RecordClass', 'dstorm:rc-7y', { code: 'RC-7Y', name: 'Seven years', description: 'Financial records kept seven years' }, sync('dstorm'));
  await node('RecordClass', 'dstorm:rc-1y', { code: 'RC-1Y', name: 'One year', description: 'Operational logs' }, sync('dstorm'));
  await node('Regulation', 'reg:pra110', { code: 'PRA110', name: 'PRA110 cash flow mismatch' }, USER);
  await node('Regulation', 'reg:bcbs239', { code: 'BCBS239', name: 'BCBS 239 risk data aggregation' }, USER);

  // Git JSON technical metadata: systems, schemas, tables, columns, lineage
  const systems: [string, string, string][] = [['git.core-banking', 'Core Banking DB', 'app-core-banking'], ['git.risk-engine', 'Risk Engine DB', 'app-risk-engine'], ['git.reg-reporting', 'Reporting DB', 'app-reg-reporting']];
  for (const [qn, name, app] of systems) { await node('System', qn, { name, platform: 'postgres', environment: 'prod' }, sync('git-json')); await link('owns', app, qn, 'servicenow'); }
  const tables: [string, string, string[]][] = [
    ['git.core-banking/ledger/accounts', 'accounts', ['account_id', 'customer_name', 'closing_balance']],
    ['git.risk-engine/exposure/positions', 'positions', ['position_id', 'account_id', 'exposure_at_default']],
    ['git.reg-reporting/returns/pra110_lines', 'pra110_lines', ['line_id', 'position_id', 'amount']],
  ];
  const colType: Record<string, string> = { customer_name: 'varchar', closing_balance: 'decimal', exposure_at_default: 'decimal', amount: 'decimal' };
  for (const [tqn, tname, cols] of tables) {
    const [sys, schema] = tqn.split('/') as [string, string];
    await node('Schema', `${sys}/${schema}`, { name: schema }, sync('git-json')); await link('contains', sys, `${sys}/${schema}`, 'git-json');
    await node('Table', tqn, { name: tname, kind: 'table', description: `${tname} (synthetic)` }, sync('git-json')); await link('contains', `${sys}/${schema}`, tqn, 'git-json');
    for (const c of cols) { await node('Column', `${tqn}/${c}`, { name: c, data_type: colType[c] ?? 'varchar', nullable: false, description: `${c.replace(/_/g, ' ')}` }, sync('git-json')); await link('contains', tqn, `${tqn}/${c}`, 'git-json'); }
  }
  const lin = (a: string, b: string) => link('derives_from', b, a, 'git-json');
  await lin('git.core-banking/ledger/accounts/closing_balance', 'git.risk-engine/exposure/positions/exposure_at_default');
  await lin('git.core-banking/ledger/accounts/account_id', 'git.risk-engine/exposure/positions/account_id');
  await lin('git.risk-engine/exposure/positions/exposure_at_default', 'git.reg-reporting/returns/pra110_lines/amount');
  await lin('git.risk-engine/exposure/positions/position_id', 'git.reg-reporting/returns/pra110_lines/position_id');
  await link('represents', 'git.core-banking/ledger/accounts/closing_balance', 'gl:closing-balance', 'dmc');
  await link('represents', 'git.risk-engine/exposure/positions/exposure_at_default', 'gl:exposure-at-default', 'dmc');

  // DataVisa tool: assessments and visas (one valid and partial, so the cross-border check has something to find)
  await node('Assessment', 'dv-as-payments-ledger', { outcome: 'datavisa-required', assessed_on: '2026-02-01', review_due: '2027-02-01' }, sync('datavisa-tool'));
  await link('assessed_by', 'int-payments-to-ledger', 'dv-as-payments-ledger', 'datavisa-tool');
  await node('DataVisa', 'dv-visa-gb-hk', { source_country: 'GB', target_country: 'HK', data_categories: ['gl:account-balance'], valid_from: '2026-02-15', valid_to: '2027-02-14', status: 'valid' }, sync('datavisa-tool'));

  // DMC-mastered: datasets, scopes, requirements
  const datasets: [string, string, string, string, string[], string, string[]][] = [
    ['int-payments-to-ledger', 'Payment postings', 'Postings from payments into the ledger', 'Used by finance close', ['gl:account-balance', 'gl:customer-pii'], 'dstorm:rc-7y', ['git.core-banking/ledger/accounts/closing_balance']],
    ['int-ledger-to-risk', 'Account exposures', 'Balances sent for exposure calculation', 'Used by credit risk', ['gl:credit-exposure'], 'dstorm:rc-7y', ['git.risk-engine/exposure/positions/exposure_at_default']],
  ];
  for (const [intg, name, description, business_context, catsOf, rc, colsOf] of datasets) {
    const dqn = `${intg}--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    await node('Dataset', dqn, { name, description, business_context }, USER);
    await link('transfers', intg, dqn, 'dmc'); await link('recorded_as', dqn, rc, 'dmc');
    for (const c of catsOf) await link('in_category', dqn, c, 'dmc');
    for (const c of colsOf) await link('realised_by', dqn, c, 'dmc');
  }
  const scopes: [string, string, string, string, string, string[]][] = [
    ['scope-pra110', 'PRA110', 'regulatory-return', 'gold', 'submitted', ['int-risk-to-reporting', 'int-ledger-to-risk']],
    ['scope-bcbs-var', 'BCBS 239 exposure report', 'report', 'silver', 'draft', ['int-ledger-to-risk']],
    ['scope-onboarding', 'Customer onboarding', 'business-process', 'bronze', 'draft', ['int-crm-to-payments']],
  ];
  for (const [qn, name, kind, tier, status, flows] of scopes) {
    await node('Scope', qn, { name, owner: '43000004', kind }, sync('scope-sources'));
    await node('Scope', qn, { required_tier: tier, version: 1, status: 'draft' }, USER);
    const g = `${qn}--core`; await node('ScopeGroup', g, { name: 'Core', order: 1 }, USER); await link('includes', qn, g, 'dmc');
    const e = `${g}--exposure`; await node('BusinessElement', e, { name: 'Exposure', definition: 'What is at risk' }, USER); await link('includes', g, e, 'dmc');
    for (const f of flows) await link('flows_through', qn, f, 'dmc');
    if (qn === 'scope-pra110') await link('implemented_by', e, 'git.risk-engine/exposure/positions/exposure_at_default', 'dmc', { app: 'app-risk-engine', state: 'confirmed', confirmed_by: '43000002' });
    if (status === 'submitted') await node('Scope', qn, { status: 'submitted', locked_at: '2026-10-01T09:00:00.000Z' }, USER);
  }
  await node('ControlRequirement', 'req-dm-1', { reference_id: 'DM-1', title: 'Every integration is linked to at least one dataset', kind: 'technical-control-requirement', owner: '43000006', version: 1 }, USER);
  await node('ControlRequirement', 'req-dm-2', { reference_id: 'DM-2', title: 'Every application has an owner', kind: 'operating-instruction', owner: '43000006', version: 1 }, USER);
  return { nodes, edges };
}
