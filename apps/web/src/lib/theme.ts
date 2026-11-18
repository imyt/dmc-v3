import { useCallback, useEffect, useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';
const KEY = 'dmc-theme';

export function readPref(storage: Pick<Storage, 'getItem'> = window.localStorage): ThemePref {
  try {
    const v = storage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref);

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
}

/** Light is the default; follows the operating system, and a per-user choice overrides it (DESIGN.md §3). */
export function useTheme(): { pref: ThemePref; theme: Theme; setPref(p: ThemePref): void } {
  const query = '(prefers-color-scheme: dark)';
  const [pref, setPrefState] = useState<ThemePref>(() => readPref());
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.(query).matches ?? false);

  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const theme = resolveTheme(pref, systemDark);
  useEffect(() => applyTheme(theme), [theme]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try { if (p === 'system') window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, p); } catch { /* private mode */ }
  }, []);
  return { pref, theme, setPref };
}
