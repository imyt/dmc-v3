import { useState, type ReactNode } from 'react';
import { Button, Checkbox, CheckboxGroup, ComboBox, DateRangePicker, DateInput, DateSegment, FieldError, Group, Input, Label, ListBox, ListBoxItem, Popover, RangeCalendar, CalendarCell, CalendarGrid, Heading, Select, SelectValue, Text, TextField, Dialog } from 'react-aria-components';
import { Check, CaretDown } from '@phosphor-icons/react';

/** The structured error shape from the API (docs: conventions). `field` is a JSON pointer-ish name. */
export interface FieldIssue { field: string; message: string }
export const issueFor = (issues: FieldIssue[] | undefined, field: string) => issues?.find((i) => i.field === field)?.message;

const box = 'h-10 w-full rounded-[var(--radius)] border border-input bg-background px-3 text-sm data-[invalid]:border-destructive';
function Desc({ children }: { children?: ReactNode }) { return children ? <Text slot="description" className="mt-1 block text-xs text-muted-foreground">{children}</Text> : null; }
const Err = () => <FieldError className="mt-1 block text-sm text-destructive" />;

export function TextInputField({ label, value, onChange, error, description, required, multiline }: { label: string; value: string; onChange(v: string): void; error?: string; description?: string; required?: boolean; multiline?: boolean }) {
  return (
    <TextField value={value} onChange={onChange} isRequired={required} isInvalid={Boolean(error)} validationBehavior="aria">
      <Label className="mb-1 block text-sm font-semibold">{label}{required && <span aria-hidden className="text-destructive"> *</span>}</Label>
      {multiline ? <textarea rows={3} className={`${box} h-auto py-2`} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} /> : <Input className={box} />}
      <Desc>{description}</Desc>
      {error && <FieldError className="mt-1 block text-sm text-destructive">{error}</FieldError>}
    </TextField>
  );
}

export function EnumField({ label, value, onChange, options, error }: { label: string; value: string | null; onChange(v: string): void; options: { value: string; label: string }[]; error?: string }) {
  return (
    <Select selectedKey={value} onSelectionChange={(k) => onChange(String(k))} isInvalid={Boolean(error)} validationBehavior="aria">
      <Label className="mb-1 block text-sm font-semibold">{label}</Label>
      <Button className={`${box} flex items-center justify-between`}><SelectValue /><CaretDown aria-hidden className="size-4" /></Button>
      {error && <FieldError className="mt-1 block text-sm text-destructive">{error}</FieldError>}
      <Popover className="min-w-[var(--trigger-width)] border border-border bg-popover shadow-md">
        <ListBox className="p-1 outline-none">{options.map((o) => <ListBoxItem key={o.value} id={o.value} textValue={o.label} className="cursor-default px-3 py-2 text-sm outline-none data-[focused]:bg-muted data-[selected]:font-semibold">{o.label}</ListBoxItem>)}</ListBox>
      </Popover>
    </Select>
  );
}

export function MultiSelectField({ label, value, onChange, options }: { label: string; value: string[]; onChange(v: string[]): void; options: { value: string; label: string }[] }) {
  return (
    <CheckboxGroup value={value} onChange={onChange}>
      <Label className="mb-1 block text-sm font-semibold">{label}</Label>
      {options.map((o) => (
        <Checkbox key={o.value} value={o.value} className="group flex items-center gap-2 py-1 text-sm">
          <span className="flex size-4 items-center justify-center border border-input bg-background group-data-[selected]:border-brand group-data-[selected]:bg-brand group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring"><Check aria-hidden className="hidden size-3 text-brand-foreground group-data-[selected]:block" /></span>{o.label}
        </Checkbox>
      ))}
    </CheckboxGroup>
  );
}

export function DateRangeField({ label, error }: { label: string; error?: string }) {
  return (
    <DateRangePicker isInvalid={Boolean(error)} validationBehavior="aria">
      <Label className="mb-1 block text-sm font-semibold">{label}</Label>
      <Group className={`${box} flex items-center gap-1`}>
        <DateInput slot="start" className="flex">{(s) => <DateSegment segment={s} className="px-0.5 outline-none data-[focused]:bg-brand data-[focused]:text-brand-foreground" />}</DateInput>
        <span aria-hidden>to</span>
        <DateInput slot="end" className="flex">{(s) => <DateSegment segment={s} className="px-0.5 outline-none data-[focused]:bg-brand data-[focused]:text-brand-foreground" />}</DateInput>
        <Button className="ml-auto px-2" aria-label="Open calendar">▾</Button>
      </Group>
      {error && <FieldError className="mt-1 block text-sm text-destructive">{error}</FieldError>}
      <Popover className="border border-border bg-popover p-3 shadow-md"><Dialog>
        <RangeCalendar><header className="mb-2 flex items-center justify-between"><Button slot="previous" aria-label="Previous month">‹</Button><Heading /><Button slot="next" aria-label="Next month">›</Button></header>
          <CalendarGrid>{(d) => <CalendarCell date={d} className="size-8 text-center leading-8 outline-none data-[selected]:bg-brand data-[selected]:text-brand-foreground data-[focus-visible]:ring-2 data-[focus-visible]:ring-ring" />}</CalendarGrid></RangeCalendar>
      </Dialog></Popover>
    </DateRangePicker>
  );
}

export interface PickerOption { id: string; label: string; detail?: string }

/** Object, person and concept pickers share this: type to search, results come from the caller (the API's search). */
export function ObjectPicker({ label, search, value, onChange, error }: { label: string; search(q: string): Promise<PickerOption[]>; value: PickerOption | null; onChange(v: PickerOption | null): void; error?: string }) {
  const [items, setItems] = useState<PickerOption[]>([]);
  const [text, setText] = useState(value?.label ?? '');
  return (
    <ComboBox
      items={items} inputValue={text} selectedKey={value?.id ?? null} allowsEmptyCollection menuTrigger="focus" isInvalid={Boolean(error)} validationBehavior="aria"
      onInputChange={(t) => { setText(t); void search(t).then(setItems); }}
      onSelectionChange={(k) => { const o = items.find((i) => i.id === k) ?? null; onChange(o); if (o) setText(o.label); }}
    >
      <Label className="mb-1 block text-sm font-semibold">{label}</Label>
      <Input className={box} />
      {error && <FieldError className="mt-1 block text-sm text-destructive">{error}</FieldError>}
      <Popover className="min-w-[var(--trigger-width)] border border-border bg-popover shadow-md">
        <ListBox className="max-h-64 overflow-auto p-1 outline-none" renderEmptyState={() => <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>}>
          {(o: PickerOption) => <ListBoxItem id={o.id} textValue={o.label} className="cursor-default px-3 py-2 text-sm outline-none data-[focused]:bg-muted"><span>{o.label}</span>{o.detail && <span className="block text-xs text-muted-foreground">{o.detail}</span>}</ListBoxItem>}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
export { Err };
