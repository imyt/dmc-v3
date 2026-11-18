import { Radio, RadioGroup, Label, Switch } from 'react-aria-components';

export type Digest = 'immediate' | 'daily' | 'weekly';
export interface NotificationPrefs { digest: Digest; email: boolean; teams: boolean }

/** P24. Digest frequency and channel per person. */
export function NotificationSettings({ value, onChange }: { value: NotificationPrefs; onChange(v: NotificationPrefs): void }) {
  const opts: [Digest, string][] = [['immediate', 'As they happen'], ['daily', 'Daily digest'], ['weekly', 'Weekly digest']];
  return (
    <form aria-label="Notification settings" className="max-w-md space-y-6" onSubmit={(e) => e.preventDefault()}>
      <RadioGroup value={value.digest} onChange={(d) => onChange({ ...value, digest: d as Digest })}>
        <Label className="mb-2 block font-semibold">How often</Label>
        {opts.map(([v, l]) => (
          <Radio key={v} value={v} className="group flex items-center gap-2 py-1">
            <span className="flex size-4 items-center justify-center rounded-full border border-input group-data-[selected]:border-brand group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring"><span className="hidden size-2 rounded-full bg-brand group-data-[selected]:block" /></span>{l}
          </Radio>
        ))}
      </RadioGroup>
      <fieldset className="space-y-2"><legend className="mb-2 font-semibold">Where</legend>
        {([['email', 'Email'], ['teams', 'Microsoft Teams']] as const).map(([k, l]) => (
          <Switch key={k} isSelected={value[k]} onChange={(on) => onChange({ ...value, [k]: on })} className="group flex items-center gap-3">
            <span className="flex h-5 w-9 items-center border border-input bg-background p-0.5 group-data-[selected]:bg-brand group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring"><span className="size-3.5 bg-foreground transition-transform group-data-[selected]:translate-x-4 group-data-[selected]:bg-brand-foreground" /></span>{l}
          </Switch>
        ))}
      </fieldset>
    </form>
  );
}
