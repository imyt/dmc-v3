import { House, Tag, MagnifyingGlass, Database, ListChecks, ShieldCheck, Tray, Scroll, Gear, ClipboardText, ChartBar, type Icon } from '@phosphor-icons/react';

export type Role = 'viewer' | 'app-owner' | 'steward' | 'scope-owner' | 'policy-author' | 'control-owner' | 'auditor' | 'admin';

export interface NavItem { to: string; label: string; icon: Icon; roles?: Role[] }

/** Left navigation. `roles` limits who sees an item; omitted means everyone. The API sends the roles it mapped from the person's groups. */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/search', label: 'Search', icon: MagnifyingGlass },
  { to: '/inbox', label: 'Inbox', icon: Tray },
  { to: '/catalog', label: 'Catalog', icon: Database },
  { to: '/scopes', label: 'Scopes', icon: ListChecks, roles: ['app-owner', 'scope-owner', 'steward', 'admin'] },
  { to: '/requirements', label: 'Requirements', icon: ClipboardText, roles: ['policy-author', 'control-owner', 'auditor', 'admin'] },
  { to: '/classifications', label: 'Classifications', icon: Tag, roles: ['steward', 'admin'] },
  { to: '/policies', label: 'Policies', icon: ShieldCheck, roles: ['policy-author', 'control-owner', 'admin'] },
  { to: '/dashboard', label: 'Dashboard', icon: ChartBar, roles: ['policy-author', 'control-owner', 'auditor', 'admin'] },
  { to: '/audit', label: 'Evidence', icon: Scroll, roles: ['control-owner', 'auditor', 'admin'] },
  { to: '/admin', label: 'Admin', icon: Gear, roles: ['control-owner', 'admin'] },
];

export const visibleItems = (roles: Role[] | 'all'): NavItem[] =>
  NAV_ITEMS.filter((i) => roles === 'all' || !i.roles || i.roles.some((r) => roles.includes(r)));
