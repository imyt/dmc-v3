import { useEffect, useMemo, useState } from 'react';
import { RouterProvider } from '@tanstack/react-router';
import type { AuthUser, DataSource } from '@/lib/data';
import { LoadingState } from '@/components/patterns/states';
import { LoginRoute } from './login-route';

/**
 * Nobody sees a page until /v1/auth/me says who they are. A 401 from any later call (the session ended) brings the login back.
 * `build` makes the router for the signed-in person, so the header can show their name and staff ID.
 */
export function AuthGate({ data, build }: { data: DataSource; build(user: AuthUser, signOut: () => void): React.ComponentProps<typeof RouterProvider>['router'] }) {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    data.me().then((u) => live && setUser(u), () => live && setUser(null));
    const out = () => setUser(null);
    window.addEventListener('dmc:unauthorized', out);
    return () => { live = false; window.removeEventListener('dmc:unauthorized', out); };
  }, [data]);
  const router = useMemo(() => (user ? build(user, () => { void data.logout().finally(() => setUser(null)); }) : undefined), [user, data, build]);
  if (user === undefined) return <LoadingState label="Checking your session" />;
  if (!user || !router) return <LoginRoute data={data} onSignedIn={setUser} />;
  return <RouterProvider router={router} />;
}
