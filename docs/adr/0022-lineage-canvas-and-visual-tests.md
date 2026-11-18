# 0022. Lineage canvas libraries and Playwright visual tests

Status: accepted (new dependencies need a human to confirm them, per rule 11)

## Decision
- Draw the lineage canvas (P17) with `@xyflow/react` (React Flow, MIT) and lay it out with `elkjs` (EPL-2.0), both named in DESIGN.md §2. They are used in `apps/web` only, and the canvas is loaded on demand (`React.lazy`) so the rest of the app does not pay for them.
- Add `@playwright/test` (Apache-2.0) as a dev dependency of `apps/web` for the visual tests DESIGN.md §10 asks for: pattern gallery in light and dark, the login screen, and the lineage canvas.

## Why
- The canvas has to stay readable at thousands of columns: focus on one node, expand on request, no jumping. React Flow gives pan, zoom and accessible nodes; ELK gives a layered left-to-right layout that suits lineage. Writing either by hand is far more code than the dependency.
- Layout runs on every change, but the viewport is not refitted, so expanding a side does not move what the person is looking at. A Playwright test checks this.
- The accessible alternative is a table of the same links, one row per edge, which is also what the unit tests cover.

## Consequences
- Visual tests are not part of `pnpm run ci` (no browser there). Run `pnpm exec playwright install chromium`, then `pnpm --filter @dmc/app-web run test:visual`. Baselines are Linux Chromium screenshots under `apps/web/e2e/__screenshots__`; refresh with `-- --update-snapshots` after a deliberate visual change.
- `elkjs` runs in the main thread (bundled build, no worker). For graphs beyond a few thousand nodes move it into a worker.
- Rollback: delete `features/lineage/canvas.tsx` and the three dependencies; the table view keeps working.
