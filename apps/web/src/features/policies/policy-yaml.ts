/**
 * The form view of a policy edits the top-level `key: value` lines of its YAML and leaves everything else (scope, effect, nested blocks) alone.
 * No YAML library is needed for that: the server's check is what decides whether the text is a valid policy.
 */
const LINE = /^([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/;

export function topLevel(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of yaml.split('\n')) { const m = LINE.exec(l.replace(/\r$/, '')); if (m && m[2]) out[m[1]!] = m[2]; }
  return out;
}

/** Sets (or, for an empty value, removes) one top-level scalar line. A key that is not there yet is added after `mode`/`control`/`policy`, whichever comes last. */
export function setTopLevel(yaml: string, key: string, value: string): string {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => { const m = LINE.exec(l.replace(/\r$/, '')); return m?.[1] === key; });
  if (at >= 0) {
    if (value === '') lines.splice(at, 1); else lines[at] = `${key}: ${value}`;
    return lines.join('\n');
  }
  if (value === '') return yaml;
  let after = -1;
  lines.forEach((l, i) => { const m = LINE.exec(l.replace(/\r$/, '')); if (m && ['policy', 'control', 'mode'].includes(m[1]!)) after = i; });
  lines.splice(after + 1, 0, `${key}: ${value}`);
  return lines.join('\n');
}

/** A starting point for a new policy, or for rewriting an existing one whose source the API does not return. */
export function policyTemplate(id: string, opts: { mode?: string; implements?: string } = {}): string {
  return [
    `policy: ${id}`, 'control: ', `mode: ${opts.mode === 'enforced' ? 'enforced' : 'shadow'}`, ...(opts.implements ? [`implements: ${opts.implements}`] : []),
    'scope:', '  type: Application', 'when: "!has(application.owner) || application.owner == \'\'"',
    'effect:', '  action: raise_exception', '  message: Describe what is wrong', 'route: platform-governance', 'escalate_after: 5d', 'autonomy: act_notify', '',
  ].join('\n');
}

export const goldenTemplate = [
  'cases:', '  - name: a matching asset', '    asset: { qualified_name: example.APP1 }', '    expect: true',
  '  - name: an asset that does not match', '    asset: { qualified_name: example.APP2, owner: alice@example.com }', '    expect: false', '',
].join('\n');
