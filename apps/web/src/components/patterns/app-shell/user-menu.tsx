import { Monitor, Moon, Sun, User } from '@phosphor-icons/react';
import { Button as AriaButton } from 'react-aria-components';
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ThemePref } from '@/lib/theme';

const LABEL: Record<ThemePref, string> = { system: 'Match system', light: 'Light', dark: 'Dark' };
const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

export function UserMenu({ name, detail, pref, onPref, onSignOut }: { name: string; detail?: string; pref: ThemePref; onPref(p: ThemePref): void; onSignOut?(): void }) {
  return (
    <DropdownMenuTrigger>
      <AriaButton aria-label={`Account menu for ${name}`} className="flex h-10 items-center gap-2 px-2 text-sm hover:bg-muted">
        <span className="flex size-8 items-center justify-center rounded-full bg-muted"><User aria-hidden className="size-4" /></span>
        <span className="hidden md:inline">{name}</span>
      </AriaButton>
      <DropdownMenu
        aria-label="Account"
        placement="bottom end"
        selectionMode="single"
        selectedKeys={[pref]}
        onAction={(key) => { if (key === 'signout') onSignOut?.(); }}
        onSelectionChange={(keys) => { const k = [...(keys as Set<string>)][0] as ThemePref | undefined; if (k && k in LABEL) onPref(k); }}
        className="min-w-56"
      >
        {detail && <DropdownMenuLabel>{detail}</DropdownMenuLabel>}
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {(Object.keys(LABEL) as ThemePref[]).map((k) => {
          const Icon = ICON[k];
          return <DropdownMenuItem key={k} id={k} textValue={LABEL[k]}><Icon aria-hidden className="size-4" />{LABEL[k]}</DropdownMenuItem>;
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem id="notifications" textValue="Notification settings">Notification settings</DropdownMenuItem>
        <DropdownMenuItem id="signout" textValue="Sign out">Sign out</DropdownMenuItem>
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
