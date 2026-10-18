---
name: new-tab-route
description: >-
  Workflow for adding a tab to an existing tabbed dashboard page, or splitting a
  growing page into tabs, following this repo's one-route-per-tab convention: a
  shared +layout.svelte owning TabNav, a +layout.server.ts holding the common
  guard/load, the default tab as a bare +page.svelte, every other tab as its own
  subfolder. Use when adding a section to services/[serviceId], settings/,
  profile/, or any page shaped like them — never a client-side activeTab switch
  in one file.
---

# new-tab-route

A page made of tabs gets one real route per tab, not one big file with a
client-side `activeTab` switch — see `services/[serviceId]/` and `settings/` as
the reference shapes.

## 1. Adding a tab to an existing tabbed page

- Create `<parent>/<tab-name>/+page.svelte` (+ `+page.server.ts` if it needs its
  own `load`/`actions`).
- **Don't re-fetch what the shared layout already loaded.** If the tab only
  needs data the parent `+layout.server.ts` already fetches, its own `load` (if
  it needs one at all) calls `const { thing } = await parent();` rather than
  querying again.
- **Don't re-check `!locals.user`** in that `load` — the parent layout already
  redirected unauthenticated users before any child `load` runs. This does
  **not** apply to `actions`: a form submission doesn't go through the parent
  layout's `load`, so every action still needs its own explicit
  `if (!locals.user) redirectToSignIn();` guard
  (`#lib/server/sign-in-redirect.js`), never an inline
  `redirect(302, resolve("auth/sign-in"))`: every typed `resolve()` call costs
  the type checker about 100 ms, and 275 copies of that one made
  `bun run type-check` twice as slow.
- Add the tab to the parent `+layout.svelte`'s `tabs` array
  (`{id, label, icon, href: resolve("<parent>/<tab-name>")}`, see
  `src/lib/components/tab-nav.svelte`'s `NavTab`). Use `hasWarning` if the tab
  needs a "this needs attention" dot even while inactive (Settings' setup-issue
  highlight is the reference).

## 2. Splitting a growing single-file page into tabs

Do this once a page's `load`/actions for different sections start fighting each
other in one file (see CLAUDE.md's note on why `settings/` and
`services/[serviceId]/` were split — a client-state tab switch means every tab's
fields, `load` data, and actions all live in one file/one request).

- Move the **shared** guard/load (ownership check, anything every tab needs)
  into `<parent>/+layout.server.ts`.
- `<parent>/+layout.svelte` owns the `TabNav` bar and renders
  `{@render children()}` — copy `settings/+layout.svelte`'s shape rather than
  inventing a new tab-bar pattern.
- The first/default tab is the bare `+page.svelte` at the route's root (no
  subfolder). Every other tab gets its own subfolder with its own
  `+page.svelte`/`+page.server.ts`, scoped to only what that tab needs — don't
  let one tab's server logic leak into a file it doesn't belong to.
- Each tab keeps its own zod validation schema and its own form action(s); a
  tab's mutation still goes through `enhanceToast`/`saveToast`, not a bare
  `toast.success`.

## 3. Finish

Run `check-repo`. If this touches markup that might duplicate an existing shared
primitive (`form-styles.ts`, `empty-state.svelte`, etc.) or introduces visual
drift from an equivalent tab elsewhere, use the `ui-consistency` agent.
