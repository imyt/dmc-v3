import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

/** P18. Loading, empty and error states. */
export function LoadingState({ label = 'Loading', rows = 4 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="space-y-3">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-6 w-full" />)}
    </div>
  );
}

/** Empty states say what DMC is already doing, not just that nothing is here. */
export function EmptyState({ title, doing, action }: { title: string; doing: string; action?: ReactNode }) {
  return (
    <div className="border border-dashed border-border p-8 text-center">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-prose text-muted-foreground">{doing}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** A plain message and the request id support can look up. */
export function ErrorState({ message, requestId, action }: { message: string; requestId?: string; action?: ReactNode }) {
  return (
    <div role="alert" className="border border-destructive p-6">
      <h3 className="text-lg font-semibold text-destructive">Something went wrong</h3>
      <p className="mt-2">{message}</p>
      {requestId && <p className="mt-2 text-sm text-muted-foreground">Request ID: <code>{requestId}</code></p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
