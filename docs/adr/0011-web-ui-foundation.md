# 0011. Web UI foundation: shadcn/ui on React Aria, DMC tokens

Status: accepted

## Context
F7 needs a component base that meets the corporate look in DESIGN.md and WCAG 2.2 AA, and that agents can extend without drifting.

## Decision
- shadcn/ui with the `aria-sera` style (React Aria Components underneath), Tailwind v4, lucide icons, `cn` from the shadcn-ui `cn` package.
- Generated components stay untouched in `src/components/ui`. The look is changed only through tokens in `src/styles/tokens.css` and a small `[data-slot]` override layer (radius 4px/2px, sentence case, no letter spacing). Upgrading shadcn is then a re-run, not a merge.
- Routing: TanStack Router, code-based routes (typed). Theme: light by default, follows the OS, per-user override stored in localStorage (`dmc-theme`) and applied as the `dark` class.
- Fonts: Univers Next falls back to Arial and a text wordmark is used until the brand team supplies files (DESIGN.md allows this).
- The web app is a separate TypeScript project (JSX, DOM) with its own vitest config; root typecheck and tests exclude it, CI runs `typecheck:web` and `test:web`.

## Consequences
New dependencies: react, react-dom, react-aria-components, @tanstack/react-router, tailwindcss, vite, class-variance-authority, clsx, tailwind-merge, tw-animate-css, lucide-react, cn, shadcn (dev), testing-library, jsdom.
Roles in the navigation come from the API once F4 (SSO) is built; until then all items show.

Update 2026-11-18: icons moved from lucide-react to @phosphor-icons/react (design change); lucide-react removed. Visual-test baselines need regenerating.
