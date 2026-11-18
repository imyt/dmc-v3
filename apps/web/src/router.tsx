import { Outlet, createRootRoute, createRoute, createRouter, createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { AppShell, type AppShellProps } from '@/components/patterns/app-shell';
import type { Role } from '@/components/patterns/app-shell/nav-config';
import { Home, Placeholder } from '@/features/home/home';
import { InboxRoute } from '@/features/inbox/inbox-route';
import { ObjectRoute } from '@/features/object/object-route';
import { SearchRoute } from '@/features/search/search-route';
import { DataProvider, useOptionalData, type DataSource } from '@/lib/data';
import { ScopeListRoute, ScopeRoute } from '@/features/scopes/scopes-route';
import { DatasetsRoute } from '@/features/datasets/datasets-route';
import { RequirementsRoute } from '@/features/requirements/requirements-route';
import { AuditRoute } from '@/features/audit/audit-route';
import { DashboardRoute } from '@/features/dashboard/dashboard-route';
import { HelpRoute } from '@/features/help/help-route';
import { ClassificationsRoute } from '@/features/classifications/classifications-route';
import { AdminRoute } from '@/features/admin/admin-route';
import { Gallery } from '@/gallery/gallery';
import { LineageRoute } from '@/features/lineage/lineage-route';
import { AuthGate } from '@/features/auth/auth-gate';
import { createDataSource, type AuthUser } from '@/lib/data';
import { useCallback, useMemo } from 'react';

function InboxGate() { return useOptionalData() ? <InboxRoute /> : <Placeholder title="Inbox" />; }

export function buildRouter(opts: { shell?: Omit<AppShellProps, 'children'>; history?: RouterHistory; data?: DataSource } = {}) {
  const root = createRootRoute({ component: () => {
    const page = <AppShell {...opts.shell}><Outlet /></AppShell>;
    return opts.data ? <DataProvider source={opts.data}>{page}</DataProvider> : page;
  } });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: Home });
  const search = createRoute({
    getParentRoute: () => root, path: '/search',
    validateSearch: (s: Record<string, unknown>) => ({ q: typeof s.q === 'string' ? s.q : '' }),
    component: SearchRoute,
  });
  const object = createRoute({ getParentRoute: () => root, path: '/o/$qn', component: ObjectRoute });
  const inbox = createRoute({ getParentRoute: () => root, path: '/inbox', component: InboxGate });
  const catalog = createRoute({ getParentRoute: () => root, path: '/catalog', component: () => <Placeholder title="Catalog" /> });
  const scopes = createRoute({ getParentRoute: () => root, path: '/scopes', component: () => (useOptionalData() ? <ScopeListRoute /> : <Placeholder title="Scopes" />) });
  const scope = createRoute({ getParentRoute: () => root, path: '/scopes/$qn', component: function C() { const { qn } = scope.useParams(); return <ScopeRoute qn={qn} />; } });
  const datasets = createRoute({ getParentRoute: () => root, path: '/integrations/$qn/datasets', component: function C() { const { qn } = datasets.useParams(); return <DatasetsRoute integration={qn} />; } });
  const requirements = createRoute({ getParentRoute: () => root, path: '/requirements', component: RequirementsRoute });
  const audit = createRoute({ getParentRoute: () => root, path: '/audit', component: AuditRoute });
  const dashboard = createRoute({ getParentRoute: () => root, path: '/dashboard', component: DashboardRoute });
  const help = createRoute({ getParentRoute: () => root, path: '/help/$role', component: function C() { const { role } = help.useParams(); return <HelpRoute role={role} />; } });
  const helpIndex = createRoute({ getParentRoute: () => root, path: '/help', component: () => <HelpRoute role="" /> });
  const policies = createRoute({ getParentRoute: () => root, path: '/policies', component: () => <Placeholder title="Policies" /> });
  const evidence = createRoute({ getParentRoute: () => root, path: '/evidence', component: () => <Placeholder title="Evidence" /> });
  const admin = createRoute({ getParentRoute: () => root, path: '/admin', component: () => (useOptionalData() ? <AdminRoute /> : <Placeholder title="Admin" />) });
  const lineage = createRoute({ getParentRoute: () => root, path: '/lineage/$qn', component: function C() { const { qn } = lineage.useParams(); return useOptionalData() ? <LineageRoute qn={qn} /> : <Placeholder title="Lineage" />; } });
  const classifications = createRoute({ getParentRoute: () => root, path: '/classifications', component: () => (useOptionalData() ? <ClassificationsRoute /> : <Placeholder title="Classifications" />) });
  const gallery = createRoute({ getParentRoute: () => root, path: '/gallery', component: Gallery });
  return createRouter({ routeTree: root.addChildren([home, search, object, inbox, catalog, scopes, scope, datasets, requirements, audit, dashboard, help, helpIndex, policies, evidence, admin, lineage, classifications, gallery]), history: opts.history });
}

export type AppRouter = ReturnType<typeof buildRouter>;
declare module '@tanstack/react-router' { interface Register { router: AppRouter } }

const API_BASE = (import.meta.env?.VITE_DMC_API as string | undefined) ?? '';

/** The running app: the API through the generated SDK, behind the sign-in. */
export function App() {
  const data = useMemo(() => createDataSource(API_BASE), []);
  const build = useCallback((u: AuthUser, signOut: () => void) => buildRouter({ data, shell: { roles: u.roles ? (u.roles as Role[]) : 'all', userName: u.displayName, userDetail: `Staff ID ${u.staffID}`, onSignOut: signOut } }), [data]);
  return <AuthGate data={data} build={build} />;
}
export { createMemoryHistory };
