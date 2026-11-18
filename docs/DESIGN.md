# DESIGN.md — Data Management Centre (DMC)

How the DMC web app looks and behaves. Coding agents read this before any UI task. It sits next to the PRD, system design, metamodel and access-control docs in `/docs`.

Status: draft, 17 Nov 2026. Brand values follow hsbc.com; confirm exact values and font files with the brand team (plan task F7).

---

## 1. Direction

**Look: corporate site.** DMC should feel like the bank's public website, not a typical SaaS dashboard: a confident brand header, one strong brand colour, editorial headings, generous whitespace, square-ish corners, full-width page header bands, following hsbc.com. This file is the only design reference; the earlier design-principles doc is retired. The interaction rules below are carried over from it.

**Interaction rules (unchanged)**

1. Search is the front door. Global search and a command palette are reachable from anywhere by keyboard.
2. One surface, not a suite. Catalog, scopes, policies, evidence and admin are views of the same objects, not separate apps.
3. The object is the page. Every object has one canonical page with the same anatomy.
4. Low human touch. Work arrives in one inbox; each item can be decided in one action.
5. Tables for lists, facets for narrowing, side panels for editing. No modal on top of a modal.
6. Every screen is checked against: could this be removed, or could the system do it instead?

## 2. Stack

| Concern | Choice |
| --- | --- |
| App | React single-page app, Vite, TypeScript |
| Components | shadcn/ui on the React Aria base (`shadcn init --base aria`): React Aria Components + Tailwind CSS. Not Radix. |
| Style | shadcn **Sera** style (`aria-sera` in `components.json`) as the base, with the DMC overrides below |
| Routing and data | TanStack Router, TanStack Query (generated SDK from `@dmc/contracts`) |
| Tables | TanStack Table, server-side paging, sorting and filtering |
| Forms | react-hook-form + zod; zod schemas generated from the metamodel and OpenAPI |
| Icons | @phosphor-icons/react |
| Lineage canvas | React Flow (xyflow), with ELK.js for layout |
| YAML/CEL editor | CodeMirror 6, with a custom CEL language mode |
| Toasts | Sonner (shadcn) |
| Tests | Vitest + Testing Library; Playwright for journeys, visual snapshots and axe checks |

### Sera as the base, and what DMC overrides

Sera is shadcn's editorial, print-inspired style: square corners, uppercase tracked headings, underlined controls, serif headings over sans-serif body. DMC keeps its geometry, spacing and underlined controls, and overrides three things with the tokens below:

| Sera default | DMC override | Why |
| --- | --- | --- |
| Serif headings | Univers Next for HSBC for headings and body | One brand family, as on hsbc.com |
| Uppercase headings | Sentence case; uppercase only for small labels and eyebrows | Long object and term names are hard to read in capitals |
| 0 px corners | 4 px controls, 2 px badges (`--radius`) | See Radius below |

Underlined text fields must still show a clear focus ring and a visible boundary for WCAG 2.1 AA.

## 3. Tokens

All colour, type, spacing and radius come from CSS variables following the shadcn convention. No hex values in components. Light and dark themes share the same names.

### Colour

| Token | Use | Light | Dark |
| --- | --- | --- | --- |
| `--brand` | Primary actions, active navigation, key highlights (as a fill) | HSBC red `#DB0011` | HSBC red `#DB0011` |
| `--brand-text` | Red used as text, links or icons | `#DB0011` | lighter red tint that meets 4.5:1 on the dark background (for example `#FF5C66`, to confirm) |
| `--brand-foreground` | Text and icons on brand fills | white `#FFFFFF` | white `#FFFFFF` |
| `--header` / `--header-foreground` | Top header bar | white / black, red active marker, as on hsbc.com (confirm) | near-black / white, red active marker |
| `--background` / `--foreground` | Page and body text | white `#FFFFFF` / black `#000000` | near-black (for example `#121212`) / off-white (for example `#F2F2F2`) |
| `--card`, `--popover` | Raised surfaces | white | one step lighter than background (for example `#1C1C1C`) |
| `--muted` / `--muted-foreground` | Secondary surfaces and text | light grey / mid grey | dark grey / light-mid grey |
| `--border`, `--input`, `--ring` | Lines, form borders, focus ring | grey / grey / brand | dark grey / mid grey / `--brand-text` |
| `--primary` / `--primary-foreground` | Primary button | = `--brand` | = `--brand` |
| `--secondary` | Secondary button and chips | light grey | dark grey |
| `--destructive` | Destructive actions only | a darker red, distinct from the brand red | a red distinct from `--brand-text` |
| `--success`, `--warning`, `--critical`, `--info` | State only | green / amber / red / blue | lighter tints of the same hues |
| `--tier-gold`, `--tier-silver`, `--tier-bronze`, `--tier-unverified` | Trust tier badges | gold / silver / bronze / grey | lighter tints, same hues |

