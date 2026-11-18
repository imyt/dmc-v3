import { Link } from '@tanstack/react-router';
import type { NavItem } from './nav-config';

/** Slim left navigation. The current page is marked with aria-current and the brand-red marker. */
export function SideNav({ items }: { items: NavItem[] }) {
  return (
    <nav aria-label="Main" className="w-14 shrink-0 border-r border-border bg-sidebar md:w-56">
      <ul className="flex flex-col py-2">
        {items.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              activeOptions={{ exact: to === '/' || to === '/admin' }}
              title={label}
              className="flex h-11 items-center gap-3 border-l-4 border-transparent px-4 text-sm hover:bg-muted data-[status=active]:border-brand data-[status=active]:bg-muted data-[status=active]:font-semibold"
            >
              <Icon aria-hidden className="size-5 shrink-0" />
              <span className="sr-only md:not-sr-only">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
