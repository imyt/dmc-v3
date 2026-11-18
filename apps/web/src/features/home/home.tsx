import { Link } from '@tanstack/react-router';
import { PageHeader } from '@/components/patterns/page-header';

export function Home() {
  return (
    <>
      <PageHeader title="Data Management Centre" description="Search for anything, or open your inbox to see what needs a decision." />
      <div className="mx-auto max-w-[var(--content-max)] px-8 py-8">
        <p className="text-muted-foreground">Nothing needs your attention right now.</p>
        <p className="mt-4 text-sm">New here? <Link to="/help" className="underline">Read the help page for your role</Link>.</p>
      </div>
    </>
  );
}

export function Placeholder({ title }: { title: string }) {
  return (
    <>
      <PageHeader eyebrow="Coming soon" title={title} />
      <div className="mx-auto max-w-[var(--content-max)] px-8 py-8"><p className="text-muted-foreground">This area is built in a later task.</p></div>
    </>
  );
}