Rules:

- The brand colour marks the one primary action on a screen and the active navigation; state colours appear only next to a word, never alone.
- Contrast meets WCAG 2.1 AA in both themes. Brand red as a fill with white text works in both; red as text on a dark background does not, so dark mode uses `--brand-text`.
- Dark mode is not pure black: surfaces step up in lightness to show depth, because shadows barely show on dark.
- Light is the default. DMC follows the operating system setting, and a toggle in the user menu overrides it per user.
- Every pattern's visual test runs in both themes; dark values are confirmed with the brand team along with the light ones.

### Type

| Token | Size / line height | Use |
| --- | --- | --- |
| `display` | 40 / 48, semibold | Home page header only |
| `h1` | 32 / 40, semibold | Object name in the page header band |
| `h2` | 24 / 32, semibold | Section headings |
| `h3` | 18 / 28, semibold | Sub-sections, panel titles |
| `body` | 16 / 24 | Default text |
| `small` | 14 / 20 | Table cells, secondary text |
| `caption` | 12 / 16 | Labels, metadata, timestamps |
| `mono` | 14 / 20 | YAML, CEL, qualified names |

Brand font: Univers Next for HSBC (licensed; get the web font files from the brand team), falling back to `Arial, Helvetica, sans-serif`. One monospace for code. Logo files come from internal brand assets, not copied from the website.

### Space, radius, layout

- 4 px base grid; use 4, 8, 12, 16, 24, 32, 48, 64.
- Radius: `--radius` 4 px (cards, inputs), 2 px (badges). No pill shapes except avatars. At these sizes the corners still read as square; they only take the hard edge off. Set `--radius: 0` for fully square Sera corners.
- Content width up to 1280 px, centred; tables may go full width.
- Side panel widths: 480 px (edit), 720 px (policy editor, link picker).
- Breakpoints: 640, 1024, 1280. DMC is desktop-first; below 1024 px, side panels open full screen.
- Motion: 150–200 ms, only to show a change of state. Respect reduced-motion settings.

## 4. shadcn components in use (React Aria base)

Button, Input, Textarea, Select, Checkbox, RadioGroup, Switch, Label, ComboBox, Popover, Menu, Tabs, Table, Badge, Sheet, Dialog (confirmations only), AlertDialog, Tooltip, Toast, Skeleton, Breadcrumbs, Pagination, Calendar and DatePicker, DateRangePicker, Separator, Disclosure, Avatar, SearchField, TagGroup.

The React Aria base of shadcn does not yet ship a navigation menu, menubar or form wrapper. Build the left navigation (P1) directly from React Aria Components, and use React Aria's `Form` with react-hook-form for forms (P8). React Aria also gives DMC localised date and number handling out of the box.

Rules:

- shadcn components live untouched in `src/components/ui`. Style them only through tokens.
- Patterns (below) live in `src/components/patterns` and are built only from `ui` components.
- Feature screens live in `src/features/<module>` and use patterns, not raw `ui` components, wherever a pattern exists.
- A new pattern needs a short note in this file explaining why no existing one fits.
- Card is allowed only for inbox items and home tiles; default to tables and plain sections.

## 5. Common patterns (build before feature screens)

Plan task F8 builds all of these, each with a gallery page, unit tests, an axe check and a visual snapshot. Feature work starts after they exist.

