import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EnumField, TextInputField } from './form-fields';
import { StatusBadge, type PolicyMode } from './status-badge';

export interface PolicyIssue { line?: number; message: string }
export interface DryRunRow { subject: string; outcome: 'allow' | 'deny' | 'escalate'; reason: string }

/** P15. Form beside the YAML/CEL text, live validation, dry-run results, and "Open pull request". Policies are files in git; this never saves them any other way. */
export function PolicyEditor({ initialYaml, validate, dryRun, onOpenPullRequest }: {
  initialYaml: string;
  validate(yaml: string): Promise<PolicyIssue[]>;
  dryRun(yaml: string): Promise<DryRunRow[]>;
  onOpenPullRequest(yaml: string): void;
}) {
  const [yaml, setYaml] = useState(initialYaml);
  const [issues, setIssues] = useState<PolicyIssue[]>([]);
  const [rows, setRows] = useState<DryRunRow[] | null>(null);
  const [mode, setMode] = useState<PolicyMode>('shadow');
  const [name, setName] = useState('');

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => { void validate(yaml).then((r) => live && setIssues(r)); }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [yaml, validate]);

  const valid = issues.length === 0;
  return (
    <section aria-label="Policy editor" className="grid grid-cols-[18rem_1fr] gap-6">
      <form className="space-y-4" onSubmit={(e) => e.preventDefault()}>
        <TextInputField label="Name" value={name} onChange={setName} />
        <EnumField label="Mode" value={mode} onChange={(v) => setMode(v as PolicyMode)} options={[{ value: 'shadow', label: 'Shadow' }, { value: 'enforced', label: 'Enforced' }]} />
        <p className="text-sm text-muted-foreground">Mode on save: <StatusBadge kind="mode" value={mode} /></p>
      </form>
      <div>
        <label htmlFor="policy-yaml" className="mb-1 block text-sm font-semibold">Policy (YAML with CEL)</label>
        <textarea id="policy-yaml" spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} aria-invalid={!valid} aria-describedby="policy-issues" rows={14} className="w-full border border-input bg-background p-3 font-mono text-sm" />
        <div id="policy-issues" role="status" className="mt-1 text-sm">
          {valid ? <span className="text-success">Valid</span> : <ul className="text-destructive">{issues.map((i, n) => <li key={n}>{i.line ? `Line ${i.line}: ` : ''}{i.message}</li>)}</ul>}
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="outline" isDisabled={!valid} onPress={async () => setRows(await dryRun(yaml))}>Dry run</Button>
          <Button isDisabled={!valid} onPress={() => onOpenPullRequest(yaml)}>Open pull request</Button>
        </div>
        {rows && (
          <table className="mt-4 w-full text-sm"><caption className="mb-1 text-left font-semibold">Dry-run results</caption>
            <thead className="bg-muted"><tr><th scope="col" className="px-2 py-1 text-left">Subject</th><th scope="col" className="px-2 py-1 text-left">Outcome</th><th scope="col" className="px-2 py-1 text-left">Reason</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-border"><td className="px-2 py-1">{r.subject}</td><td className="px-2 py-1 font-semibold">{r.outcome}</td><td className="px-2 py-1">{r.reason}</td></tr>)}</tbody></table>
        )}
      </div>
    </section>
  );
}
