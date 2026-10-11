# Services, templates, git builds

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Linking and grouping from the services list

A right-click on a service row offers **Link to…** and **group/ungroup**
(`services/+page.server.ts`'s `link` and `group` actions). Linking writes the
provider's connection variables into the consumer's env — the same
`buildLinkEnv` output the wizard's link picker produces, so a URL, a JDBC URL or
separate vars depending on the provider's image. Which side is which isn't just
"the one you right-clicked": `src/lib/service-link.ts`'s `linkRoles` makes a
database or cache (`isDatabaseImage`) the provider whenever the other side isn't
one too, whichever service you started from, so linking an app to a database
from the app's own menu writes the database's vars into the app the same as
doing it from the database's menu would. Linking also optionally puts both on
one stack network, since two services only reach each other by slug once they
share one, and moves them into whichever stack either is already in, creating
one named after the source (not necessarily the consumer) when neither has one.

**Unlinking** is the reverse, and lives in `src/lib/service-graph.ts` rather
than `service-link.ts`: `linkKeys(envVars, slug)` finds which of a consumer's
own env vars point at a given provider's slug (via `hostsIn`, see A service's
tabs in `routing.md` for the detection rule), and the `unlink` form action — on
a service's own Overview tab, or a stack page's right-click **Unlink from** —
deletes exactly those keys plus any of them marked in `secretEnvKeys`. It only
ever touches the consumer, and only takes effect on its next deploy.

