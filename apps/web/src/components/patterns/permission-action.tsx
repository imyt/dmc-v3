import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export interface AllowedAction { id: string; label: string; allowed: boolean; reason?: string }

/** P20. Driven by the API's allowed actions: hidden when not allowed, or disabled with the reason when the user would expect it. */
export function PermissionAction({ action, onPress, expected = false, children }: { action: AllowedAction | undefined; onPress(): void; expected?: boolean; children?: ReactNode }) {
  if (!action) return null;
  if (action.allowed) return <Button onPress={onPress}>{children ?? action.label}</Button>;
  if (!expected) return null;
  const hint = action.reason ?? 'You do not have permission';
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button isDisabled aria-describedby={`why-${action.id}`}>{children ?? action.label}</Button>
      <span id={`why-${action.id}`} className="text-xs text-muted-foreground">{hint}</span>
    </span>
  );
}
