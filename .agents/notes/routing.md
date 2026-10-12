# Routing and page structure

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## A service's tabs

`services/[serviceId]/` is the reference tab layout (see Conventions in
`CLAUDE.md`). The top-level tabs are grouped, with a pill nav
(`section-nav.svelte`) at the top of a grouped tab picking its sub-section, each
sub-section still its own route: **Overview**, **Environments & Deployments**
(`environments/`: Environments, a read-only list of where the service runs
today, itself, its release channel canary and its pull request previews; Source;
Environment Variables (`environments/variables`); Revisions; and, for a git
service only, Previews and Channels), **Observability** (`observability/`:
Monitoring, Events, Errors, Health), **Storage** (`volumes/`), **Networking**,
**Container** (`container/`: Compute is the bare page, Runtime is
`container/runtime`), **Security**, **Terminal**, **Settings**. In simple mode
(see `ui.md`) every tab stays but several sections don't: each section layout
filters its sections through `visibleItems` from `src/lib/ui-mode.ts`. Revisions
is the deployment history that used to sit at the bottom of Overview, now with
the `image:tag` that ran, its digest, how long it took and, for a git build, the
commit linked to the provider. `logs/` still exists as a **route without a
page**: its `+server.ts` is the SSE stream `live-log-viewer.svelte` fetches.

**The entity a page shows is a path segment, never a query parameter.** A
revision is `environments/revisions/[revisionId]` (the list only links to it),
an error event is `observability/errors/[issueId]/[[eventId]]` (the bare issue
URL shows the latest event). Each detail is its own route, so its load and
markup aren't an `{#if}` branch inside the list page, and every link goes
through `resolve()` with the route id, which is what makes svelte-check catch a
stale path (the `/deployments` page's string-built
`/services/:id/revisions?deployment=` link had pointed at a route that no longer
existed). `[revisionId]` also accepts any deployment id of the revision and
answers it with a 307 to the revision's own URL, so a caller holding only a
deployment id (the deploy progress toast, `/deployments`) links with that. Query
parameters stay for list state only: sort, search, filters, the monitoring
`range`, `view=tree`, `dismissed=1`, and the new-service `stackId`/`templateId`
prefill.

Overview now leads with the service's own resource chart and a **Connections**
panel (what it needs, what needs it, derived from env vars naming another
service's slug as a host: `src/lib/service-graph.ts`'s `hostsIn` reads a URL's
host, a `host:port`, or a bare name only under a host-ish key (`*_HOST`,
`*_URL`, `*_DSN`, `*_BROKER(S)`…), so `POSTGRES_DB=stremthru` no longer counts
as a link to a service slugged `stremthru` — see Stacks' Services tab below,
which reads the same graph), an **Unlink** button per row (the `unlink` form
action, dropping every env var `linkKeys` found for that connection plus its
`secretEnvKeys` marks), plus the connection URLs for a datastore image.

## Routing: dashboard-first, with exactly one public page

`src/routes/(protected)/` is a route group living at `/` itself (not
`/dashboard`), its `+layout.server.ts` is the single auth guard, redirecting to
`/auth/sign-in` (or `/auth/sign-up` on a blank instance) when signed out,
**and** one half of the onboarding guard, redirecting to `/onboarding` when the
instance hasn't finished it (see Onboarding below for the other half,
`src/routes/onboarding/` is its own top-level route, not nested under
`(protected)/`, with its own reverse-direction `load`). There is no public
marketing page.

**Pages a signed-out visitor can load**: `src/routes/auth/**`,
`src/routes/app-auth` (a gated app's landing page: it forwards to
`/auth/sign-in` and only renders itself for the denial and "no sign-in method"
screens), and `src/routes/status/[slug]` — a published status page, deliberately
outside `(protected)/` so a signed-out visitor can read it. The public API
endpoints (webhook receiver, OAuth provider, openapi.json) are listed in
`api-and-cli.md`. Its gate is not a layout but the DTO finder it calls:
`StatusPageDTO.getPublicBySlug()` filters on `isPublic = true` and takes no
`userId`, so an unpublished page 404s for everyone. Keep that guard in the DTO
rather than the route — it's the only thing standing between a slug and a
signed-out visitor reading the instance's service list.