**Explicit dependencies** (`service_dependency` table, `ServiceDependencyDTO`)
sit next to the env-inferred ones: every `link` action records a
consumer→provider row, and format `none` ("Dependency only") records only that,
writing no env. `ServiceDependencyDTO.add` is idempotent and refuses a self or
cyclic edge (`createsCycle` in `service-graph.ts`, checked against recorded rows
only); `link` turns that refusal into a 400 for dependency-only and just skips
the row (with a warning log) when env vars are written, since two apps calling
each other over URLs is legitimate. `unlink` drops the row and the env keys, 400
only when neither existed. Every graph (stack page deps/links, services tree, a
service's Connections) is `mergeDependencies(dependencyMap(...), recorded)`, so
a dependency-only link shows up with empty `keys`. Start order reads the
recorded rows only, never env inference (a hand-written URL isn't a promise the
other side must be up): `ServiceLifecycleService.startService` recursively
starts every deployed, not-running dependency first (a `visited` set makes it
cycle-safe, an undeployed one is skipped, a failing one fails the start);
`runBulk` runs start/restart in `dependencyLayers(...).reverse()` batches, stop
in `dependencyLayers` order, delete all at once; `enqueueStackDeploy` reorders
`linked` the same way before chaining jobs. Compose import records each draft's
`depends_on` (compose key → created id) after creating the services, skipping
targets that weren't imported. Rows cascade on either service's delete.

Links made before the table existed are backfilled at boot (`init()` in
`hooks.server.ts`, skipped in candidate mode) by
`ServiceDependencyDTO.backfillFromEnv`, whose edge picking is the pure
`backfillEdges`: every `dependencyMap` edge whose two ends share a stack or
whose value is a URL/`host:port` (`hostsIn` with no key, so a bare name under a
host-ish key only counts within a stack), turned consumer→provider by
`linkRoles`, for consumers with no recorded row yet; cycles are skipped and
logged. It runs once per instance:
`instance_settings.dependencies_backfilled_at`
(`InstanceSettingsDTO.dependenciesBackfilled`/`markDependenciesBackfilled`) is
stamped after the first run and later boots skip it, so clearing a service's
recorded dependencies later sticks. The cutoff passed to `backfillEdges` is the
moment of that first run, which covers every service that existed then, not only
those created before the table's migration was generated (the earlier design,
which missed services created between that and an instance's upgrade). The REST
API exposes the graph as `GET/PUT /api/v1/services/:id/dependencies`
(`ServiceDependencyDTO.describe`, sources via the pure `dependencyEdges`;
`replace` swaps the recorded set in a transaction, 400 on an unknown id or a
loop via `replacementCycle`), wrapped by the MCP
`list_dependencies`/`set_dependencies` tools and
`homerun services dependencies [set]`. The service detail shape doesn't carry
`dependsOn`: read the dependencies route.

## Nested stacks and stack-scoped slugs

`stack.parentId` (self-FK, `onDelete: "set null"`, see Data model in
`data-and-config.md`) nests a stack inside another, to any depth. It's a pure
grouping/display relationship: a substack keeps its own Docker network, and
nesting changes nothing about how services reach each other (still plain slug,
same as any two stacks). `src/lib/stack-tree.ts` holds the pure helpers:
`ancestorIds`/`wouldCycle` (used by `StackDTO.setParent` to refuse nesting a
stack inside itself or one of its own descendants), `descendantIds` (a stack's
own settings page excludes itself and its descendants from the "Nested in"
picker, `stacks/[stackId]/settings/+page.server.ts`), `stackPath`
(`Media / Vortex`, the picker's option labels and the breadcrumb above a
substack's title) and `flattenStackTree` (indented list order, parent before
children, siblings by name). `/stacks` lists only top-level stacks
(`StackDTO.listWithServiceCountsPaged`'s `topLevelOnly` option, dropped the
moment a search is on, so a nested stack is still findable) with each row's
`substackCount`; a stack's own page shows a **New Substack** button
(`/stacks/new?parentId=`).

A service created inside a stack — from the wizard or from a template, including
a template's linked companions — gets that stack's slug as a prefix:
`src/lib/slug.ts`'s `stackScopedSlug(stackSlug, slug)` is
`${stackSlug}-${slug}`, unless `slug` already is or already starts with
`${stackSlug}-` (so resubmitting a form, or a template link building on an
already-scoped primary slug, never doubles the prefix).
`src/lib/service-domains.ts`'s `defaultHostname` no longer prefixes on its own,
it just calls `stackScopedSlug` : the public subdomain is `<slug>.<baseDomain>`
where `slug` is already scoped, not `<stackSlug>-<slug>.<baseDomain>` layered on
top. `dns.service.ts`'s `serviceHostname` calls the same `defaultHostname`
rather than re-deriving the prefix, one source of truth for the hostname a
service resolves at.

## Where creating something lands you

Every create path ends on the thing it just made, not on a list: the wizard's
**Create service** and **Create and deploy** both redirect to `/services/<id>`,
and a template's **Quick Deploy** does the same from both the catalog and the
template's own detail page. The one exception is a create that produced
_companions_ (a template pulling in its linked services, see Template links
below): those land on `/stacks/<id>`, where all of them are visible together,
which is the only view that shows the whole thing that was just created. The
catalog's Quick Deploy used to return an `href` and offer a "View" button on its
toast instead; the redirect now happens server-side, the same way the detail
page always did.

## Shared deploy pipeline (`src/lib/services/deploy.service.ts`)

`DeploymentService.enqueueDeploy(input)` is the one entry point every deploy
trigger uses — the service Overview page's `deploy` action,
`POST /api/v1/services/[serviceId]/deploy`, the cron redeploy scheduler (below),
template/stack quick-deploys and compose import. It creates the `deployment`
row, marks the service `pending`, and queues a `deploy` job
(`{deploymentId, jobId}`, coalescing a concurrent enqueue for the same service
onto whichever is already queued, see `jobs-and-queue.md`). Nothing runs inline
anymore : **the pipeline itself now runs in the Go worker**, in two TS halves
around it (`prepareWorkerDeploy`/`finalizeWorkerDeploy`, the job's
prepare/finalize steps, see "The stage protocol" in `worker.md`) plus
`internal/jobs/deploy` doing the actual Docker/build work in between. Don't
reimplement any of this inline in a new call site; extend
`enqueueDeploy`/`prepareWorkerDeploy` instead.

**The legal combinations are a union, resolved once up front.** The first thing
the pipeline does (the `config` phase, before volumes, pulls, builds or any
Docker call) is `#loadDeployPlan`: it loads the instance's `orchestrationMode`,
the cache registry row and the build server target, then hands plain data to
`resolveDeployPlan()` in `src/lib/services/deploy/plan.ts`, a pure function
(covered by `tests/unit/app/deploy-plan.test.ts`) returning a `DeployPlan`:

- `image: ImagePlan`, one of `pull` (`svc.image`/`tag`/`pullPolicy`),
  `local-build` (optional cache registry as a layer cache), `docker-build` (a
  remote Docker build server) or `agent-build` (an agent build server), both
  with `registry: CacheRegistryCredentials | null` (null streams the image back,
  see Build servers in `docker.md`), or `revision` (a rollback, see Revisions
  and rollback below). Every git variant carries the `GitSource`
  (url/ref/context/Dockerfile) with `gitUrl` already non-null.
- `workload: WorkloadPlan`, either `container` (carries `networkMode`) or
  `swarm` (carries `replicas`).

Illegal combinations throw a `DeployPlanError` there, so they fail the
deployment with a clear message before anything happens: a git service without a
URL, an image service without an image, a build server that didn't resolve, and
host networking under swarm (swarm services only join the overlay, this used to
be silently dropped). Leftover `buildServerRemoteHostId`/`buildCacheRegistryId`
on an image-source service are ignored and never loaded. Building the worker
spec (`deploy/worker-spec.ts`) is itself a `switch` over each variant's `kind`
(`imageSpec` over `pull`/`revision`/`local-build`/`docker-build`/`agent-build`,
`workloadSpec` over `container`/`swarm`), each ending
`default: return unreachable(plan)` (`never`), so adding a variant is a type
error until every step handles it — the same exhaustive-switch shape
`#resolveImage`/`#buildGitImage`/`#startWorkload` used to have back when
`deploy.service.ts` did this work itself, before it moved to the Go worker (see
below). Add a new axis or combination to the union, not an `if` in a step.

Inside the Go worker, resolving the image (including a git build) happens before
the workload starts (`internal/jobs/deploy/deploy.go`'s `deploy()`:
`resolveImage` then `startContainer`/`startSwarm`), so the workload step never
needs to know which path produced the image; a cross-host build
(`docker-build`/`agent-build`) pushes to `<registry>/homerun-build-<slug>:<tag>`
and pulls that published ref back onto this host first (`build.go`'s
`transfer`). A build server builds for this host, not for itself: `buildImage`
reads this daemon's os/arch (`/version`) and sends it as `BuildInput.Platform`,
`BuilderEnv` turns it into `BUILD_PLATFORM` plus `BINFMT_IMAGE`, and
`builder.sh` only acts when the arch differs from its own `uname -m`: it runs
the pinned `tonistiigi/binfmt --install <arch>` privileged container
(kernel-wide and idempotent, so the `homerun-cache` BuildKit container gets it
too) and adds `--platform` to whichever tool builds (`--set <target>.platform`
for bake). A native build gets no flag at all, so it's byte-identical to before.
Verified live on an arm64 daemon: `linux/amd64` produced an amd64 image whose
`uname -m` says `x86_64`. **Real finding behind it**: with no platform passed an
arm64 agent handed an amd64 host an image whose tasks just exit 255, which swarm
reports as an unhealthy rollout with no hint of the cause. An agent older than
the `platform` field ignores it, so `checkArchitecture` still compares the
arrived image's architecture with the daemon's and fails the deploy naming both.
The resolved `image`/`tag` only reaches `svc.image`/`svc.tag` in the database
once the whole job succeeds and reports back : `deploy.service.ts`'s
`finalizeWorkerDeploy` writes `outcome.serviceImage` (the `ImageRef` in the
worker's `Result`) as part of recording success, not mid-deploy the way the old
in-process pipeline did.

## Deploys run in the Go worker (`deploy/worker-spec.ts`, `internal/jobs/deploy`)

`deploy.service.ts`'s `prepareWorkerDeploy` is the `deploy` job's whole prepare
step (see "The stage protocol" in `worker.md`): resolves the config (a
rollback's revision and restored config, the config snapshot, the `DeployPlan`,
the volumes), waits on required status checks for a git build (below), and
returns `deployWorkerSpec`'s spec — everything `internal/jobs/deploy`'s `Run`
needs and nothing it has to look up itself (network names, labels, env, registry
auth, remote host connections, retention lists, all resolved app-side). The Go
side pulls or builds the image (gating on the image scan, below), then starts
the container or swarm service, health-gated the same way the old TS pipeline
was (see "Creating and starting the container" in `docker.md`).
`finalizeWorkerDeploy` is the finalize step: records the built commit, the
service's new image, the scan history, then either success (service and
deployment running, superseded health cleared, DNS synced, health watch armed,
notifications) or failure (the service kept running when a scan block or a
failed health-gated rollout left its previous workload in place, via
`RolloutFailedError`/`ImageScanBlockedError`, mapped from the worker's
`Result.Failure` by `workerFailure`).

## Required status checks (`src/lib/status-checks.ts`, `StatusCheckService`, `deploy/status-check-step.ts`)

`service.requireStatusChecks` + `requiredStatusChecks` gate a git build. In
`deploy/worker-spec.ts`'s `buildSpec`, before the spec hands the git build over
to the Go worker, `enforceStatusChecks` resolves the branch to a SHA through the
provider API, logs it, writes `gitCommit`/`gitRef` on the deployment and runs
`waitForChecks`, all still on the TS/prepare side (see "Deploys run in the Go
worker" above) since it needs the git-provider tables. Everything
provider-shaped is pure in `src/lib/status-checks.ts`, covered by
`tests/unit/app/status-checks.test.ts` with a fake fetch: `repoPathFromGitUrl`
(https, scp-style, nested GitLab groups, a self-hosted base path),
`providerApiBase` (also what `git-provider.service.ts` `endpoints()` uses now),
the per-provider paths (`commitsPath`, `checkSources`) and mappers into
`CheckResult {name, state: pending|success|failure}`, and `StatusCheckClient`
(fetch injectable, like `MirrorRegistryClient`).

- GitHub: `commits?sha=<ref>&per_page=1` for the SHA, then check runs
  (`filter=latest`; not completed is pending, `success`/`neutral`/`skipped`
  pass, anything else fails) merged with the combined commit status.
- GitLab: project path URL-encoded, commit job statuses (`all=false`, latest per
  name; an `allow_failure` failure and an allowed manual job pass, other manual
  jobs stay pending) plus the latest pipeline for the SHA as a check named
  `pipeline`.
- Gitea/Forgejo: `commits?sha=<ref>&limit=1`, then the combined status
  (`warning` passes), already one row per context.
- Bitbucket: `commits/<ref>?pagelen=1`, statuses keyed by `key` (not `name`,
  which Pipelines rewrites per run), `STOPPED` fails.

`mergeChecks` keeps the most pessimistic state for a name reported twice.
`evaluateChecks(required, results, graceExpired)` fails on any failed required
check, waits on pending ones, and treats a required check with no result as
pending until everything else on the commit has finished **and**
`STATUS_CHECK_GRACE_MS` (3 min) passed, then as failed. `waitForChecks` polls
every 20s for up to 30 min (clock and sleep injectable), logs only when the
summary changes, retries transient API errors, rethrows permanent ones
(`StatusCheckApiError.permanent`: 401/403/404/422), and stops when `isCancelled`
sees the deployment row `failed`/`stopped` or the service gone.

Any failure throws `StatusChecksFailedError`, which `#recordFailure` recognises:
the service status is re-synced from Docker instead of being set to `failed`
(the previous revision is still running, untouched), and
`notifyStatusChecksFailed` sends `build_checks_failed` + `build.checks_failed`
instead of the generic build failure (nothing on cancellation). Credentials
(`StatusCheckService.targetFor`): the provider configured for the URL's host
plus the service owner's connection, else a token embedded in the clone URL,
else unauthenticated for a well-known host (`inferProviderKind`). The checked
SHA travels as `BuildInput.Commit` into `internal/agent.Builder.checkout` — the
one clone-and-pin implementation every build kind now goes through (see
Git-based builds below): when the shallow clone's HEAD differs (a push landed
while waiting), it runs `git fetch --depth 1 origin <sha>` and
`checkout --detach <sha>` in the workspace, so the build is the checked commit
or fails, returning the built commit for the deployment row. An agent older than
that ignores the unrecognized field (Go's `encoding/json` default) and builds
the branch head.

The Environments & Deployments → Source picker (`status-check-picker.svelte`)
loads names through `listStatusCheckNames`
(`src/lib/remote/status-checks.remote.ts`, distinct names over the last 5
commits of the branch) as a one-shot `$state` promise and posts the selection as
repeated `requiredStatusChecks` hidden inputs, read with `formData.getAll` since
the route's zod parse goes through `Object.fromEntries`. **Verified live**,
read-only: github.com/orochibraru/homerun unauthenticated (real check-run names,
a HEAD commit with no checks yet) and a Forgejo instance answering 403 without a
token (a permanent error). **Not verified**: GitLab and Bitbucket against real
instances, and a full deploy blocked by a real failing check.

## Revisions and rollback (`src/lib/revisions.ts`, `RevisionService`, `RevisionHealthService`, `deploy/revision-step.ts`)

A revision is a `deployment` row (see `data-and-config.md`), recorded by
`#recordSuccess`: `imageRef` from the resolved `image:tag` with any `@digest`
split off into `imageDigest`, `imageId` from inspecting the run ref, and
`health: "watching"`. Pure logic in `src/lib/revisions.ts`, covered by
`tests/unit/app/revisions.test.ts`: `previousRevision` (newest older revision
whose image key, `imageId` then digest then ref, differs from the current one,
skipping `unhealthy`/`rolled_back`), `retainedRevisions` (newest `limit`
distinct images per service), `revisionImageRefs` (what the Docker keep list
resolves) and `healthVerdict`.

**Rollback** is `enqueueDeploy({rollbackOfDeploymentId})`: the row carries the
target, the job is deduped on `rollback:<id>` (so it never coalesces into a
queued normal deploy), and `deployService` turns the row into a `RevisionSource`
for `resolveDeployPlan`, whose `revision` input short-circuits to the `revision`
image variant (no git URL check, no cache registry or build server load).
`resolveRevisionImage` skips build, upstream pull and scan: with a digest it
runs `image:tag@digest` (verified: `docker create` and a dockerode pull both
accept that form), pulling by digest only if it's gone locally, and swarm just
gets the pinned ref; without one it needs the local `image:tag` to still be the
recorded `imageId`, and otherwise fails saying to redeploy. It writes the
revision's `image`/`tag` back onto the service.

**Config snapshot.** Every deploy writes `deployment.configSnapshot`
(`RevisionConfig` in `src/lib/revision-config.ts`: env vars, cpu/memory,
replicas, containerPort/portProtocol, networkMode, dnsResolvable) right after
the config phase, before the plan is built. A rollback enqueued with
`restoreConfig` (`deployment.restoreConfig`, only ever true on a rollback row)
runs `restoreRevisionConfig` (`deploy/revision-step.ts`) **before**
`#loadDeployPlan`, because the workload plan reads `networkMode`/`replicas`,
writing the target's snapshot onto the service and logging which fields changed;
a target with no snapshot (deployed before this existed) logs and rolls back the
image only. Volumes and `domains` (unique across services, and tied to DNS/SSL
sync) are never part of it, and auto-rollback never sets it. The trade-off the
old design avoided: env vars are copied into every deployment row.
`service.envVars` is already plaintext jsonb, so that's no new exposure at rest,
but the revisions page load strips the snapshot to `hasConfigSnapshot` rather
than shipping every revision's env to the browser. Opt-in from the Revisions
confirm dialog, `?restoreConfig=true` on the API, `--restore-config` on the CLI.

**Health watch.** `DeploymentService.watchHealth` hands every successful deploy
to `RevisionHealthService.watch`, an in-process fire-and-forget loop (not a
queue job: a 90s+ watch would hold one of the worker's 3 slots), deduplicated on
`globalThis` so HMR doesn't double it; `hooks.server.ts` calls
`resumeHealthWatches()` at boot for rows still `watching`. Every 5s it stops,
clearing `health`, if the service is gone or stopped, has a newer deployment
row, or runs a different container/swarm service; otherwise it samples
(`containerHealthSample`/`swarmHealthSample`, the `docker/revisions.ts` mixin)
and asks `healthVerdict`. Unhealthy at once on an exit, 2+ restarts since the
baseline, a missing container, Docker health `unhealthy`, or 2 failed swarm
tasks created since the deploy; healthy once `HEALTH_WINDOW.windowMs` (90s)
passed, extended while health is `starting` or replicas are missing up to
`maxWaitMs` (5 min), after which it's unhealthy. A healthy verdict then goes
through `withReadiness`: the uptime probe's `probeInternal` hits the service's
container port, and when that check is HTTP (no Docker healthcheck, not a
database image) a 5xx or refused connection keeps it pending, unhealthy at
`maxWaitMs`. Real finding: AIOMetadata sat on "waiting for Redis" for an hour,
answering 503 everywhere, and was marked healthy because its container never
exited. The service's `healthcheckCommand` runs every 30s with a 30s start
period and 3 retries, so a failing one turns unhealthy after about two minutes,
inside that bound. On unhealthy, with `autoRollback` on, the revision not itself
a rollback (`isRollback`: a preview promote also sets `rollbackOfDeploymentId`
but isn't one) and a `previousRevision` found: `rolled_back`, a rollback deploy
and `deploy.rolled_back`. Otherwise `unhealthy` and `deploy.unhealthy`, with the
reason nothing was rolled back. The rollback enqueuer is passed in by
`DeploymentService` rather than imported, since `RevisionService` imports
`deploy.service.ts`.

**Superseded health.** `health` only describes the running revision:
`#recordSuccess` calls `DeploymentDTO.clearSupersededHealth`, nulling
`healthy`/`watching` (`CLEARED_ON_SUPERSEDE`) on every other row of the service,
while `unhealthy`/`rolled_back` stay as history (and keep `previousRevision`
skipping them). Every write from the watch goes through `settleHealth`, an
`UPDATE ... WHERE health = 'watching'`, so a watch whose row a newer deploy
already cleared can't write `healthy`, and its unhealthy path returns before
logging, rolling back or notifying. `revisionEntries` also passes a non-current
entry's health through `supersededHealth`, for rows written before this.

**One entry per revision.** A rollback targets the revision's original row,
never a redeploy (`RevisionService.resolveTarget` and the auto-rollback's
`#rollbackTarget` both follow `rollbackOfDeploymentId` up with `revisionRoot`),
and `revisionEntries` folds each rollback row into that root: entries are
ordered by the root's `createdAt` so deploying a revision never moves it, only
`current`/`previous` move. An entry's status, log, error and timings are its
latest attempt's, `lastDeployedAt` and health its latest successful run's, and
`retained` follows the image key. The deployment rows themselves are unchanged
(dashboards, Errors, the SSE progress panel still read them). Both
`RevisionService.history` (the tab: the last 30 deployments, failed attempts
included) and `list` (the API/CLI: the last 50 revisions) load any root that
fell outside that window.

UI: Environments & Deployments → Revisions (`RevisionService.annotate` builds
`RevisionView`s with `current`/`previous`/`retained`), each row linking to the
revision's own page (`revisions/[revisionId]`: its facts, health reason, latest
log, the deployments folded into it, and **Deploy this revision** through
`ConfirmDialog`, a hidden form, the `deployRevision` action with `enhanceToast`,
then Overview for the progress panel), and **Auto-rollback** on the Settings
tab. API: `GET /services/{id}/revisions` and
`POST /services/{id}/revisions/{revisionId}/deploy` (`previous` accepted, waits
like `deploy`); CLI `services revisions` and `services rollback`.
`tests/integration/revisions.test.ts` covers two image deploys plus a rollback
by digest (the list order unchanged, the superseded revision's health cleared),
the 404/400 cases, auto-rollback of a restart-looping revision, and marking
without auto-rollback.

## Image scanning in the pipeline (`image_scan`, `ImageScanService`, `internal/jobs/deploy/scan.go`, `internal/jobs/imagescan`)

Scanning happens inside the deploy job's `image` phase, before the workload
starts, on every deploy trigger (Overview, API/CLI, cron, stack/template
deploys, the queue) — the gate itself now runs in the Go worker;
`ImageScanService.policyFor(svc)` (still TS, read while building the spec)
combines `instance_settings.imageScanEnabled` (null = on) with
`service.imageScanEnabled` (default true) and carries `block: ScanBlockPolicy`
(`InstanceSettingsDTO.imageScanBlockPolicy`: `imageScanBlockSeverity`, null =
off, `CRITICAL`/`HIGH`/`MEDIUM`/`LOW`, plus `imageScanBlockFixableOnly`). When
off, `deploy/worker-spec.ts`'s `scanSpec` returns null and
`internal/jobs/deploy/scan.go`'s `scanTargets` records a `skipped` row itself.

- **Pull plans**: `deploy/worker-spec.ts`'s `imageSpec` builds a `mirror` spec
  (`mirrorSpec`, only when scanning is enabled) alongside the pull. A pull
  policy that skips the pull scans the local image (`--image-src docker`, no
  mirror). Otherwise the Go worker's `deployThroughMirror`: copies into the
  mirror (skopeo, the commands built by `mirrorSpec`) → scans the mirror copy
  (`--image-src remote --insecure`) → **pulls only after the scan**, so a
  blocked image never lands in the host's image store → `fetchFromMirror` pulls
  the loopback ref and re-tags it as the upstream `image:tag`, so the container,
  `pullPolicy: missing` and every other reader keep seeing the normal name.
  Swarm skips the host pull and returns `tag@digest` instead (`deploy.go`'s
  `deployThroughMirror`, once `spec.Workload.Kind == "swarm"`), since workers
  can't reach a loopback registry; the swarm pre-pull and `CreateSwarmService`
  both accept that ref.
- **Fallbacks, all logged into the deployment log**: the mirror copy fails → the
  worker falls back to the normal pull and a local scan. Scan succeeds but the
  loopback pull fails → `loadFromMirror`, then a plain upstream pull if that
  fails too, no second scan.
- **Git plans** scan after the build, still inside the same worker job, before
  the app ever learns the new `svc.image`/`svc.tag` (see "Deploys run in the Go
  worker" above): `buildScanTargets` (`deploy/scan-targets.ts`, still TS, run
  while building the spec) picks the local tag for `local-build`, or the pushed
  cache-registry ref with its credentials then the local pull for
  `docker-build`/`agent-build`.
- `internal/jobs/deploy/scan.go`'s `scan(ctx, targets, digest)` tries targets in
  order — the direct Go port of `ImageScanService.scan`, which no longer exists
  in the app — and reports back a `ScanRecord` per attempt (`ok` with the
  summary, `failed` with every target's error, or `skipped`) that
  `deploy.service.ts`'s `#recordWorkerScans` turns into one `image_scan` row
  each (`ok` with counts + top 200 findings), appends the summary and the first
  five CRITICAL/HIGH findings to the log, and notifies on CRITICAL
  (`image_scan_critical` bell row + the `image.vulnerable` channel event) — all
  still on the TS side, from the worker's reported `Scans`. The block verdict
  itself (`BlockReason` in `scan.go`, mirroring `evaluateScanPolicy()` in
  `src/lib/image-scan.ts`, still pure TS and still what the Security tab's
  "would the last scan pass" banner uses) runs in Go: logs the reason (policy,
  blocking counts per severity, full counts) and returns a `scan-blocked`
  failure, which `deploy.service.ts`'s `workerFailure` turns into
  `ImageScanBlockedError` — `#recordFailure` turns that into a normal failed
  deploy (deploy_failure bell + `notifyDeploy`) **without** marking the service
  failed when a workload already exists, same as a status-check failure: it
  `syncServiceStatus`es instead, since the old container is still up.
  `fixableOnly` counts `image_scan.fixable_counts` (findings with a
  `FixedVersion`); rows from before that column (null) fall back to `counts`.
  Unknown severity never blocks. **A scanner failure doesn't block by default**,
  even with a block policy set: `instance_settings.image_scan_required`
  (`imageScanRequired`, Settings → Docker, `ScanPolicy.required`) makes
  `scan.go`'s every-target-failed path throw the same `scan-blocked` failure
  after recording the failed row. The Scan now job never passes it (below).
  Rollbacks (`revision-step.ts`) skip the scan and the policy entirely,
  deliberately, so auto-rollback can always recover. The git
  `docker-build`/`agent-build` paths push to the cache registry before the scan;
  the gate is before the workload starts, not before the push.
- The Security tab's **Scan now** is its own `image_scan` job (dedupe/lock
  `image_scan:<serviceId>`, `worker-jobs/image_scan.ts`'s prepare/finalize
  around `internal/jobs/imagescan`'s `Run`/`Scan`): Trivy with
  `--image-src docker,remote` against `svc.image:svc.tag`
  (`ImageScanService.deployedScanTarget`) and the service's registry
  credentials, never blocking.

Verified live on OrbStack against the dev database (before this moved into the
Go worker, and not re-verified live since): a real deploy of `nginx:1.27-alpine`
through the mirror (copy, scan with 2 critical/35 high, loopback pull, re-tag,
container up), a `CRITICAL` block on `alpine:3.18.0` failing before the pull, a
per-service opt-out, and a `missing` pull policy scanning the local image. **Not
verified live**: swarm pinning, git-build scans, cross-host registry scans,
rootless Docker's fallback, and the Scan now job through the worker.

## Compose import (`src/lib/compose-import.ts`, `src/lib/services/compose-import.service.ts`, `(protected)/services/import/`)

Paste a `docker-compose.yaml`, get Homerun rows. Two halves, deliberately split:
`src/lib/compose-import.ts` is a **pure parser** (the `yaml` package, no DB, no
Docker) turning compose text into a `ComposeImportPlan`
(`services: ComposeServiceDraft[]`, plus file-level `warnings`/`networkNames`/
`volumeNames`), covered directly by `tests/unit/app/compose-import.test.ts`;
`compose-import.service.ts` is the row-creating half (`ComposeImportService`, a
plain instance singleton) that turns a plan into `StackDTO`/`ServiceDTO`/
`StorageVolumeDTO`/`ServiceVolumeDTO` rows. The route
(`services/import/+page.server.ts`) has a `preview` action (parse, return the
plan) and an `import` action that **re-parses the pasted text server-side**
rather than trusting a plan round-tripped through the client.

What maps: `image` (split via `src/lib/image-ref.ts`'s `splitImageRef`, which
handles a registry port and strips a digest; also the one place
`deploy/revision-step.ts` and the mirror registry's keep-set logic split an
image ref, replacing three near-duplicate implementations), `environment` in
both the map and `KEY=VALUE` list forms, `ports`/`expose` (the _container_ side;
`parsePortEntry` handles `"8080:80/udp"`, `"127.0.0.1:8080:80"`, a bare number,
and the long `{target, protocol}` form), `restart` (`on-failure:3` →
`on-failure`), `volumes` (short and long syntax), `depends_on`,
`network_mode: host`, `container_name`, `deploy.resources.limits.cpus`/`memory`
(and the legacy `cpus`/`mem_limit`), and the runtime options (`command`,
`entrypoint` via `src/lib/shell-words.ts`'s `argvFrom`, `labels` minus
`traefik.*`/ `homerun.*`, `cap_add`, `devices` short and long form,
`privileged`, `user` when it passes `isRunAsUser`, otherwise a warning).
Everything else is a **warning on the preview, not a silent drop**: `build:`,
`healthcheck`, `cap_drop`, secrets/configs, top-level extra networks, relative
bind mounts (Homerun needs an absolute host path), anonymous volumes, and the
host side of every port mapping.

`env_file` goes through `resolveEnvFiles`:
`parseComposeFile(text, { envFiles })` takes a path → content map, a supplied
file's variables are merged _under_ `environment`, an unsupplied absolute path
lands in the draft's `envFiles` (the service column, read from the host at
deploy time), and an unsupplied relative one lands in `missingEnvFiles`. The
import page renders a textarea per `plan.missingEnvFiles` path and the `import`
action re-parses with those contents (`envFilePath`/`envFileContent` form
fields). Migrate passes Dokploy's `env` blob as `.env`, which is what Dokploy
writes next to the compose file.

Drafts also carry `registry` (plaintext credentials, encrypted by
`ComposeImportService` on insert) and `files` (content to bind-mount): the
service writes every file to `/var/lib/homerun/files/<slug>/<n>-<name>` as one
in-memory ustar (`src/lib/tar.ts`) through `DockerService.extractIntoVolume`
(`putArchive` on a stopped `alpine` helper with that host directory bound, no
size limit) and attaches each as a read-only bind storage volume. Only Migrate
produces either.

**Host access is admin-only** (`src/lib/host-access.ts`): `privileged`,
`devices`, `capAdd` and `envFiles` are host-root-equivalent.
`hostAccessRequested` gates a create (REST `POST /services`, compose import,
`ComposeImportService.importPlan` via its `allowHostAccess` input, which Migrate
passes `can(locals.permissions, "system", "write")` to) and `hostAccessChanged`
gates an update (Container → Runtime, Env files action, REST `PATCH`): a caller
without write access to System may save a form that keeps the current values,
which is why the Runtime section renders them as hidden inputs for non-admins.

Two mapping decisions worth not re-litigating: **`dnsResolvable` is true only
when the compose service published a host port** (`ports:`), false when it only
`expose`d one, which is the closest honest translation of "this one was meant to
be reachable from outside"; and **one compose file maps onto one Homerun
stack**, since a stack already _is_ a Docker network here, so a file's own
multiple `networks:` can't be reproduced and says so in a warning.

`orderByDependencies` topologically sorts the drafts (falling back to file order
on a cycle rather than throwing), which is what makes "Import and deploy" queue
the stack in `depends_on` order : the last service is passed to
`DeploymentService.enqueueStackDeploy` as the primary and the rest as its
dependency chain, reusing the template-links machinery rather than a second
ordering implementation. Storage volumes are de-duplicated against the
instance's existing ones by `(kind, source)`, so importing two files that share
a named volume mounts the same row twice instead of creating a duplicate.

## Smart service links on create (`src/lib/service-link.ts`, `service-link-picker.svelte`)

The Environment step of `services/new` has a "Link a service" picker next to
"Paste .env": pick any service the user already owns (**regardless of stack**,
which is the whole point : every bridge-mode service is on the shared network
and reachable at `<slug>:<port>` anyway, so linking is purely about generating
the env vars, there's no networking to set up) and it writes connection env rows
into the existing key/value editor.

`src/lib/service-link.ts` is a pure, tested module
(`tests/unit/app/service-link.test.ts`), no DB or Docker:
`detectLinkEngine(image)` matches the image ref against a small table (postgres
incl. timescale/postgis, mysql/percona, mariadb, mongo, redis/valkey/dragonfly,
rabbitmq, else `generic`), `credentialsFor` reads that engine's own conventional
env vars off the linked service's stored `envVars`
(`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`, `MYSQL_*`/`MARIADB_*`
including the root-password fallback, `MONGO_INITDB_*`, `REDIS_PASSWORD`,
`RABBITMQ_DEFAULT_USER`/`_PASS`), and
`buildLinkEnv({format, prefix, target, urlKey})` produces the rows. Three
formats: `"url"` (a URI, `postgres://user:pass@slug:5432/db`), `"jdbc"`
(relational engines only, credentials as query params, `supportsJdbc` on the
engine gates the option), and `"vars"`
(`<PREFIX>_HOST`/`_PORT`/`_USER`/`_PASSWORD`/`_DB`, only emitting the ones that
exist). Every key name is a **default, not a rule**: the picker exposes the URL
variable name and the variable prefix as editable inputs
(`defaultUrlKey`/`defaultVarPrefix`, e.g. `POSTGRES_URL` / `POSTGRES`, or
`<SLUG>_URL` / `<SLUG>` for a generic service), which is what the TODO item
asked for. Values are URL-encoded, so a password with a space or an `@` survives
the round trip.

The picker merges into `envRows` through the same `mergeEnvRows` helper
`EnvPasteButton` uses, so an existing key is overwritten in place rather than
duplicated. It's a preview-then-add dialog, not an async mutation, which is why
it's one of the documented `toast.success` exceptions rather than a promise
toast.

## Default data volume on create (`src/lib/service-link.ts`'s `dataPathFor`, `src/lib/services/default-volume.ts`)

A database or cache created with no volume of its own now gets one anyway:
`dataPathFor(image, tag)` (next to `detectLinkEngine`/`isDatabaseImage` in
`service-link.ts`) maps an engine to where it keeps its data —
`/var/lib/postgresql` on Postgres 18+ tags, `/var/lib/postgresql/data` before
(the tag's own major, `17-alpine`/`latest-pg16`, no version parsed means
newest), `/var/lib/mysql` for MySQL/MariaDB, `/data/db` for Mongo, `/data` for
every Redis-compatible, `/var/lib/rabbitmq`, and `null` for memcached (nothing
worth keeping) or any non-datastore image. `default-volume.ts`'s
`attachDefaultDataVolume(svc, userId)` calls that, bails if it's `null` or
`ServiceVolumeDTO.listForService` already returns a mount, and otherwise creates
a `StorageVolumeDTO` named `<slug>-data` (`kind: "volume"`,
`source: <slug>-data`) and `ServiceVolumeDTO.attach`es it read-write at that
path. Called from `POST /api/v1/services` and both of `template-links.ts`'s
creators (`createServiceFromTemplate` and `createLinkedServices`, so a linked
companion like WordPress's MySQL gets one too). The deploy wizard doesn't call
it: its Volumes step (`services/new/volumes-step.svelte`) pre-fills a "New
volume" row at `dataPathFor(image, tag)` instead, so the operator sees the mount
before creating and can remove it; the row follows image/tag edits until the
operator changes its path. An existing service is never touched, mounting a
volume on it later still starts from empty, same as any other first mount.

## Live progress: SSE, streams, and why not WebSockets

**This stack has no WebSocket route API.** SvelteKit 3.0.0 (stable, what this
repo runs) has no `socket`/upgrade export for `+server.ts` either, so the gap is
SvelteKit's, not the adapter's. So the transport ladder here is, in order of
preference:

- **A `ReadableStream` response** for one-way server→client byte streams that
  aren't event-shaped : container logs (`services/[serviceId]/logs/+server.ts`)
  and the terminal's output channel. Already push-based, **not polling**,
  despite what TODO.md assumed.
- **Server-sent events** for one-way server→client _event_ streams : deploy
  progress (below). `text/event-stream` is the one content type
  `@sveltejs/adapter-bun` auto-exempts from Bun's `idleTimeout` (now `0`
  server-wide anyway, see `api-and-cli.md`).
- **Chunked HTTP both ways** where a client→server channel is genuinely needed :
  only the web terminal, which already does this (`terminal/[sessionId]/input`),
  and whose actual shell now lives in the Go worker's own hijacked exec anyway
  (see Web terminal in `docker.md`).
- **A remote `query`/`command`** (see Remote functions below) for any
  dashboard-only request/response call that isn't a stream : a panel that loads
  behind a skeleton, a poll, a small mutation the bell or a picker fires. This
  is what replaced the hand-written `fetch` + internal `+server.ts` pairs those
  surfaces used to need.
- **Plain REST/form actions** for everything else. The REST API stays the CLI's
  contract and the OpenAPI document's source of truth, and remote functions
  deliberately don't touch it : they're an internal dashboard transport, not a
  second public API. A form that mutates real state still goes through a form
  action with `enhanceToast`, not a command.

**Deploy progress is SSE** (`src/lib/server/deploy-progress-stream.ts`, served
by `services/[serviceId]/deployments/[deploymentId]/events/+server.ts`),
replacing the Overview tab's 1s `fetch` poll. The server-side loop still reads
the `deployment` row on an interval, but only _pushes_ when the serialized
snapshot actually changes, so a client sees a new line the moment it lands
instead of up to a second later, over one connection instead of one request per
second. Two details are load-bearing: the stream **waits for the deployment row
to appear** (up to 60s) instead of 404ing, because the Overview tab starts
listening before its own deploy POST has been handled and an `EventSource`
treats an HTTP error as fatal and never reconnects; and the client's `onerror`
**falls back to the old polling loop** (`pollProgress`, still there, still the
resilient path) rather than leaving the panel stuck, for a buffering proxy or a
dropped connection. The JSON `progress/+server.ts` endpoint stays for exactly
that fallback.

**Deploy phases** (`src/lib/deploy-phases.ts`) give that panel structure instead
of a raw log tail: `deployService` appends a marker line (`phaseLine(id)`,
rendered `▸ Fetching image`) as it enters each of
`config`/`volumes`/`image`/`container`/ `network`/`ready`, and
`deployPhaseStates(log, status)` derives per-phase
`done`/`active`/`failed`/`pending` from the last marker in the log plus the
deployment's status. The markers are ordinary log lines, so the deployment
history's raw-log panel keeps working untouched and nothing else in the pipeline
had to learn about phases. There is deliberately **no "checking container
health" phase**: the rollout's readiness wait happens inside the `container`
phase and logs its own `Readiness: ...` line (see "Readiness gate" in
`docker.md`), and a phase that passes instantly for every service without a gate
would be a lie. Longer-term health is watched _after_ the deploy finishes (see
Revisions and rollback above) and shows on Environments & Deployments →
Revisions.

## Remote functions (`src/lib/remote/*.remote.ts`, `src/lib/server/remote-auth.ts`)

SvelteKit's remote functions are enabled
(`kit.experimental.remoteFunctions: true`, set inline in `vite.config.ts`, which
is where this repo's whole Kit config lives, there is no `svelte.config.js`).
They're the transport for dashboard data that a page doesn't need in order to
render : a panel that can come in behind a skeleton, a poll, a picker's
on-demand lookup, and the small mutations those surfaces fire. Every one lives
in `src/lib/remote/`, and Svelte's `compilerOptions.experimental.async` is
deliberately **not** enabled, nothing here needs `await` in a template.

**Origin check.** SvelteKit refuses every non-GET remote call whose `Origin`
isn't `url.origin`, before any hook runs, and the adapter pins `url.origin` to
`ORIGIN`. Real finding: an installer-set IP `ORIGIN` plus a dashboard domain
added later made every command (the sidebar's Update button included) a bare 403
while the CLI, on the REST API, worked. adapter-bun has no runtime `ORIGIN` of
its own (kit 3 made it build-time `paths.origin`), so the repo patches it
(`patches/@sveltejs%2Fadapter-bun@1.0.0.patch`, bun `patchedDependencies`) to
read `ORIGIN` at runtime and to keep a remote call's own origin when its
`Origin` header names the request's host, the same same-host rule
`src/lib/server/csrf.ts` applies to forms (svelte-smol's old exemption).

**What is and isn't allowed to move here.** Anything a page's own correctness
depends on stays in `load` : the signed-in user, their role/permissions, their
appearance preferences, instance settings, and every entity list a route
renders. What moved is only data whose absence for a few hundred milliseconds is
a skeleton rather than a broken page. Concretely:

- `system-stats.remote.ts`, `getSystemStats` : the dashboard's Host Resources
  panel, which used to be fetched in the dashboard's `load` (blocking the whole
  page on a `df` + `nvidia-smi` shell-out) _and_ re-fetched every 5s from
  `/api/v1/system-stats`. `src/lib/components/host-resources.svelte` owns the
  query and the poll now. The REST route stays : it's in the OpenAPI document
  and is a public API surface, unrelated to the dashboard's own rendering.
- `notifications.remote.ts`, `getNotifications` + the
  `markNotificationRead`/`markAllNotificationsRead`/`deleteNotification`
  commands : the bell's feed. It used to be fetched in
  `(protected)/+layout.server.ts` (so **every** protected page load paid for 20
  notifications plus an unread count, whether or not anyone opened the bell) and
  mutated through three one-line `+server.ts` routes each followed by a
  `refreshAll()`, which re-ran every `load` on the page. Each command now calls
  `getNotifications().refresh()` on the server, so the updated feed rides back
  on the mutation's own response.
- `jobs.remote.ts`, `getJobQueue` : the Scheduling page's job-queue panel. Its
  3s poll used to be a `refreshAll()`, re-running that page's entire (large)
  `load` every tick to update one panel.
- `git-repos.remote.ts`, `listProviderRepos`/`hasDockerfile`, and
  `image-check.remote.ts`, `checkImage` : the git repo picker and the
  image-exists warning, both of which were duplicated verbatim between
  `services/new` and the service's Source section. They're now one shared
  component each (`git-repo-picker.svelte`, `image-check-warning.svelte`) over
  one shared query.
- **Every remaining Docker round-trip that used to sit in a `load`.** This was
  the single biggest source of "the app feels sluggish": a navigation couldn't
  paint until the daemon answered, and a slow or unreachable daemon stalled the
  page rather than one panel of it.
  - `service-status.remote.ts`, `syncServiceStatuses` : the status
    reconciliation that ran in the services list's `load` (one `inspect` per
    deployed service, every visit) and again in
    `services/[serviceId]/+layout.server.ts` (once per tab navigation). Both
    pages render the stored `currentStatus` immediately and patch it when this
    lands, so a stale badge corrects itself instead of a blank page waiting.
  - `setup.remote.ts`, `getSetupStatus`/`getNewtContainer` : the setup
    diagnostics (which ping the daemon and the Traefik container) behind the
    dashboard's banner and `/settings`' per-field warnings, plus the Newt lookup
    on the Networking tab. `getSetupStatus` returns `issuesByField` ready-made,
    so the three settings tabs that highlight a field just read it.
  - `docker-infra.remote.ts`, `getCleanupPreview`/`getInfraStatus`/
    `getUnknownHostVolumes` : Docker Cleanup's `system df` preview, System Logs'
    Traefik + compose-stack lookup, and the Storage tab's host-volume picker.

  This is the one category where a _page's own subject_ moved out of `load`, and
  it's allowed for the reason the rule exists: none of it is the page's
  correctness, it's a live reading _about_ what the page already rendered from
  the database. The entity lists themselves still come from `load`.

**Auth is not inherited.** A remote function is its own endpoint : the
`(protected)` layout's `load` guard never runs for one, exactly like a
`+server.ts` route. Every query/command starts with `requireUser()`
(`src/lib/server/remote-auth.ts`), which reads `getRequestEvent().locals.user`
and `error(401)`s otherwise. `hooks.server.ts` populates `locals` for these
requests the same as any other, so cookie sessions and API keys both work. Ones
reading an area's data use `requirePermission(area, level)` from the same
module, which is `requireUser()` plus a `can(locals.permissions, ...)` check and
an `error(403)`. Remote function requests skip the hook's route gate, so the
guard has to be on the function, not only on the route that happens to call it.

**Arguments are validated, not cast.** A query/command taking an argument passes
a zod schema as its first parameter (`query(z.string(), ...)`), the same "one
schema, real runtime validation" posture as the REST API's own
`src/lib/server/validation/api.ts`. Don't reach for `"unchecked"`.

**Two consumption patterns, and the difference matters.** A `RemoteQuery` is a
promise, but it's a _stable_ object : `{#await someQuery}` renders once and will
**not** re-render when `refresh()` lands, because the awaited expression never
changes identity. So:

- A query that refreshes in place (a poll, a command's single-flight update) is
  read through its reactive accessors, `query.ready`/`query.current`/
  `query.error`, with the pending branch rendering
  `src/lib/components/skeleton.svelte`. `host-resources.svelte`,
  `job-queue-panel.svelte` and `notification-bell.svelte` are the reference
  shapes. **`src/lib/components/async-block.svelte` is that whole triple as one
  component** — `<AsyncBlock {query}>` with a `pending` snippet and a
  `children(value)` snippet, rendering an `Alert` with a working **Retry**
  (`query.refresh()`) on failure. Prefer it to hand-rolling the three branches
  again; the hand-rolled ones above predate it and each invented their own
  failure wording with no retry. `tests/unit/app/async-block.test.ts` covers all
  three branches.
- **A query whose argument is reactive must be _called_ inside a `$derived`**,
  not created once: `const q = $derived(someQuery(ids))`. Calling it at the top
  level pins the first argument value forever.
- A one-shot, user-triggered lookup assigns a fresh promise to `$state` and
  `{#await}`s that, which is what makes the block re-run per invocation.
  `git-repo-picker.svelte` (a "List repos" click, then a Dockerfile check for
  the picked repo) is the reference shape.

**A background load through a remote query is still one of the documented
`toast.promise` exceptions** (see Conventions above) : it renders its own inline
spinner/skeleton and reports failure inline, it doesn't narrate itself through a
toast. Mutations that a user deliberately submits still belong in a form action
with `enhanceToast`, not a command.

## Template links (`template_link` table, `TemplateLinkDTO`, `src/lib/services/template-links.ts`)

A template can link to other templates so deploying it deploys its companions
too, e.g. a WordPress-shaped template linking to a "MySQL" template, or a worker
linking to a "Redis" one : `templates/new`'s "Linked containers" section lets a
template author check any other _leaf_ template (built-in or custom, shown with
its image/tag/port/env vars so there's enough to decide by) to link it, with an
optional alias (defaults to the linked template's own slugified name when left
blank). Deliberately two levels deep only, not a general DAG :
`TemplateLinkDTO.create`'s caller (`templates/new/+page.server.ts`) rejects
linking to a template that itself already has links, so a link's target is
always a leaf. This keeps env-var token resolution (below) simple, one level of
substitution, no cycle detection needed.

An env var on the _primary_ template can reference a linked template via
`{{alias}}` (resolves to the linked service's generated slug, its internal DNS
hostname on the shared network regardless of stack, same `http://<slug>:<port>`
addressing every service already gets) or `{{alias.ENV_KEY}}` (resolves to that
linked service's own resolved value for that env var, e.g.
`{{db.POSTGRES_PASSWORD}}`). Resolution (`src/lib/services/template-links.ts`'s
`resolveLinkTokens`) leaves an unknown token untouched rather than stripping it,
so a typo'd alias fails loud (visible literally in the deployed env var) instead
of silently producing an empty value. Linked templates' own env vars are used
as-is, not further resolved : only the primary can reference `{{alias}}` tokens,
not link-to-link.

Deploying from a linked template (`services/new`'s `create`/`createAndDeploy`
actions, via `buildTemplateLinkContext`/`createLinkedServices`) : if the service
being created has no stack yet, one is auto-created (named after it) so the
whole stack shows up grouped ; each linked service gets a deterministic slug
(`<primary-slug>-<alias>`, de-duplicated against existing services via
`src/lib/slug.ts`'s `uniqueSlug`/`suffixedSlug`, the one retry-loop shared by
every slug-generating caller: compose import, migration import, and stack
creation here, replacing four near-identical private implementations) and
deploys from its own template's image/tag/port/envVars/resources, created
`dnsResolvable: false` by default (a database/cache/worker doesn't usually want
a public subdomain). `createAndDeploy` deploys every linked service before the
primary, same "bring up dependencies before dependents" ordering
`docker compose`'s `depends_on` implies, though nothing here actually waits for
a linked service to be _healthy_, just created and started.

## Template runtime options and host access

`template` carries the same runtime columns as `service` (`capAdd`, `command`,
`devices`, `entrypoint`, `envFiles`, `labels`, `privileged`, `runAsUser`), typed
through `ServiceRuntimeOptions` (`src/lib/service-runtime.ts`):
`NewTemplateInput` and `BuiltinTemplate` both extend
`Partial<ServiceRuntimeOptions>`, and
`TemplateDTO.create`/`seedBuiltinTemplates` normalize through
`runtimeOptionsFrom`. `TemplateDTO.runtimeOptions` and
`TemplateLinkWithTemplate.linkedTemplateRuntime` are what the deploy paths read.
Captured by `saveAsTemplate` (the service Settings tab), `templates/new` (a
**Runtime** section rendering `src/lib/components/runtime-fields.svelte`, the
same component a service's Container → Runtime uses, with `showEnvFiles`; parsed
with `updateRuntimeSchema` + `updateEnvFilesSchema`) and returned by
`GET /api/v1/templates`. There is no template edit, export or import to carry
them through.

Applied on every create-from-template path: `createServiceFromTemplate` (Quick
Deploy) passes `runtime` for the primary and `createLinkedServices` for each
companion (`ResolvedTemplateLink.runtime`); the wizard (`services/new`) passes
the template's options on create, since the wizard itself has no runtime fields
and only shows them as a `runtimeOptionsSummary` line in its template banner.

**Host access needs write access to System.** Without it a caller can't set
privileged, devices, capAdd or envFiles on `templates/new` (403,
`hostAccessRequested`), and
`templateHostAccessRefusal(template, links, hostAccess)`
(`src/lib/services/template-links.ts`, built on `templatesNeedingHostAccess` +
`templateHostAccessMessage` in `src/lib/host-access.ts`) refuses such a deploy
when the primary **or any linked companion** needs it. It runs after
`buildTemplateLinkContext` but before a stack or any service is created, so a
refusal leaves nothing behind: `quickDeployFromTemplate` returns a 403,
`services/new`'s `prepareLinkedStack` returns a 403 `fail`. The details page and
the wizard compute the same refusal in `load` to warn up front (Quick Deploy is
disabled on the details page). `saveAsTemplate` doesn't check: it only copies
values an admin already set on the service.

## Built-in template catalog and gallery (`templates/<category>/*.json`, `builtin-templates.ts`, `template-icon.svelte`, `templates/[templateId]/`)

Built-ins are data, one JSON file per template under the repo-root
`templates/<category>/`, so contributing one is a single file (plus an optional
icon) with no TypeScript. The folder is the category and the file name is the
slug: the template's id is `builtin-<slug>`, so a file name is permanent once
shipped (renaming it deletes the old template and creates a new one, orphaning
services' `templateId`). Links are declared inline
(`"links": [{ "alias": "db", "template": "postgres" }]`), their ids are
`builtin-link-<slug>-<alias>`, and the target must be a leaf.

Generated secrets (`src/lib/template-secrets.ts`): `{{secret}}` is one 48-hex
value per created service, shared by every env var and command arg that uses it
(the wizard's submitted value wins, so the command matches an edited password).
`{{secret:hex<N>}}` is for apps that validate a key's format (AIOStreams refuses
to boot without a 64-hex `SECRET_KEY`): each occurrence is its own fresh N hex
chars, and both mark their env var secret. `parseBuiltinTemplates` rejects any
other `{{secret…}}` spelling, so a typo fails the unit test instead of shipping
a literal token.

`{{url}}` (`src/lib/template-url.ts`) is the service's public URL,
`https://<defaultHostname>`, filled by `createServiceFromTemplate` (Quick
Deploy) and by the wizard's create action (which prefers the custom domain it
was given); the wizard's form shows the raw token. A built-in template's
`volumes` (container paths, `template.volumes`) get one named volume each
through `default-volume.ts`'s `attachTemplateVolumes`, named like the wizard's
new volumes (`<slug>-data`, `<slug>-data-1`), before `attachDefaultDataVolume`
runs (which then sees a mount and bails); the wizard pre-fills them as "New
volume" rows instead. Both exist because the templates E2E suite showed ten
templates crash-looping or 500ing on a fresh deploy for want of a data volume, a
generated key or their own URL.

`seed.ts` loads them with Vite's `import.meta.glob(..., { eager: true })`, so
they're bundled into the compiled binary at build time, nothing reads the disk
at runtime. That also means `seed.ts` can't be imported outside Vite (bun tests
and scripts have no `import.meta.glob`): the parsing and validation live in
`builtin-templates.ts`'s `parseBuiltinTemplates` (zod, strict, so a misspelled
field fails instead of vanishing), which the unit test drives by reading the
files itself. `bun run gen` writes `templates/schema.json` from the same zod
schema, and every file's `$schema` points at it for editor completion. Built-in
links are replaced wholesale on boot: any `builtin-link-%` row no longer
declared is deleted, then the declared ones are upserted. Every image was
verified real via `docker manifest inspect <image>:<tag>` before being added.

**The seed upserts rather than `onConflictDoNothing()`, and it has to.** A
built-in is code, not user data (`ownerId` null), so an instance that seeded
once would otherwise keep the first version of every row forever : adding `tags`
to the catalog changed nothing on any existing install, which is exactly how it
was caught. `seedBuiltinTemplates()` now writes every display field back from
`excluded.*` on conflict, so a boot re-syncs the catalog to whatever the code
says. It deliberately doesn't touch `createdAt` or `ownerId`.

**Adding a built-in can push an existing one off the gallery's first page**,
which is how a green local run still failed CI: the built-in list is paginated
at 24, ordered by name, and the docs-screenshot spec used to wait for
`/Jellyfin/i` on `/templates` before capturing. Thirteen new templates moved
Jellyfin to page two and the shot timed out. That expectation is now
`/New Template/i` — present on the page whatever the catalog holds, and absent
from the sidebar, so it still proves the page rendered. Don't anchor a
screenshot (or a test) on a template name.

**Tags (`template.tags`, `text[]`)** are the search keywords a category can't
be: a category is one bucket per template, tags are many and overlap ("sql",
"arr", "self-hosted"). `TemplateDTO.listPaged` ORs a `tagSearchCondition` over
the existing name/description/image `searchCondition` —
`array_to_string(tags, ' ') ILIKE '%q%'` rather than a column list, since
`searchCondition` only takes text columns and this one is an array. The Tags
field on `templates/new` is comma-separated text run through `parseTags`
(`src/lib/server/validation/template.ts`: trimmed, lowercased, de-duplicated, 12
tags of 30 chars max, so one paste can't fill the column), and every built-in
carries its own set, checked by a test that fails on an untagged one.

Every template row (`template.category`/`sourceUrl`/`websiteUrl`, the latter two
added to `schema.ts` and `TemplateDTO.NewTemplateInput` alongside the
pre-existing `icon`) can carry a source-code and a website link, shown as
external-link buttons on the template details page (below); either can be `null`
(some projects genuinely have no separate marketing site).

**Icons are real app logos, not generic per-category lucide icons.** A
template's or service's `icon` column holds one of four shapes, all parsed by
`src/lib/service-icon.ts` (`hasIconImage`/`iconSrc`/`iconProblem`): `di:<slug>`
for a [Dashboard Icons](https://dashboardicons.com) logo
(`homarr-labs/dashboard-icons`, Apache 2.0, slug `^[a-z0-9][a-z0-9-]*$`), a
bundled file name under `static/template-icons/` (`"redis.svg"`), an uploaded
`data:image/...;base64` URL, or `null`/a legacy category string (anything else)
for the category's generic icon. Built-ins use `di:` wherever Dashboard Icons
has the exact app (checked against the real `metadata.json`, not guessed); the
bundled files stay for the handful it lacks (aiometadata, aiostreams, bercail,
comet, mediaflow-proxy, nuvio, penombre) and for `icon-library.ts`'s
servers/languages/frameworks set where it lacks the logo; the library points at
`di:` for the rest. A bundled file that duplicates a Dashboard Icon gets deleted
together with a migration rewriting `service`/`stack`/`template.icon` from the
file name to `di:<name>` (`0096_dashboard_icons_for_bundled.sql` is the
precedent), otherwise every service still on it shows a broken image. The seed
upserts `icon` like every other display field, so a boot moves every install's
built-ins to the new value, while a service copied its template's icon at
creation and keeps it. Because of that, the settings action only runs
`iconProblem` when the icon actually changed, so re-saving a service whose
stored icon is no longer in the library isn't refused.

**No browser ever calls jsDelivr.** `/icons/dashboard/[name]` (public, outside
`(protected)`, since status pages and `/my-apps` render icons too) serves the
icon from `DashboardIconsService`
(`src/lib/services/dashboard-icons.service.ts`): the catalog (`metadata.json`,
~1.1 MB, trimmed to name/aliases/lowercased categories/format/colour variants)
is kept in memory and at `<STORAGE_BASE_PATH>/dashboard-icons/catalog.json`,
refreshed after 24h stale-while-revalidate, so it works offline from the disk
copy. Icons are fetched once in the catalog's `base` format (svg or png, never
webp) and written to `dashboard-icons/icons/<name>.<ext>`; an entry with
`colors` whose plain file is missing upstream (e.g. `dagster`, only
`-dark`/`-light` exist) falls back to its dark then light variant.
`?theme=dark|light` picks the variant for the viewer's theme (`themedIconFile`):
upstream's naming is `<name>-light` for dark backgrounds and `<name>-dark` for
light ones (checked against the real `colors` map, only `apple` breaks it), so
that suffix is looked up in the entry's `variants` rather than trusting the
`colors` keys, and the old on-disk catalog keeps working. Each variant is cached
under its own file name and falls back to the base. `template-icon.svelte` and
the picker pass mode-watcher's `mode.current`, so the `src` swaps live on a
theme change; SSR renders the base until hydration. Unknown names 404 without a
CDN call, a name upstream doesn't have is negative-cached in memory for 10
minutes, bodies over 2 MB are refused. **`tree.json` is stale and useless for
existence checks** (it misses ~970 names that do exist, e.g. `8311`), which is
why nothing reads it. Every response carries
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
and `nosniff`, so opening an SVG directly can't run script on Homerun's origin.
`config.dataDir` is `STORAGE_BASE_PATH` (`/app/data` in the image, the data
volume; `./data` in dev, gitignored).

`src/lib/components/template-icon.svelte` is the one place that renders an icon
anywhere in the app, and it falls back to the category icon on the `<img>`'s
`onerror`, so an unreachable CDN or a bogus `di:` name never shows a broken
image. The picker is `dashboard-icon-picker.svelte` inside the service Settings'
Type & icon section, fed by the `getDashboardIcons` remote query: search over
name and aliases, a category select, 48 results at a time with "Show more", lazy
`<img>`s through the proxy. Otherwise:
`templateCategoryIcon(category)`/`templateCategoryColor(category)`
(`src/lib/constants.ts`, `TEMPLATE_CATEGORY_ICONS`/`TEMPLATE_CATEGORY_COLORS`,
keyed by the `category` column) — one lucide icon and one accent color per
category (e.g. media is rose, database is emerald, monitoring is cyan), not a
flat single fallback color, so an app without an official logo is still visually
distinguishable at a glance from its neighbors. `templateIcon()`/
`TEMPLATE_ICONS` (the old flat category→icon map this replaced) no longer exist.

The gallery (`templates/+page.svelte`) uses the shared list-page toolkit (see
Shared UI components above) for its search (matches name/description/image) and
category filter (pills built from whatever categories are actually present
rather than a hardcoded list, `TemplateDTO.listCategories`), plus a list/card
`ViewModeToggle` (`new ViewMode("templates", "card")`, card is the default here,
unlike every other list page). This replaced the page's own earlier bespoke
search-input-plus-`Drawer` implementation (`src/lib/components/ui/drawer`,
vaul-svelte's `direction` prop), now generalized into `entity-toolbar.svelte`
and shared with every other list page instead of being templates-only. The
built-in and custom sections paginate **independently**, 24 per page each,
`TemplateDTO.listPaged("builtin" | "custom", query)` called twice with two
separate `ListQuery`s (`pageParam: "bpage"` / `"cpage"`, see Server-side list
pagination above), one shared search/category toolbar filtering both, two
`<Pagination>` footers reading their own param. Each card/row links to
`templates/[templateId]/`, a details page (`+page.server.ts` guards via
`TemplateDTO.get`, same lookup every deploy-from-template path uses) showing the
full description, container port/CPU/memory/env vars, the source/website links,
any linked companion templates (below), and the GitHub repo panel/readme
(below). Every card and the details page carry two actions instead of one:
**Quick Deploy** (primary) calls a `quickDeploy` form action
(`src/lib/services/template-links.ts`'s `quickDeployFromTemplate()`, shared by
both routes) that creates the service straight from the template's defaults
(name/slug auto-generated via `slugify`) and deploys it immediately, no wizard;
**Configure** (secondary) is the old single "Deploy" button, renamed since it
only navigates into `services/new` (carrying `templateId`, and `stackId` when
arrived at from a stack) to let the user tweak first. The gallery's
`quickDeploy` action returns a plain success object (not a redirect) so
`use:enhance` can show a `toast.success` with a "View" button instead of yanking
the user out of the grid mid-browse, letting several templates get
quick-deployed back to back; the details page's own action still `redirect()`s
straight to the new service, no grid to lose there.

**GitHub repo enrichment** (`src/lib/services/github-repo.service.ts`): when a
template's `sourceUrl` is a `github.com` URL, the details page's `load` calls
`getGitHubRepoInfo()`, which resolves owner/repo from the URL and hits
`api.github.com`'s repo/releases/readme endpoints (unauthenticated, so the usual
public 60 req/hr-per-IP limit applies) for star count, last-push time, latest
release tag, and the rendered readme. Returned **without being awaited** in
`load()`, SvelteKit streams it, so a slow/rate-limited GitHub response doesn't
block the rest of the page; `+page.svelte` renders it via
`{#await data.github then repo}`. Every fetch has an 8s `AbortSignal.timeout`
and the whole thing is wrapped in try/catch, GitHub being slow or down never
breaks the page, `getGitHubRepoInfo()` just resolves to `null` and the panel/
readme sections don't render. Results are cached in-memory per `owner/repo` (1h
TTL, HMR-safe `globalThis` singleton, same pattern as the db client) since every
viewer of the same template would otherwise re-hit the same three endpoints. The
readme is rendered with `marked` (already a dependency) through a custom
renderer that resolves relative image/link paths against the repo's default
branch (`raw.githubusercontent.com` for images, a `blob/<branch>/` GitHub URL
for links), then run through `sanitize-html` (a new dependency, added
specifically for this) before being sent to the client and rendered via
`{@html}`. This sanitization step is load-bearing, not decorative: a template's
`sourceUrl` is user-settable (a developer can save any service as a template
with any source URL), so a malicious template could point at a repo whose README
is crafted to exploit gaps in GitHub's own rendering; sanitizing server-side
means the client only ever receives an already-restricted tag/attribute
allowlist, regardless of what GitHub returned.

## Status pages (`status_page`)

A status page groups services and answers one question — is this up? — for an
audience that may not be signed in. Three shapes, set by `scope`:

- `global` : every service on the instance.
- `stack` : that stack's services.
- `custom` : a hand-picked list, the only one that reads `status_page_service`.

**`global` and `stack` resolve live** (`StatusPageDTO.serviceIds()` queries
`service` on every read) so deploying a new service puts it on the page without
anyone re-editing it. That's the whole reason the join table isn't used for all
three. The same goes for a custom pick's `include_children`: its previews and
canary (`service.previewParentId` = the pick) are looked up on every read by
`StatusPageDTO.members()` (`resolveStatusPageMembers` does the ordering), never
stored, since previews open and close on their own.

**Custom domains** (`status_page.domains`,
`StatusPageSettingsService.syncRoutes`, `src/lib/status-page-domains.ts`) are
served by a Traefik file-provider config, `homerun-status-pages.yml`, not by
rewriting `/` inside the app: a rewrite would leave the browser on `/` while
SvelteKit rendered `/status/<slug>`, and the client router's next data request
would load the dashboard's home. So a router per domain matches only the page's
own paths (`/`, `/status/<slug>`, `/_app/`, the favicon), `/` redirects to
`/status/<slug>` (`redirectRegex`, query kept), and everything else on the
domain falls through to the error pages' catch-all, which keeps the dashboard
unreachable there. The service points at the app the way the error pages do
(`errorPagesTarget(config.authCheckUrl)`). Every save and delete rewrites the
file and syncs DNS with `sso: false`; the core-services watch re-asserts it.
**Verified live** against Traefik v3.5 with a whoami backend: `/` → 302 to the
page with the query kept, page and `_app` 200, `/services` and `/auth/sign-in`
404 on the status domain.

`/status-pages` is the operator's view: health of every service and the pages
themselves, with a link out to `/notifications/settings/channels`.
`/status/<slug>` is the public one, and the routing and disclosure rules for it
are in `routing.md`: read that before touching either.

**Alerts fire on a state change, not on a state.** `uptime-probe.ts`'s tick
reads the previous beat per probe before recording the new one and
`detectTransitions` diffs them, so a service that's been down for an hour
doesn't re-alert every minute, and a probe with no previous beat never alerts at
all (otherwise the first tick after a deploy, or after `prune()` cleared the
window, would alert on everything at once). A transition no longer needs a
status page at all : it's dispatched straight to every account-wide channel
subscribed to `service.down`/`service.up`, see Outbound notification channels in
`observability.md` for the channel model (`notification_channel`,
`NotificationChannelService`) and `tests/unit/app/status-alert.test.ts` for the
transition logic itself.

## Git-based builds (`internal/agent/build.go`, `internal/agent/builders.go`, `internal/jobs/deploy/build.go`)

A service's `buildSource` is `"image"` (bring-your-own, the default) or `"git"`,
set on the new-service form or edited later in Environments & Deployments →
Source, both share the same "Deploy from" toggle UI. **The whole clone-and-build
pipeline now lives in one place, `internal/agent`** : the SvelteKit app's own
copy (`docker/git-build.ts`, `docker/builder-run.ts`) was deleted once the
`deploy` job type moved to the Go worker (see "Deploys run in the Go worker"
above). `internal/jobs/deploy/build.go`'s `dockerBuild` calls
`agent.NewBuilder(docker, socket).BuildWithProgress` directly (a local build or
a `"docker"` build server), and `agentBuild` calls the exact same code over HTTP
on a registered Homerun Agent build server (`POST /v1/build`) — the same package
either way, not two implementations kept in sync by hand anymore (see
`packages-and-release.md`).

**The clone runs in a container, into a Docker volume — never on the host.**
`Builder.BuildWithProgress` creates a throwaway `homerun-agent-build-<hex>`
volume, runs `alpine/git` against it (`gitCheckoutSteps`,
`internal/agent/git.go`: `clone --depth 1 --branch <ref> --single-branch` into
`/workspace/repo` for a branch or tag, or
`init`/`remote add origin`/`fetch --depth 1 origin <sha>`/
`checkout --detach FETCH_HEAD` for a full 40-hex commit SHA, which
`clone --branch` can't take), then a second container for `rev-parse HEAD`, then
runs the build in a `docker:cli` helper container with that volume mounted (see
Build methods below, every method including the Dockerfile goes through BuildKit
there). The result is tagged with the caller's own tag (the Go worker's
`homerun-build-<slug>:<timestamp>` for a local/build-server build, the agent's
caller-supplied tag otherwise), a fresh tag every build, same "never reuse a
name across deploys" precedent as container names. Build output streams into the
deployment log line by line (`progress func(string)`, wired to `job.AppendLog`
from the worker, to the agent's own process log when it isn't answering
`/v1/build` inline). The volume and every helper container are always removed
afterward (`defer`), success or failure. A SHA-pinned service never matches a
push and is never polled.

This replaced `execFile("git", ...)` into an `mkdtemp()` directory, and it was a
**production bug fix, not a refactor**: the app's runtime image is
`oven/bun:1-alpine` plus `ca-certificates` and `su-exec` (see the `app` stage of
the `Dockerfile`), which has no `git`, so the old TS code failed with ENOENT and
git-based builds only ever worked in dev. Verified by running the base image:
`command -v git` finds nothing. The temp directory was the second problem —
inside the container it was the container's own ephemeral writable layer, not a
volume, so a large clone grew the container unboundedly and vanished on restart.
The agent image (`oven/bun`-free, a plain Go binary) has no `git` either, for
the same reason, which is why this shape was always shared.

Three things about this shape are load-bearing:

- **It stays on one daemon.** A real Docker-in-Docker sidecar would build on a
  _different_ daemon, and the image would then need a cache registry to get back
  to the deploy target — the same constraint `deploy/plan.ts`'s
  `resolveDeployPlan` already enforces for build servers. The helper container
  talks to the building daemon's own socket and BuildKit, so the image lands in
  that daemon's store.
- **Argv is passed directly, never through `sh -c`.** The repo URL and ref are
  user input.
- **Container output is demuxed, not stripped.** Docker frames non-TTY output
  with an 8-byte header whose big-endian length bytes are often printable ASCII
  — a 41-byte frame carries `)`. A "drop control characters" pass left that `)`
  glued to the front of the commit SHA (a real, observed
  `Building commit )68c1b9`), so `internal/dockerapi.Demux` walks the frames
  properly and `ExtractCommitSHA` (`internal/agent/git.go`) matches
  `\b[0-9a-f]{40}\b` rather than slicing. Both are unit-tested
  (`tests/unit/go/internal/agent/git_test.go`, `internal/dockerapi`'s own tests)
  — the app's old `demuxDockerFrames`/`extractCommitSha`
  (`tests/unit/app/git-build.test.ts`) are gone along with
  `docker/git-build.ts`.

**Build methods** (`service.gitBuildMethod`, `src/lib/build-methods.ts` on the
form side): `dockerfile` (default), `bake`, `nixpacks`, `railpack`, `heroku` and
`paketo` all go through `Builder.runBuilder`, which runs
`internal/agent/builder.sh` (`//go:embed`-ed by `internal/agent/builders.go`) in
a throwaway `docker:29.8.1-cli` container (pinned, ships buildx 0.37) on the
building daemon with the clone volume at `/workspace`, a persistent
`homerun-builder-tools` volume at `/tools` and the daemon socket at
`/var/run/docker.sock`. The socket's bind source is `config.docker.socketPath`
for a local build (the installer mounts a rootless socket at the same path on
both sides of the app container, so this is the host path, passed to the Go
worker as `spec.SocketPath`) and `/var/run/docker.sock` on a Docker-connection
build server; the agent uses its own `DOCKER_SOCKET_PATH`.

**The Dockerfile path used to be dockerode's `buildImage()` (the classic
builder) and was replaced, not kept alongside.** Real bug: a Dockerfile with
`COPY --chmod` failed with "the --chmod option requires BuildKit", and
`RUN --mount` and `# syntax=` frontends can't work there either. Now
`dockerfile` runs `docker buildx build --progress plain -f <file> -t <tag>` with
`--load <context>` (`BUILD_FILE`, the Dockerfile path resolved by
`builderFilePath`, relative to the build context, refused if it leaves the
repo). `bake` runs from the build context directory:
`docker buildx bake --progress quiet -f <file> --print <target>` first, an awk
pass over its JSON counts the resolved targets (a group resolving to more than
one fails with their names; `--set` patterns don't match group names, verified
live), then `docker buildx bake --progress plain -f <file>` with
`--set <resolved>.tags=<tag>`, `--set <resolved>.output=type=docker` and
`<target>`. `--set ...output` rather than `--load`, because `--load` is
conditional and a target with its own `output = ["type=registry"]` must still
end up loaded under Homerun's tag (verified live: a target tagged
`example.invalid/web` with a registry output loaded as
`homerun-build-live-bake:1` and nothing was pushed). The target lives in one
field for both methods, `service.gitBuildTarget` (`buildTarget` on the worker's
`BuildInput`, `BUILD_TARGET` in the builder container): the bake target for
bake, the `--target` stage for a Dockerfile (omitted when empty, so the last
stage builds). It is validated against `bakeTargetPattern`
(`internal/agent/builders.go`, compiled from `builder-tools.json`'s
`bakeTargetPattern`, no leading dash, so it can't be read as a flag, no dots,
since `--set a.b.tags` splits on the first dot). A failed build throws
`BuildFailureMessage`: the exit code plus the last BuildKit `ERROR` line from
the last 40 output lines, so the deployment error says why, not "see the log"
(the agent returns no log at all).

None of the three tools ships an official CLI image, so the script downloads the
pinned musl release binary from GitHub once per version into `/tools` and runs
it. The binary runs with the Docker socket mounted (root-equivalent), so
`builder-tools.json`'s `checksums` (`tools.Checksums` in
`internal/agent/builders.go`) pins a sha256 per tool per arch for both the
release archive (matching the project's published `checksums.txt`/`.sha256`
files, or the GitHub release asset digest for Nixpacks, which ships none) and
the extracted binary: the script verifies the archive before extracting, the
binary before installing, and the cached binary on every build (a mismatch
re-downloads, a mismatched download fails the build with "Checksum mismatch").
Verified live: a tampered cached binary was re-downloaded, a wrong pinned
checksum failed the build and installed nothing. Bumping a version means
updating these checksums. Commands: `nixpacks build <dir> --name <tag>` (shells
out to the docker CLI with BuildKit), `railpack prepare <dir> --plan-out ...`
then `docker buildx build` with the build arg
`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v<version>`,
`-f <plan> -t <tag> --load <dir>` (the documented production path, no separate
BuildKit daemon needed), and `pack build <tag> --builder <builder>` with
`--path <dir> --trust-builder --pull-policy if-not-present --network bridge`,
with `PACK_VOLUME_KEY` set to the image name so a service reuses its cache
volumes. User input only travels as env vars quoted inside the fixed script,
never spliced into it. Verified live on Docker Desktop (arm64): Nixpacks and
Railpack built and ran a Node app through `Builder.BuildWithProgress`. **Real,
tested findings for pack**: without `--network` it creates an ephemeral bridge
network per build, which fails with "all predefined address pools have been
fully subnetted" on a daemon with many networks, hence `--network bridge`; and
on Docker Desktop's containerd image store the export step fails with "does not
provide the specified platform" (a pack/containerd-store issue, `--platform`
doesn't help), so buildpacks got as far as export there but weren't seen
producing an image; a Linux engine with the classic store is the expected
target. A cache registry is a BuildKit registry cache for `dockerfile`, `bake`
and `railpack` (see below) and ignored by Nixpacks and pack.
`internal/agent/builder.sh` and `internal/agent/builder-tools.json` (the script,
methods/versions/checksums/images/bake-defaults) are `//go:embed`-ed by
`internal/agent/builders.go` and are now the **only** copy : the app's own
`docker/builder-run.ts`, which used to export the same methods/checksums/etc. as
TS constants purely so the two sides could be pinned against each other, was
deleted along with the rest of `docker/git-build.ts`'s TS pipeline. What's left
of that parity check is narrower: `tests/unit/app/agent-builder-parity.test.ts`
now only asserts `src/lib/build-methods`'s form-facing constants
(`BUILD_METHODS`, `BAKE_TARGET_PATTERN`, the bake defaults) equal what's checked
into `builder-tools.json`, so the new-service form and the Source section never
offer a method or bake default the builder itself would reject — golden-fixture
`BuilderEnv`/build-failure-message parity across every recorded input is now
`tests/unit/go/internal/agent/builders_test.go`'s job alone (`go test`, against
the same embedded files, `tests/unit/go/internal/agent/testdata/*.json`), with
no TS side left to pin it against.

Any git-clone-able HTTPS URL works, this is what makes it "Git providers,
including self-hosted Gitea" without any provider-specific API integration for
the clone/build step itself: cloning is provider-agnostic at the URL level, so
GitHub/GitLab/a self-hosted Gitea instance/anything else all just work the same
way. Push-to-deploy is its own section below. There **is** also a repo-browsing
UI and OAuth-based private-repo access, see Git provider connections below; a
private repo can still fall back to a token embedded in the URL
(`https://TOKEN@host/...`) without connecting a provider at all.

**Build cache and build servers** (`build_cache_registry`,
`service.buildCacheRegistryId`/`buildServerRemoteHostId`,
`/build-cache-registries`): a git-mode service can name a registry credential to
use as a BuildKit layer cache: `BuilderEnv` sets `CACHE_REF`
(`<registry>/homerun-build-<slug>:buildcache`, `BuildCacheRef`) plus the
credentials, and the script logs in (`docker login --password-stdin` inside the
ephemeral helper, so nothing persists) and adds
`--cache-from type=registry,ref=<ref>` and
`--cache-to type=registry,ref=<ref>,mode=max,ignore-error=true` (bake: the same
through `--set <target>.cache-from/cache-to`). Both directions are best-effort:
a missing cache logs `failed to configure registry cache importer ... not found`
and builds anyway, `ignore-error=true` keeps a failed export from failing the
build. **Real, tested finding**: the daemon's default `docker` driver can't
export a registry cache on the classic image store, so a cached build uses a
`docker-container` builder named `homerun-cache`, created on first use with
`--driver-opt network=host` (so the BuildKit container resolves registries like
the daemon does) and its buildx config kept in `/tools/buildx` (`BUILDX_CONFIG`)
so every later helper finds it; `--load` then imports the result into the
daemon. Verified live against an htpasswd-protected `registry:2`: the first
build exported `:buildcache`, and after `docker buildx prune` on the builder a
rebuild showed `importing cache manifest` and `CACHED` for the
`RUN --mount=type=cache` and `COPY --chmod` steps. The old approach (pull
`<registry>/<image>:cache`, pass it as the classic API's JSON-string
`cachefrom`, push the built image back as `:cache`) is gone.
`buildServerRemoteHostId` picks a _different_ host to build on than the one the
service deploys to (any registered Remote Host, see Build servers below);
`deploy.service.ts` rejects that combination outright unless a cache registry is
configured too, since publishing through that registry is the only way the built
image reaches the deploy target.

## Git provider connections (`instance_settings.gitProviders`, `git_connection` table, `src/lib/services/git-provider.service.ts`, `/git-providers`)

Separate from the git-clone-based builds above, this is what makes the Source
section's "Browse repos" picker possible instead of pasting a raw URL. Two
layers, matching how OAuth generally works: an **OAuth App** registered once per
provider (GitHub/GitLab/self-hosted Gitea/Bitbucket) on that provider's own
site, configured on the `/git-providers` page (admin-only to add/remove,
DB-backed, `instance_settings.gitProviders` jsonb array, same "settings stored
in the DB via a form" convention as SMTP/OAuth-login providers, not env-only);
and a **connection**, one user's own OAuth authorization against one configured
provider (`git_connection` table, `userId` + `providerId`, AES-256-GCM-encrypted
access/refresh token), every developer connects their own account from the same
page, admin-configuring-the-app is a one-time step separate from each user's own
connect.

`GitProviderService` (`src/lib/services/git-provider.service.ts`) implements one
standard OAuth2 authorization-code flow, parameterized per provider kind
(`endpoints()`, authorize/token/API base URLs and scope differ; Bitbucket
authenticates its token exchange via HTTP Basic instead of body params,
everything else is uniform). `createState()`/`verifyState()` sign a stateless
CSRF state param with `config.auth.secret` (HMAC + `timingSafeEqual`) rather
than a DB-backed state table, nothing to clean up, verified purely from the
value itself. The OAuth round-trip lives under
`/api/v1/git-providers/[providerId]/{connect,callback}` (outside `(protected)/`
for the same reason the REST API is, a provider's own redirect can't carry
cookies through a page-load auth guard the same way). The Source section's repo
picker (`src/lib/components/git-repo-picker.svelte`) lists the connected
account's repos and checks for a `Dockerfile` at a given ref through
`src/lib/remote/git-repos.remote.ts`, not a `+server.ts` route, see Remote
functions below; both go through `GitProviderService.listRepos`/`hasDockerfile`,
which branch per-kind the same way `endpoints()` does.

**GitHub is registered as a GitHub App through the manifest flow, never by
pasting credentials** (`src/lib/github-app.ts`). The `createGithubApp` action
picks the provider id up front and returns `githubAppRegistration(...)`: a form
target on `github.com/settings/apps/new` (or an organization's) carrying a
`createState(providerId, userId)` state, and the manifest JSON, with
`redirect_url` = `/api/v1/git-providers/<id>/github-app` and `callback_urls` =
that provider's usual `/callback`. The page then posts that form to GitHub
itself. GitHub sends the admin back with a one-time `code`, the `github-app`
route verifies the state, trades the code at
`POST /app-manifests/<code>/conversions` for the app's client id/secret, saves
the provider under the pre-picked id, and redirects to the app's
`/installations/new`. Connecting afterwards is the ordinary OAuth flow: a GitHub
App's user-to-server token is issued by the same `login/oauth` endpoints and
only sees repos the app is installed on. The manifest's permissions (contents,
metadata, checks and statuses read, repository hooks write) are exactly the API
calls this app makes; adding a GitHub call means adding its permission there,
and existing apps need it granted on GitHub. `addProvider` no longer accepts
`github`. Not live-tested against github.com yet.

**Every token read goes through `GitProviderService.accessToken()`**, never
`decryptSecret(connection.accessTokenEnc)` directly: repo listing, the
Dockerfile check, deploy clone credentials (`deploy/helpers.ts`'s
`resolveGitCredential`) and status checks (`status-check.service.ts`). Gitea (1
hour), GitLab, Bitbucket and GitHub Apps all issue short-lived access tokens
with a refresh token; `accessToken()` refreshes one within a minute of
`expiresAt`, persists the rotated pair onto the connection, and dedupes
concurrent refreshes per connection (providers that rotate refresh tokens reject
the old one's second use). Real bug this fixed: nothing ever refreshed, so a
Gitea connection stopped listing repos an hour after it was authorized, which
looked like "connecting GitHub breaks Gitea and vice versa" because whichever
provider was re-authorized most recently was the only one still in its token
lifetime. A refresh that fails falls back to the stale token, so the caller's
API call surfaces the failure and the user reconnects.

**Not live-tested against a real registered OAuth App**, unlike everything else
in this document's "real, tested" notes, this one couldn't be verified
end-to-end in the session that built it: doing so requires an admin to actually
register an OAuth App on GitHub/GitLab/Gitea/Bitbucket's own site first, with a
real callback URL, which nothing server-side can do standalone. Built carefully
from each provider's own standard, well-documented OAuth2 + REST API shapes;
verify the first real connect by hand once an OAuth App exists.

## Push-to-deploy (`service.autoDeployOnPush` + `git*` webhook columns, `src/lib/git-webhooks.ts`, `GitWebhookService`, `/api/v1/webhooks/git/[serviceId]`)

A git service picked from a connected account stores `gitProviderId` + `gitRepo`
(the provider's `owner/name`, or a GitLab group path) next to `gitUrl`;
`GitSourceFields` (`src/lib/components/git-source-fields.svelte`, used by the
wizard and the Source section) submits them as hidden fields, with the clone URL
only shown behind "Use a clone URL instead" and a branch `<select>` fed by
`listRepoBranches`. Picking a repo turns `autoDeployOnPush` on.

`GitWebhookService.sync(svc, previous)` runs after every save that can change
the source (wizard create, Source section, REST POST/PATCH), with the pre-save
`{gitProviderId, gitRepo, gitWebhookId}`: a hook on a repo the service no longer
builds from (or with deploy-on-push off) is deleted from the provider, a 48-hex
secret is kept encrypted in `gitWebhookSecretEnc` whenever deploy-on-push is on
(so a hook can always be added by hand), and a new hook is registered via
`GitProviderService.createPushWebhook` as the **service owner's** connection.
Any reason it couldn't (no Dashboard URL, a pasted URL, no connection, a
provider refusal) lands in `gitWebhookError` and the Source section shows the
URL + secret instead; `sync` never throws.
`ServiceLifecycleService.deleteService` calls `remove()` once the workload is
gone.

Deliveries hit `/api/v1/webhooks/git/<serviceId>` (public; no session, no API
key). `handleDelivery` 404s unless the service is git + deploy-on-push with a
secret, verifies the signature per provider kind (`verifyGitWebhook`: GitHub
`X-Hub-Signature-256`, Gitea `X-Gitea-Signature` or the GitHub header, GitLab
`X-Gitlab-Token` compared to the secret, Bitbucket `X-Hub-Signature`; kind from
the provider row, else `inferProviderKind(gitUrl)`, else any scheme), and
`parsePushEvent` pulls `{branch, commit}` out of each provider's payload
(Bitbucket can carry several changes; tags, deleted branches and pings yield
nothing). A push to `svc.gitRef` calls
`enqueueDeploy({trigger: "push", userId: svc.userId})`, which coalesces with an
already queued deploy like any other. Responses are 202 for both deployed and
ignored. The path is exempt from `csrfHandler`, since some providers post form
bodies.

`DeployTrigger` (`src/lib/deploy-trigger.ts`) is now the one definition of
`manual | cron | push`, used by the queue payload, `deployService`, both
notification modules and `deployEvent`; "Git push" is the channel label.

**Scopes changed** to allow hook management: GitLab `api read_user`, Gitea
`write:repository read:user`, Bitbucket `repository webhook account` (GitHub's
`repo` already covers hooks). Existing connections keep their old scopes until
reconnected, and `#api` turns a provider 401/403 into "reconnect it on the Git
Providers page". Covered by `tests/unit/app/git-webhooks.test.ts` (signatures,
payloads, request shapes) and `tests/integration/git-webhook.test.ts` (bad
signature, other branch, ping, a real enqueued deploy job, unknown service).
Registering against a real provider hasn't been live-tested, same caveat as the
OAuth connect flow above.

### Polling fallback (`GitPollScheduler`, `service.gitPollEnabled`, `service.gitLastSeenCommit`)

`CronService.startGitPollScheduler()` runs `cron/git-poll-scheduler.ts` every
two minutes over `ServiceGitDTO.listPushPollable()`: git services with
deploy-on-push, not previews, with `gitPollEnabled` or no `gitWebhookId`. It
reads the branch head with `StatusCheckService.clientFor(...).resolveCommit` (so
the same provider/credential resolution as status checks, and the same "only a
known provider API" limit), and `pollOutcome` (`src/lib/git-ref.ts`) decides: no
`gitLastSeenCommit` yet records a baseline without deploying, a different head
enqueues a `push` deploy. A verified push delivery also writes
`gitLastSeenCommit`, which is what stops a poll right after a webhook deploy
from deploying the same commit twice. Services are polled one at a time to stay
under per-token rate limits.

### Reconnect on refusal (`GitProviderRefusedError`, `service.gitWebhookReconnect`)

`GitProviderService.#api` throws `GitProviderRefusedError` on a 401/403.
`GitWebhookService.#register` returns `{error, reconnect}`: reconnect is true
for that error and for an owner with no connection, and lands in
`gitWebhookReconnect`. `describe()` turns it into
`reconnect: {providerId, providerName}`, and the Source section links to
`/api/v1/git-providers/<id>/connect?returnTo=/services/<id>/environments/source`.
The connect route stores a `safeRedirectTarget` of `returnTo` in the short-lived
`GIT_CONNECT_RETURN_COOKIE` (the OAuth redirect URI has to stay exact, so it
can't carry the path), the callback redirects there and calls
`GitWebhookService.retryAfterReconnect(userId, providerId)`, which re-syncs
every service of that user on that provider still missing a hook. No scopes are
read off the token: a refusal is the only signal every provider gives the same
way.

## Pull request previews (`service.previewsEnabled`, `preview*` columns, `PreviewService`)

A preview is a plain `service` row with `previewParentId` (FK to the parent,
cascade), `previewPrNumber` (unique per parent), `previewPrTitle` and
`previewBranch`. `wantsWebhook` in `git-webhook.service.ts` is deploy-on-push
**or** previews, never on a preview itself; toggling previews counts as "moved"
in `sync` (the snapshot's optional `previewsEnabled`), so the hook is deleted
and re-created with PR events (`createWebhookRequest`'s `pullRequests`: GitHub
and Gitea `pull_request`, GitLab `merge_requests_events`, Bitbucket
`pullrequest:*`).

`handleDelivery` tries `parsePullRequestEvent` first (`src/lib/git-webhooks.ts`,
unit-tested per provider): GitHub/Gitea `opened|reopened|synchronize(d)|closed`,
GitLab `open|reopen|update|close|merge`, Bitbucket
`created|updated|fulfilled| rejected`. `PreviewService.handle` creates the row
at `previewSlug(parent, n)` (cut to a 63-char label) copying the parent's
build/runtime/auth settings, refreshes them on every update, and enqueues a
`push` deploy as the parent's owner. The ref is the head SHA when the provider
sent a full one, else the branch (Bitbucket's hash is abbreviated).
`PullRequestEvent.fromFork` is true unless head and base repo are both present
and equal (GitHub/Gitea `head.repo.full_name` vs `base.repo.full_name`, not
`head.repo.fork`, which is also true for a same-repo PR inside a forked repo;
GitLab `source_project_id` vs `target_project_id`; Bitbucket `source.repository`
vs `destination.repository`), and `handle` ignores fork events before anything
else, close included: a fork PR's code would run with the parent's env vars. An
`update` whose ref didn't change is ignored. `createPushWebhook` adopts a
GitHub/Gitea hook that already delivers to the same URL when the create answers
"already exists" (a re-linked provider, a deleted app): `#adoptWebhook` lists
the repo's hooks, PATCHes the match's config and events and returns its id.
`GitWebhookService.deployOpenPullRequests` (Environments & Deployments →
Previews' **Deploy open pull requests**, `?/deployOpen`) lists the repo's open
pull requests through `GitProviderService.listOpenPullRequests`
(`openPullRequestsPath` and `parseOpenPullRequests` in `git-webhooks.ts`, same
fork rule) and replays each through `handle` as an `update`, so it's idempotent:
an existing preview on the same head is skipped. `GitHubReportService`
(`github-report.service.ts`) reports previews to GitHub when the parent's
`previewReportGithub` is on and its provider is GitHub: `DeploymentService`
calls `deployed` from both deploy outcomes (`#notifySuccess`, `#recordFailure`),
`PreviewService` calls `closed` from `#remove` and `removeAll`, both
fire-and-forget, through `GitProviderService.api`. The comment is found again by
`PREVIEW_COMMENT_MARKER` (no stored comment id); the GitHub environment is the
preview's slug, `transient_environment` with `required_contexts: []` so pending
checks don't refuse the deployment. `enabledGitProvider` lives in
`git-provider.service.ts` so this service can use it without importing
`git-webhook.service.ts`, which would cycle through `preview.service.ts` and
`deploy.service.ts`. `close` deletes it through
`ServiceLifecycleService.deleteService`, which also deletes every preview first
when the parent is deleted; turning previews off calls `removeAll`. Volumes,
domains, cron, status checks and host networking are deliberately not copied.
They live on the service's own Previews section
(`services/[serviceId]/environments/previews/`, shown for any service that isn't
a preview itself), which owns the `previewsEnabled` toggle (and its
`GitWebhookService.sync`/`removeAll`). `previewDomainTemplate` (`{pr}`,
`{branch}` via `branchLabel`, `{slug}`, rendered by `renderPreviewDomain` in
`src/lib/service-domains.ts`, validated by `previewDomainTemplateProblem`) and
`previewDefaultDomain` pick a new preview's
`domains`/`defaultDomainEnabled`/`primaryDomain` in `#create`; a templated
domain another service already routes is skipped and the default hostname forced
on. `#refresh` never touches domains; `applyDomains` re-applies them to every
open preview (DNS synced, deployed ones redeployed) when the tab saves a changed
template or default-hostname flag, overwriting hand-added domains.
`redeploy`/`delete` check `previewParentId` before acting. Previews are never
list rows: `ServiceDTO.#listFilters` always adds `previewParentId IS NULL` and
matches a parent when a preview (aliased `service` as `preview`) matches the
search; the services list attaches each page's previews via
`ServiceGitDTO.listPreviewsOf`, and the stack page and the services dependency
tree keep previews out of `graph.services`/`tree.services` and ship them as
`previews` (`toPreviewRow`, grouped by `previewsByParent` in
`src/lib/service-graph.ts`), drawn by `preview-rows.svelte` under the parent's
row (EntityList `details`) or tree node (`ServiceTree`'s `previews` prop). Icon
and category are mirrored from the parent. The finders live in `ServiceGitDTO`
(`src/lib/dto/service-git-dto.ts`), which extends `ServiceDTO` only to reach its
protected constructor, to keep `service-dto.ts` under the file length limit.
**Not verified against real providers**, same caveat as push-to-deploy.

The branch filter is `previewBranchInclude`/`previewBranchExclude` (jsonb glob
lists, `src/lib/preview-branches.ts`'s `previewBranchAllowed`, reusing
`matchesTagPattern`): exclusions win, an empty include list lets everything
through, and an event with no branch only passes when both lists are empty.
`handle` checks it after the fork check and the close branch, and a filtered
event deletes an existing preview for that pull request (`#remove`), so an
update after the filter changed cleans up. `applyBranchFilter` does the same for
every open preview when the Previews section or `PATCH /api/v1/services/:id`
changes the lists.

Env: `previewEnv` starts from the parent's env with its hostnames rewritten
(unless `previewInheritEnv` is off, then empty) and lays `previewEnvOverrides`
on top, `renderEnvOverride` filling `{pr}`, `{branch}` and `{slug}`; both
`#create` and `#refresh` go through it. Volumes: `previewCopyVolumes` makes
`#create` add, for each parent mount, a `storage_volume` with `previewServiceId`
(cascade, so the row goes with the preview) and `seedFrom` = the parent volume's
source, plus a mount at the same path. The copy happens in the deploy job, not
the webhook request (GitHub gives up after 10 seconds): `deployWorkerSpec`'s
`seeds` lists every mount with a `seedFrom`, and the Go deploy's `seedVolumes`
copies (`dockerapi.CopyVolume`, `cp -a` in a helper) into each target that
doesn't exist yet, removing a half copied one on failure so the next deploy
retries. Existing previews never get copies.
`ServiceLifecycleService.deleteService` removes a preview's copied Docker
volumes (`#removePreviewVolumes`, best effort) before the row goes.
`tests/integration/volume-seed.test.ts` covers the seed end to end.

Image-based previews: an image service has no webhook, so CI creates them
through `PUT /api/v1/services/:id/previews/:pr` (`homerun previews deploy`),
which lands in `PreviewService.deployImage`. It shares `#create`/`#refresh` with
`handle` through a `PreviewRequest` whose `source` is either
`{kind: "git", gitRef}` or `{kind: "image", tag, commit}`; `sourceColumns` sets
`buildSource`/`gitRef` or `buildSource`/`image`/`tag`, and `#refresh`'s
skip-if-unchanged only applies to a git `update` event (a CI call always
redeploys). The branch filter runs only when CI sends a branch, removing an
existing preview of a filtered branch like `handle` does; there's no fork check
(CI's job) and no close event (CI calls `DELETE`, nothing sweeps a forgotten
one). `wait --commit` needs a commit on an image deploy, so `enqueueDeploy`
takes `gitCommit` (written on the deployment row up front, and moved onto the
coalesced deployment when the job coalesces), and `#recordedCommit` carries the
latest deployment's commit into any other deploy of an image-based preview (hand
redeploy, domain or login wall re-apply), so its revisions keep matching. The
Previews section and the Environments page show previews for every non-preview
service; only **Deploy open pull requests** stays git-only. The Source tab no
longer forces `previewsEnabled` off for an image service; instead any change of
`buildSource` (Source tab or `ServiceSettingsService#resync`) deletes every
existing preview, since they ran the old source.

## Release channels (`service.channels*` columns, `channelCanary`, `ReleaseChannelService`, `src/lib/release-channels.ts`)

Opt-in per git service (`channelsEnabled`, off by default): the service itself
is **stable**, deployed from pushed tags matching `channelTagPattern` (glob,
`matchesTagPattern`: `*` any run incl. `/`, `?` one char, no classes), and
Homerun manages a **canary** child fed by `channelBranch`. The canary is a
`service` row with `previewParentId` = parent **and** `channelCanary = true`,
reusing the preview parent FK on purpose so it nests everywhere previews do
(`listPreviewsOf`, `ServiceDTO.#listFilters`, stack page, services tree,
`preview-rows.svelte` draws it as "Canary"). Everything preview-specific
excludes it: `ServiceGitDTO.listPreviews` filters `channelCanary = false` (so
`PreviewService.removeAll`/`list`/`applyDomains` never touch it) and
`PreviewService.#own` refuses it; `ServiceLifecycleService.deleteService` uses
`listChildren` (previews + canary). Slug `canarySlug` (`<slug>-canary`, 63-char
cut); settings from `PreviewService`'s exported `mirroredSettings`, re-applied
with `gitRef = channelBranch` and the domains (`channelCanaryDomain`, else only
the default hostname) on every canary deploy; DNS re-synced only when its
hostnames changed.

`ReleaseChannelService.configure` validates (`#resolveSettings`: git, not a
child, pattern, domain shape and not routed elsewhere), saves, deletes the
canary when turned off, else deploys it when new, just enabled, or its branch or
domain changed. It doesn't call `GitWebhookService.sync` (import cycle:
`git-webhook.service` imports it for routing), so both callers (the Environments
& Deployments → Channels action and `PATCH /api/v1/services/:id/channels`) sync
afterwards with `channelsEnabled` in the snapshot, which counts as "moved" and
re-registers the hook; `createWebhookRequest`'s `tags` sets GitLab's
`tag_push_events` (GitHub, Gitea and Bitbucket already deliver tags as pushes;
GitHub/Gitea `create` events are parsed too but not subscribed, to avoid a
double delivery). `wantsWebhook` includes `channelsEnabled`.

`handleDelivery`, after the PR branch, hands a channels service to
`#routeChannels`: `parseTagPushEvent` (GitHub/Gitea `refs/tags/` push or
`create` with `ref_type: tag`, GitLab `Tag Push Hook`, Bitbucket `repo:push`
change `type: tag`, deletions ignored) matching the pattern → `deployStable`
(writes the tag as the parent's `gitRef`, so manual redeploys rebuild it); a
push to `channelBranch` → `deployCanary` (records `gitLastSeenCommit` on the
canary); anything else ignored, `autoDeployOnPush` irrelevant. Polling:
`listPushPollable` skips channel parents and includes canary rows (created with
`autoDeployOnPush: true`, never a webhook of their own, so always polled; the
webhook's `gitLastSeenCommit` keeps a poll from redeploying), and
`GitPollScheduler.#deploy` routes a canary through its parent's `deployCanary`
to refresh the mirror. Tags aren't polled.
`tests/unit/app/git-poll-scheduler.test.ts` covers the query filter (rendered
SQL) and the canary routing.

`configure` snapshots the parent row with a spread before saving: `toJSON()`
returns the live row that `update()` mutates, and comparing against it made a
canary domain change never redeploy the canary. A canary domain equal to one of
the stable service's own hostnames (its default one included, which
`domainTaken` doesn't see) is refused.

**Deployment environment**: `deployment.environment` (text, default
`production`, free-form on purpose), written by both `DeploymentDTO.create` call
sites from `deployEnvironment(svc)`: `canary` for `channelCanary`, `preview` for
any other child, else the service's own `service.environmentName` (nullable, set
on the Settings tab, `PATCH /services/:id`, `homerun services environment`),
else `production`. A custom name never overrides `canary`/`preview`; those two
are reserved and `production` is stored as null (`environmentNameProblem`,
`normalizeEnvironmentName`, `environmentNameField` in `validation/service.ts`).
`/deployments`' Environment filter is the built-in three plus every other name
`DeploymentDTO.listEnvironments` finds recorded (`deploymentEnvironments`);
`get_service_config` reports the effective one as `settings.environment`. The
migration backfills `preview` for existing preview rows. Shown by
`environment-badge.svelte` on Environments & Deployments → Revisions and
`/deployments` (filter key `environment`), exposed as `environment` on the REST
deployment/revision shapes (so the MCP tools get it). `POST /deploy` and the MCP
`deploy_service` take `environment: canary|stable`. CLI:
`services channels enable|disable|status`, `services deploy --environment`,
`deploy` as an alias of `services deploy`. **Not verified against real
providers**: webhook routing is unit-tested only.

## Migrating from Dokploy or Coolify (`settings/migrate/`)

Admin-only tab under `/settings`: `settings/migrate/+page.svelte` picks the
source, `settings/migrate/dokploy/` and `settings/migrate/coolify/` are one
route each, both rendering `src/lib/components/migrate-panel.svelte` with
actions from `migrationActions(source)` (`src/lib/server/migrate-actions.ts`).
One form carries URL + token; `?/preview` reads and returns a secret-free
`MigrationPreview`, the "Import" button posts the same form to `?/import`
(`formaction`) with the ticked ids as repeated `ids` fields. **The import
re-reads the source for just those ids** rather than trusting a plan JSON sent
back from the browser, so env values and passwords never reach the client and
the token is never stored.

Layering: `src/lib/migrate/common.ts` (types, `MigrationHttpClient`, env/compose
helpers, `previewEntries`), `src/lib/migrate/dokploy.ts` and
`src/lib/migrate/coolify.ts` (pure raw-JSON → `MigrationEntry` mappers, no DB),
`DokployService`/`CoolifyService` (the HTTP walk) and `MigrationService`
(`src/lib/services/migration.service.ts`, preview slug check + import). Every
entry is expressed as `ComposeServiceDraft[]` and imported through
`ComposeImportService.importPlan`, one call per entry, into a stack matched or
created by the source project's name, so volumes, slug uniqueness and
notifications are the compose importer's, not a second copy.

**Dokploy, verified against a live instance (Dokploy with environments):**

- `GET /api/project.all` with `x-api-key` answers a **bare array**, no
  `result.data` wrapper. The resources are **not** on the project: they're under
  `project.environments[]` (`applications`, `compose`, `postgres`, `mysql`,
  `mariadb`, `mongo`, `redis`, `libsql`), and each is only a summary
  (`applicationId`/`name`/`applicationStatus`, a database is just
  `{ postgresId }`). The previous client read `project.applications`, found
  nothing, and rendered an empty dry run with a disabled Import button, which is
  the "does absolutely nothing" bug. `dokployRefs` still falls back to a flat
  project for older versions.
- The detail comes from `GET /api/<type>.one?<type>Id=` (`application.one`,
  `compose.one`, `postgres.one`, ...), fetched 6 at a time.
- Application: `sourceType` is `docker` (`dockerImage`, `username`/`registryUrl`
  for a private registry) or `github`/`gitlab`/`gitea`/`bitbucket`/`git`, with
  per-provider fields (`owner`/`repository`/`branch`/`buildPath` for GitHub,
  `giteaOwner`/`giteaRepository`/`giteaBranch`/`giteaBuildPath` plus the host in
  the nested `gitea.giteaUrl`, `customGitUrl`/`customGitBranch` for plain git).
  `buildType` is `dockerfile`/`nixpacks`/`railpack`/`heroku_buildpacks`/
  `paketo_buildpacks`/`static`: all but `static` import, mapped onto
  `gitBuildMethod` (`dockerfile` keeps `dockerfile`/`dockerContextPath`, the
  builders use `buildPath` as the context; a `herokuVersion` other than 24
  warns). `env` is a `.env` blob or `null`. There's no port field: the port is
  `domains[].port` (`ports[]` is published ports). `mounts[]` is
  `{ type: "volume"|"bind"|"file", volumeName, hostPath, mountPath }`, and a
  read-only bind carries `:ro` inside `mountPath`. `memoryLimit`/`cpuLimit` are
  strings or null.
- Compose: `composeFile` holds the YAML only for `sourceType: "raw"`;
  `domains[].serviceName` names the compose service a domain routes to, used to
  mark it public with that port. `env` is used for `${VAR}` substitution.
  Dokploy runs stacks as `docker compose -p <appName>`, so a named volume on
  disk is `<appName>_<key>` : `dokployComposeVolume` rewrites each draft's
  volume source to that, unless the top-level declaration has `name:` (used
  as-is) or `external` (left plain). Checked against the live instance: every
  stack had `randomize: false` and `isolatedDeployment: false`, which Dokploy
  uses to suffix names further; those aren't handled.
- Databases: `dockerImage`, `databaseName`/`databaseUser`/`databasePassword`/
  `databaseRootPassword`, `externalPort`, and `mounts[]` including the
  auto-created data volume. The Redis password is applied by Dokploy through the
  start command, so it's reproduced as entrypoint `/bin/sh`, command
  `-c "exec redis-server --requirepass '<pw>'"`.
- Runtime carry-over lives in `src/lib/migrate/dokploy-runtime.ts`: `username`/
  `password`/`registryUrl` → draft `registry`; `command` (string) → `/bin/sh -c`
  and `args[]` replacing the arguments (`dokployStartCommand`, mirroring how
  Dokploy sets `Command`/`Args` on its swarm service, from memory of Dokploy's
  source, not re-verified live); `mounts[]` `type: "file"` with `content` →
  draft `files`; a compose stack's `../files/<filePath>` short-syntax binds are
  matched to the stack's file mounts by `filePath` and their relative-bind
  warnings dropped.

**Coolify is not verified against a live instance.** Built from the documented
v4 API: `Authorization: Bearer`, `GET /api/v1/projects` (+
`/api/v1/projects/{uuid}` for `environments[].id`, which maps an app's
`environment_id` to its project name), `/api/v1/applications`,
`/api/v1/services`, `/api/v1/databases`, and
`/api/v1/{applications,services}/ {uuid}/envs` for env (non-preview rows,
`real_value` over `value`). Application `build_pack` drives the mapping:
`dockerimage` (`docker_registry_image_name`/`_tag`), `dockerfile` with
`git_repository` (`base_directory`, `dockerfile_location`, a bare `owner/repo`
is assumed to be GitHub), `nixpacks`/`railpack` the same way with that
`gitBuildMethod` (custom `install_command`/`build_command` warn),
`dockercompose` (`docker_compose_raw`); everything else (`static`) is blocked.
Ports come from `ports_exposes`, public from `fqdn`. Services are compose
(`docker_compose_raw`, env substituted so `SERVICE_FQDN_*` resolve). Databases
map `database_type` + `postgres_*`/`mysql_*`/`mariadb_*`/`mongo_initdb_*`
fields. The parsing accepts a bare array or a `data` wrapper. Persistent storage
is tried from `/api/v1/{applications,databases}/{uuid}/storages`, falling back
to `persistent_storages`/`file_storages` on the row itself (`coolifyStorages` in
`src/lib/migrate/coolify-runtime.ts`: `LocalPersistentVolume` → named volume or
`host_path` bind, `LocalFileVolume` → file draft or directory bind), and warns
when neither says anything. `custom_docker_run_options` is parsed by
`parseDockerRunOptions` (`--cap-add`, `--device`, `--privileged`, `--label`/
`-l`, `--entrypoint`, `--user`/`-u`, others warned), `start_command` becomes an
`sh -c` command, and a Redis/KeyDB/Dragonfly password becomes a `--requirepass`
command. First real Coolify migration is the real test.
