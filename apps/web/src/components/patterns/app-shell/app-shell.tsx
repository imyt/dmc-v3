import type { ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useOptionalData } from '@/lib/data';
import { objectHref } from '@/features/object/model';
import { currentEnv, type DmcEnv } from '@/lib/env';
import { useTheme } from '@/lib/theme';
import { ToastHost } from '../toast';
import { EnvBanner } from './env-banner';
import { Header } from './header';
import { visibleItems, type Role } from './nav-config';
import { SideNav } from './side-nav';

export interface AppShellProps {
  children: ReactNode;
  env?: DmcEnv;
  /** until F4 provides roles from the IdP, everything is visible */
  roles?: Role[] | 'all';
  userName?: string;
  userDetail?: string;
  onSignOut?(): void;
  inboxCount?: number;
}

/** P1. Environment banner, brand header, left navigation, and the page. */
export function AppShell({ children, env = currentEnv(), roles = 'all', userName = 'Your account', userDetail, onSignOut, inboxCount = 0 }: AppShellProps) {
  const { pref, setPref } = useTheme();
  const navigate = useNavigate();
  const data = useOptionalData();
  const path = useRouterState({ select: (r) => r.location.pathname });
  const [waiting, setWaiting] = useState(0);
  // the count follows the person around: re-read it whenever they move to another page
  useEffect(() => {
    if (!data) return;
    let live = true;
    data.inbox().then((r) => live && setWaiting(r.count), () => live && setWaiting(0));
    return () => { live = false; };
  }, [data, path]);
  const suggest = useMemo(() => data && (async (q: string) => (await data.search(q, { limit: 8 })).hits.map((h) => ({ id: h.qualified_name, label: h.name, typeLabel: h.type, href: objectHref(h.qualified_name) }))), [data]);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3">Skip to content</a>
      <EnvBanner env={env} />
      <Header
        userName={userName}
        userDetail={userDetail}
        onSignOut={onSignOut}
        inboxCount={data ? waiting : inboxCount}
        themePref={pref}
        onThemePref={setPref}
        onSearch={(q) => navigate({ to: '/search', search: { q } })}
        suggest={suggest}
        onPick={(s) => void navigate({ to: '/o/$qn', params: { qn: s.id } })}
      />
      <div className="flex flex-1">
        <SideNav items={visibleItems(roles)} />
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none">{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}