What that page renders is a security decision too: service names, up/down and an
uptime percentage, never an image, port, hostname, or a probe's own error text,
all of which describe infrastructure. `tests/e2e/ui-status-page.spec.ts` asserts
both halves (a published page is readable signed out and leaks none of that; an
unpublished one 404s).

The sidebar nav is grouped into six labeled categories (`category` on each item
in `(protected)/nav-items.ts`, in the order the items are listed there), and an
item with a `parent` sits under a collapsible entry of that name inside its
category (icon from `NAV_PARENT_ICONS`, `navLabel` when the item's own label
would repeat the parent's):

- **Workspace**: **Overview** (dashboard stats + recent deployments),
  **Services**, **Stacks**, **Templates**, **Deployments** (`/deployments`,
  every deploy/rollback across all services, paged by `DeploymentDTO.listPaged`
  with `status`/`trigger` filters; the trigger comes from the deploy job's
  payload via a correlated subquery, since the `deployment` row doesn't store
  one, so it's lost once `JobDTO.prune` drops the job; the dashboard's Recent
  Deployments "View all" links here), **Workstations** (`/workstations`, the
  signed-in user's own dev workstations, `[workstationId]` split into Overview
  and Settings tabs, see Dev workstations in `docker.md`).
- **Operations**: Observability (**Monitoring**, **Status Page**, see Status
  pages in `services-and-templates.md`), Scheduling (**Overview**, the
  instance-wide view of every cron redeploy, enabled cron job and backup
  schedule plus the job queue, and **Cron Jobs**, see Cron jobs below),
  **Terminal**.
- **Data**: **Volumes** (`/storage`), Backup & Restore (**Backups**, the run
  history + "Run now", and **Backup Destinations**, `/s3-destinations`, reusable
  targets: S3, SFTP, SMB, WebDAV), **Object Storage** (`/object-storage`,
  admin-only, see Object storage in `docker.md`).
- **Delivery**: Builds (**Git Providers**, **Build Cache**, registry credentials
  for cross-build cache reuse, and **Remote Hosts**, the build servers),
  Registries (**Docker Registry**, admin-only, see Registry in `docker.md`),
  Developer (**Infrastructure as Code**, **API Docs**).
- **Networking**: **Redirects**, **DNS**.
- **Administration**: **Users** (admin-only), Identity (**Authentication**,
  admin-only sign-in methods and the per-app login wall, and **IDP**),
  **Settings** (admin-only), System (**System Logs**, admin-only, and **Docker
  Cleanup**, admin-only).

A nested entry is open while one of its pages is active, otherwise as the viewer
last left it (`localStorage`, `homerun-nav-open`).

Not in the nav but real routes: `/profile/**` (reached from the profile menu,
see Appearance preferences below), `/cli-auth` (the CLI device-code approval
page), `/app-auth` (where a gated app's visitors land: it forwards signed-out
ones to `/auth/sign-in?redirectTo=…` and shows the denial screen to refused
ones, deliberately top-level rather than under `(protected)/` since it has to
render for signed-out visitors, see Per-app login wall below). The bell's own
read/delete endpoints used to live at `/notifications/**` and are now remote
commands instead, see Remote functions below. `(protected)/+layout.svelte`
filters the nav array on `data.user.role === "admin"` and on the UI mode
(`visibleItems`, see Simple and advanced UI modes in `ui.md`) before rendering,
a developer sees everything else unchanged (every account shares every
service/stack, see Shared resources in `data-and-config.md`). `/setup` was
removed (see Setup diagnostics below) in favor of the dashboard banner
deep-linking into `/settings`.

`src/routes/(protected)/services/`:

- `+page.svelte`, list, grouped by stack (with an "Ungrouped" bucket when more
  than one group exists), server-side search/status/stack filters and a
  list/card view toggle (`entity-toolbar.svelte`/`ViewMode`, see Shared UI
  components above) plus a `<Pagination>` footer (see Server-side list
  pagination above; `+page.server.ts`'s `load` calls
  `ServiceDTO.listWithStackNamesPaged` and `ServiceDTO.listFilterFacets` for the
  pills, so the filter options stay stable across pages), inline per-row
  start/stop/restart/delete actions plus a checkbox-driven multi-select
  (select-all scoped to whatever's on the **current page**, a sticky bottom bar
  with Start/Stop/Restart/Delete/Clear; paginating or changing the
  search/filters drops anything selected that's no longer on screen rather than
  silently submitting it with a bulk action). Both single-row and bulk actions
  go through four new `ServiceLifecycleService` methods
  (`startService`/`stopService`/`restartService`/`deleteService`,
  `service-lifecycle.service.ts`, each taking a `ServiceDTO` and branching on
  `svc.swarmServiceId` internally) rather than each call site re-deriving that
  branch; the pre-existing containerId-level `start`/`stop`/`restart`/`remove`
  methods are unchanged and still used elsewhere. `+page.server.ts`'s single
  `bulk` action takes repeated `serviceId` fields plus an `op` (from the clicked
  submit button's own name/value) and runs every resolved service through
  `Promise.allSettled` (this repo's `noAwaitInLoops` lint rule forbids an await
  loop), returning `{succeeded, failed, op}` so the toast reports a partial
  result, or `fail(400)` with the first rejection's message if every one failed.
  Bulk delete is gated behind `ConfirmDialog`'s typed-phrase confirm
  (`delete N services`); single-row delete requires typing the service's own
  name.
- `import/+page.svelte`, paste a compose file, preview what it maps onto, then
  create (and optionally deploy) the stack : see Compose import below. Reached
  from the "Import compose" button next to "Deploy a Service" on the list.
- There is no `services/migrate` any more: migrating from Dokploy/Coolify is the
  admin-only `settings/migrate/` tab (source picker, then one nested route per
  source), see "Migrating from Dokploy or Coolify" in
  `services-and-templates.md`.
- `new/+page.svelte`, click-config create form, a 5-step wizard (Basic info /
  Networking / Environment / Volumes / Compute, one `<form>` throughout, steps
  hidden via a CSS class rather than `{#if}` so field state survives navigating
  between them); accepts `?stackId=` and/or `?templateId=` query params to
  pre-fill from a stack or template context. "Deploy from" toggles between a
  Docker image and a git repo (see Git-based builds below), same toggle repeated
  on the service's own Environments & Deployments → Source section for editing
  after creation. Two submit actions share one `createServiceFromForm()` helper
  (`new/+page.server.ts`) that validates + creates the row: `create` (secondary
  button, "Create service", persists config only, same as before) and
  `createAndDeploy` (primary button, "Create and Deploy", calls
  `DeploymentService.deployService()` before redirecting straight to the new
  service's Overview tab instead of the services/stack list). A min-height
  wrapper around the step content keeps the Next/Back button row's vertical
  position stable as steps of different heights swap in.
- `[serviceId]/+layout.server.ts`, existence guard (unknown id, 404) + syncs
  live Docker status on every visit. Tabs (see A service's tabs above for the
  grouping): **Overview** (deploy/start/stop/restart, live deploy progress
  panel, deployment history with expandable per-deployment logs, plus an
  embedded `LiveLogViewer`, see Logs below, shown once deployed so recent output
  is visible without switching tabs), **Environments & Deployments** (its
  **Source** section: Deploy-from image/git toggle, image+tag or git repo
  fields, private registry, `updateSourceSchema`, its own `updateSource` action,
  split off Settings so "what gets deployed" has its own place; plus the
  Environments list, **Environment Variables**, **Revisions** and, for a git
  service, **Previews** and **Channels**), **Observability** (Monitoring;
  **Events**, the live logs, streamed via a `+server.ts` GET returning a chunked
  `ReadableStream` and rendered through
  `src/lib/components/live-log-viewer.svelte`, the same component embedded in
  Overview, then failed deployments, a live "container currently down" banner
  and "Application errors", persisted app-level warn/error `Logger` output
  attributed to this service, see `app_log`/`AppLogDTO` in Data model below;
  **Errors**, error tracking; **Health**), **Storage** (mount/unmount
  StorageVolumes, including a "New volume" modal,
  `src/lib/components/new-volume-fields.svelte` shared with `/storage/new`, so a
  volume can be created and mounted without leaving the service), **Networking**
  (a **Domains** card: the default `<slug>.<baseDomain>` hostname with a
  "Routed" toggle, a list of extra domains and a radio picking the main one,
  `updateDomains` action, pure helpers in `src/lib/service-domains.ts`; an
  **Access** section holds the per-app login wall, its allowed sign-in methods
  and its user/email/group allowlists, `updateAppAuth`, see Per-app login wall
  below; a **Network** section holds container port, protocol (tcp/udp/both),
  network mode (bridge/host, see below), and DNS-resolvability,
  `updatePortsSchema`, its own `updatePorts` action, moved off Settings; an
  **SSL** section, its own `updateSsl` action, shown only for domains outside
  the instance's base domain and never behind Pangolin (which serves
  certificates itself), host ports are still never _published_/mapped by design
  even though host network mode now exists, see below; **every one of those
  settings is a Traefik label written when the container is created**, so saving
  one changes nothing about the container that's already running, which is why
  an already-deployed service shows an amber notice and a `?/redeploy` button at
  the top of this tab rather than leaving the user to work out why their domain
  404s), **Container** (its **Compute** section: cpu/memory limits,
  `updateComputeSchema`, its own `updateCompute` action, moved off Settings; its
  **Runtime** section), **Terminal** (interactive shell into the live container,
  see below), **Settings** (name/slug/restart-policy, move between stacks,
  save-as-template, auto-redeploy cron schedule, danger-zone delete,
  image/git/registry, port/network and cpu/memory fields all moved to their own
  tabs, see Environments & Deployments/Networking/Container above). When
  `currentStatus === "missing"`, Observability → Events shows a distinct banner
  with a "Resolve" button, `?/resolveOrphan`, calling
  `ServiceDTO.resolveOrphan()` to clear the stale `containerId`/`swarmServiceId`
  and put the row back to a clean, never-deployed shape so Deploy works again,
  see the `"missing"` `ContainerStatus` note under Docker integration below
- `[serviceId]/deployments/[deploymentId]/events/+server.ts`, the SSE stream the
  Overview tab listens on while a deploy is in flight (see Live progress below),
  and `.../progress/+server.ts`, the older `{log, status}` JSON endpoint, now
  the client's fallback when the stream can't be held open. The client
  pre-generates the deployment id itself (`randomId()` from
  `src/lib/random-id.ts`, set on the form via
  `formData.set("deploymentId", ...)` in `use:enhance`'s pre-submit callback) so
  it can start listening _before_ the deploy request even resolves, which is why
  the stream waits for the row instead of 404ing. **It must not call
  `crypto.randomUUID()` directly, and that's a real reported bug, not a style
  preference**: that API is secure-context-gated in browsers, so on a plain-HTTP
  instance at a bare IP (exactly what the installer's `--mode=full` produces)
  it's `undefined`, the pre-submit callback threw
  `TypeError: crypto.randomUUID is not a function` before the submission ever
  reached the server, and since `onStart` had already set `pendingAction`,
  Deploy spun forever with nothing queued and no toast (`toast.promise` is
  called after `onSubmit`). `randomId()` falls back to `crypto.getRandomValues`,
  which carries no such restriction. Server-side `crypto.randomUUID()` (every
  DTO's id) is fine, this only applies to code that runs in the browser.
  `navigator.clipboard` is gated the same way, which `profile/clients` already
  handles by catching and telling the user to copy manually. Both are
  status-driven (they end once the deployment reaches a terminal status), which
  is also what makes resuming the progress view after a mid-deploy page reload
  work, `onMount` checks the latest deployment's status and `svc.currentStatus`
  and reattaches if either is still in-flight.

`src/routes/(protected)/stacks/`, `templates/`, `storage/`, `authentication/`
mirror this pattern (list + `new/` create route + `[id]` detail where
applicable). `system-logs/` streams the logs of any container in the instance's
own compose stack, Traefik included (see Docker integration below).

`stacks/` also nests: `new/+page.svelte` accepts `?parentId=`, pre-filling the
slug as `stackScopedSlug(parent.slug, slugify(name))` and, once created,
redirecting into the parent's own page rather than `/stacks` (see Nested stacks
in `services-and-templates.md` for the schema/helpers). The ancestor chain no
longer renders as its own line above the stack's name (that markup was removed
from `+layout.svelte`); it's the page's breadcrumb instead,
`[stackId]/+layout.server.ts` builds `crumbRoot`
(`[{Stacks}, ...ancestorIds(stack.id, parents).reverse(), stack]`, each an
`{href, label}`) for `breadcrumbs.svelte` to render (see Navigation up in
`ui.md`), and `[serviceId]/+layout.server.ts` does the same one level deeper so
a service inside a nested stack reads `Stacks › <parent> › <stack> › <service>`.
`[stackId]/+layout.svelte` still has a **New Substack** button next to the
existing template/deploy ones; `[stackId]/settings/+page.svelte` has a "Nested
in" section (a `Select` of every stack that isn't this one or one of its own
descendants, `?/move` action calling `StackDTO.setParent`).

`[stackId]/+page.svelte`'s Services tab is a dependency graph over the whole
subtree (this stack plus every nested one, `descendantIds`), not a flat list:
`+page.server.ts` builds `dependencyMap`/`dependencyForest` (list view) and
`dependencyLayers` (card view) from `src/lib/service-graph.ts` once for the
page, over every member service plus anything they reference outside the tree,
using the shared `toGraphService` row mapper (also behind `/services`' own tree
view, see below) and a `links` map (`linkKeys` per dependency) that feeds the
right-click **Unlink from** submenu. List view (`ServiceTree`, one instance per
substack section via `flattenStackTree`) nests each service's dependencies
underneath it, marking one outside the tree "in `<stack>`"/"no stack" and one
already expanded elsewhere "shown above" rather than repeating its subtree. Card
view (`StackDiagram`) is the same graph as nested boxes per substack, arrows
drawn from consumer to dependency with `src/lib/diagram-edges.ts`'s `edgePaths`
(measures each rendered card, spreads same-side arrows so none overlap, redrawn
on `ResizeObserver`), everything outside the tree collected into one "Outside
this stack" box, hovering a card highlighting only its own edges. A card can
also be dragged (pointer events, not native drag-and-drop) to an arbitrary
offset kept in `localStorage` per stack (`homerun:stack-diagram:<stackId>`,
`stack-diagram.svelte`'s `offsets`/`saveOffsets`), so a manually untangled
layout survives a reload; **Reset layout** clears it and re-measures. Both views
fall back to `EntityList`'s flat search results the moment the search box has
anything in it, since a matched-and-filtered set has no tree structure worth
drawing, and the same fallback is one click away without searching: the
**Architecture** switch next to the view toggle (`localStorage`
`homerun:stack-architecture`, default on) turns the graph off in favour of a
plain list/cards, same as `EntityList`'s search fallback. `ServiceTree`'s own
row (`service-tree.svelte`) stacks vertically below `sm:` (icon+name, then
slug/labels/status wrapped underneath) rather than the single-line desktop row.
Right-clicking a service in either view also offers **Unlink from**
(`ServiceContextMenu`'s `onunlink`/`UnlinkDialog`, the same `unlink` action
Overview's Connections panel uses, see above), and right-clicking a stack row on
`/stacks` or a substack heading here offers **Move into…** (`StackMoveDialog`,
the same `?/move` action as the Settings tab's "Nested in" section). `/stacks`'
own list marks each row with its `substackCount` (`descendantIds(id).length`)
and shows only top-level stacks unless a search is on
(`StackDTO.listWithServiceCountsPaged`'s `topLevelOnly`).

`/services` (the global, paged list) reuses the same pieces two ways: its normal
grouped-by-stack view now orders groups as a stack tree (`flattenStackTree` over
every stack with a shown group, a substack's group indented under its parent's,
via `depth`), and a **Dependencies** button (`?view=tree`) swaps the page for
`ServiceTree` over every service unpaged — `+page.server.ts` only runs
`ServiceDTO.list()` and builds `dependencyMap` when that query param is set,
since a dependency tree needs the whole unpaged set to draw correctly, unlike
the page's own server-side search/filter/sort.
