import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { FieldIssue } from './form-fields';

export interface PolicyPreview { outcome: 'allow' | 'deny' | 'escalate'; summary: string }

/** P7. Edit in a side panel. Unsaved changes are guarded, server errors land on their fields, and a dry-run preview can run before saving. */
export function SidePanelEditor({ title, isOpen, onClose, dirty, onSave, children, onPreview }: {
  title: string; isOpen: boolean; onClose(): void; dirty: boolean;
  /** resolve with field issues to keep the panel open, or [] on success */
  onSave(): Promise<FieldIssue[]>;
  children(ctx: { issues: FieldIssue[] }): ReactNode;
  onPreview?(): Promise<PolicyPreview[]>;
}) {
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PolicyPreview[] | null>(null);

  const attemptClose = () => { if (dirty) setConfirm(true); else onClose(); };
  const save = async () => {
    setSaving(true);
    try { const r = await onSave(); setIssues(r); if (r.length === 0) onClose(); } finally { setSaving(false); }
  };
  return (
    <Sheet isOpen={isOpen} onOpenChange={(o) => { if (!o) attemptClose(); }} isKeyboardDismissDisabled={dirty} isDismissable={!dirty} showCloseButton={false}>
      <SheetHeader><SheetTitle>{title}</SheetTitle></SheetHeader>
      <div className="flex-1 space-y-4 overflow-auto px-8">
        {issues.length > 0 && <div role="alert" className="border border-destructive p-3 text-sm">Fix {issues.length} {issues.length === 1 ? 'problem' : 'problems'} and save again.</div>}
        {children({ issues })}
        {preview && (
          <section aria-label="Policy preview" className="border border-border p-3 text-sm">
            <h3 className="mb-1 font-semibold">What would happen</h3>
            <ul className="list-disc pl-5">{preview.map((p, i) => <li key={i}><strong>{p.outcome}</strong>: {p.summary}</li>)}</ul>
          </section>
        )}
      </div>
      {confirm ? (
        <SheetFooter role="alertdialog" aria-label="Discard changes?">
          <p className="mr-auto self-center">Discard your unsaved changes?</p>
          <Button variant="outline" onPress={() => setConfirm(false)}>Keep editing</Button>
          <Button onPress={() => { setConfirm(false); onClose(); }}>Discard</Button>
        </SheetFooter>
      ) : (
        <SheetFooter>
          {onPreview && <Button variant="outline" className="mr-auto" onPress={async () => setPreview(await onPreview())}>Preview policy outcome</Button>}
          <Button variant="outline" onPress={attemptClose}>Cancel</Button>
          <Button isDisabled={!dirty || saving} onPress={save}>Save</Button>
        </SheetFooter>
      )}
    </Sheet>
  );
}
