import { Link } from '@tanstack/react-router';
import { Tray } from '@phosphor-icons/react';
import { GlobalSearch } from './global-search';
import { UserMenu } from './user-menu';
import type { ThemePref } from '@/lib/theme';

export interface HeaderProps {
  userName: string;
  userDetail?: string;
  onSignOut?(): void;
  inboxCount: number;
  themePref: ThemePref;
  onThemePref(p: ThemePref): void;
  onSearch(q: string): void;
  suggest?(q: string): Promise<import('./global-search').Suggestion[]>;
  onPick?(s: import('./global-search').Suggestion): void;
}

/** Brand header: wordmark, global search, inbox count, user menu. Logo files come from the brand team (DESIGN.md §9); until then a text wordmark. */
export function Header({ userName, userDetail, onSignOut, inboxCount, themePref, onThemePref, onSearch, suggest, onPick }: HeaderProps) {
  return (
    <header className="flex h-16 items-center gap-6 border-b-4 border-brand bg-header px-4 text-header-foreground">
      <Link to="/" className="flex items-center gap-3" aria-label="Data Management Centre, home">
        <span aria-hidden className="flex size-8 items-center justify-center bg-brand text-sm font-bold text-brand-foreground">D</span>
        <span className="hidden text-lg font-semibold sm:inline">Data Management Centre</span>
      </Link>
      <div className="flex flex-1 justify-center"><GlobalSearch onSubmit={onSearch} suggest={suggest} onPick={onPick} /></div>
      <Link to="/inbox" className="relative flex h-10 items-center gap-2 px-2 text-sm hover:bg-muted" aria-label={`Inbox, ${inboxCount} waiting`}>
        <Tray aria-hidden className="size-5" />
        {inboxCount > 0 && (
          <span aria-hidden className="min-w-5 rounded-[var(--radius-badge)] bg-brand px-1.5 text-center text-xs font-semibold text-brand-foreground">{inboxCount}</span>
        )}
      </Link>
      <UserMenu name={userName} detail={userDetail} pref={themePref} onPref={onThemePref} onSignOut={onSignOut} />
    </header>
  );
}