| # | Pattern | What it is | Used by |
| --- | --- | --- | --- |
| P1 | App shell | Brand header (logo, global search, inbox count, user menu), slim left navigation with role-based destinations, environment banner in local and UAT | Every screen |
| P2 | Global search and command palette | Ctrl/Cmd+K; typeahead across all types; results page with facets; recent items | Home, everywhere |
| P3 | Data table | Server-side paging, sort, column visibility, sticky header, row selection with bulk actions, saved views, density toggle, CSV export of the filtered view | All lists |
| P4 | Facet panel | Filters by type, owner, domain, classification, tier, state, source; counts per value | Search, all lists |
| P5 | Object page | Header band (type, name, state, owner, trust tier, primary action), tabs: Overview, Relationships, Controls, Activity; driven entirely by the metamodel | Every object |
| P6 | Field with source | Shows a value, its source tool and last sync time; synced fields show a lock and "Request change", which creates a task for the owning tool | Object pages, forms |
| P7 | Side panel editor | Sheet with a form, dirty-state guard, server validation, optional dry-run preview of policy outcomes before save | All edits |
| P8 | Form fields | Text, enum, date range, person picker, object picker (search any type), concept picker (tree), multi-select; inline errors mapped from structured API errors | All forms |
| P9 | Inbox and decision item | Task or exception with context, recommendation, SLA, one-click decide (approve, reject, modify), comment; bulk decide where allowed | Inbox |
| P10 | Status and tier badges | Lifecycle state, trust tier, severity, policy mode (shadow, enforced); always colour plus text | Everywhere |
| P11 | Activity and evidence timeline | Events with actor (person, delegate, sync job, agent), policy version, link to ledger proof | Object pages, auditor views |
| P12 | Progress and completeness | Steps and percentage for scope submission and link completion, with what is missing | Scopes |
| P13 | Link picker | Two panes: search and select columns or tables on the left, selected links on the right, confirm; used to link datasets and business elements to columns | Datasets, scopes |
| P14 | Bulk import | CSV upload, column mapping, validation preview, dry run, commit, downloadable error report | Control requirements, datasets |
| P15 | Policy editor | Form (scope, condition, effect, mode, implements) beside a YAML/CEL editor, live validation, dry-run results table, "Open pull request" | Policies |
| P16 | Diff view | Side-by-side or inline diff for scope versions, policy changes and metamodel changes | Scopes, policies, admin |
| P17 | Lineage canvas | Focus node, expand upstream or downstream on demand, column-level toggle, stable viewport, minimal overlays, table view as the accessible alternative | Lineage |
| P18 | Empty, loading and error states | Skeletons for loading; empty states say what DMC is already doing; errors show a plain message and a request id | Everywhere |
| P19 | Feedback | Toast for the result of an action; the inbox for work that needs someone; never a modal on top of a modal | Everywhere |
| P20 | Permission-aware actions | Actions come from the API's allowed actions per object; hidden when not allowed, or shown disabled with the reason when the user expects them (for example synced fields) | Everywhere |
| P21 | Page header and breadcrumbs | Title, short description, breadcrumbs, primary and secondary actions | All pages |
| P22 | Job monitor | Runs per job and environment, status, counts, errors, run now, pause | Admin |
| P23 | Metric panel | A measure with its target, trend and breakdown (for example by business line), with a table view; follows the dataviz rules | Management dashboard |
| P24 | Notification settings | Digest frequency and channel (email, Teams) per person | User menu |

### Object page anatomy (P5)

1. **Header band:** type label, name (h1), lifecycle state, owner, trust tier, one primary action, overflow menu.
2. **Overview tab:** attributes grouped as the metamodel defines, each using P6.
3. **Relationships tab:** one section per edge type, each a compact table with links.
4. **Controls tab:** policies that govern the object (with shadow or enforced), open exceptions, DQ results, retention, cross-border status.
5. **Activity tab:** P11 timeline.

## 6. Writing in the UI

- Plain language and sentence case. Buttons start with a verb ("Link columns", "Submit scope").
- Say what happened and what happens next ("Scope submitted. App owners have been asked to link their columns.").
- Use the glossary's words for things; never internal table or module names.
- Dates as `17 Nov 2026`, times in the user's time zone with the zone shown on hover.
- Numbers with thousands separators; percentages without decimals unless under 1%.

## 7. Accessibility

- WCAG 2.1 AA in both themes.
- Everything works by keyboard: visible focus ring, logical tab order, Escape closes panels, Ctrl/Cmd+K opens search.
- Tables use real table markup with header cells; sortable columns announce their state.
- The lineage canvas always has a table view with the same information.
- Every pattern passes axe in CI.

## 8. Folder layout

```
src/
  components/ui/         shadcn components, untouched
  components/patterns/   P1–P24
  features/<module>/     screens per bounded context
  lib/                   API client (generated), auth, formatting
  styles/tokens.css      CSS variables for both themes
  gallery/               one page per pattern, used by visual tests
```

## 9. Open items

- [ ] When the repo moves to the corporate environment, add the Univers Next web font files, licence and logo files from the brand team. Until then the build uses the Arial/Helvetica fallback and a text wordmark placeholder; swapping is a change to `tokens.css` and `/public/brand` only.
