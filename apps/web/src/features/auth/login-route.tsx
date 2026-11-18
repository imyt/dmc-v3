import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiProblem, type AuthUser, type DataSource } from '@/lib/data';

const groups = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Local development only. The corporate login sets the session cookie itself (display name, staff ID, Active Directory groups); this stands in for it. */
export function LoginRoute({ data, onSignedIn }: { data: DataSource; onSignedIn(u: AuthUser): void }) {
  const [f, setF] = useState({ staffID: '', displayName: '', groups: 'dmc-scope-owner' });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!f.staffID.trim() || !f.displayName.trim()) { setErr('Enter a staff ID and a display name.'); return; }
    setBusy(true); setErr(undefined);
    try { onSignedIn(await data.mockLogin({ staffID: f.staffID.trim(), displayName: f.displayName.trim(), groups: groups(f.groups) })); }
    catch (e) { setErr(e instanceof ApiProblem ? e.detail : 'Could not sign in. Try again.'); setBusy(false); }
  };
  return (
    <main className="mx-auto mt-16 max-w-md space-y-4 border border-border p-8">
      <h1 className="text-2xl font-semibold">Sign in to the Data Management Centre</h1>
      <p className="text-sm text-muted-foreground">Local environment only: this stands in for the corporate login. Choose who you want to be and which Active Directory groups you belong to.</p>
      <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Sign in">
        <label className="block text-sm">Staff ID<Input value={f.staffID} onChange={(e) => setF({ ...f, staffID: e.target.value })} /></label>
        <label className="block text-sm">Display name<Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} /></label>
        <label className="block text-sm">Groups (comma separated)<Input value={f.groups} onChange={(e) => setF({ ...f, groups: e.target.value })} /></label>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
        <Button type="submit" isDisabled={busy}>Sign in</Button>
      </form>
    </main>
  );
}
