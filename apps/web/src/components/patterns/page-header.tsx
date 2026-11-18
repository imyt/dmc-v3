import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';

export interface Crumb { label: string; to?: string }

/** P21. Breadcrumbs, title, description and actions in the full-width band at the top of every page. */
export function PageHeader({ eyebrow, title, description, actions, crumbs }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode; crumbs?: Crumb[] }) {
  return (
    <div className="border-b border-border bg-muted">
      <div className="mx-auto max-w-[var(--content-max)] px-8 py-8">
        {crumbs && crumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="mb-3 text-sm">
            <ol className="flex flex-wrap items-center gap-2">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <li key={c.label} className="flex items-center gap-2">
                    {c.to && !last ? <Link to={c.to} className="text-brand-text underline underline-offset-2">{c.label}</Link> : <span aria-current={last ? 'page' : undefined}>{c.label}</span>}
                    {!last && <span aria-hidden className="text-muted-foreground">/</span>}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <div className="flex items-end justify-between gap-6">
          <div>
            {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
            <h1 className="text-[32px] leading-10">{title}</h1>
            {description && <p className="mt-2 max-w-prose text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  );
}
