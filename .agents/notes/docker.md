# Docker integration

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Docker integration (`src/lib/services/docker.service.ts`, `src/lib/services/docker/`)

**The app holds no Docker socket at all.** Every engine call goes over HTTP to
the Go worker's Docker control API (`internal/workerapi`, served alongside the
job loop by `cmd/worker`, see `worker.md`), which is the process that actually
holds `/var/run/docker.sock`. `DockerService` (`docker.service.ts`) is a
singleton instance (`export const DockerService = new DockerServiceClass()`) of
a class built from real per-concern classes merged via the TS mixin pattern,
**not** a static barrel re-exporting loose functions (see the OOP convention
note above; this module is its reference implementation). Every route/DTO
imports `DockerService` from there and calls instance methods on it
(`DockerService.pullImage(...)`), never reaching into `services/docker/*`
directly, that part of the contract is unchanged from before the mixin refactor,
and unchanged again by the move off dockerode : a mixin's public surface is
identical, only what runs underneath a method changed, from a dockerode call to
`this.worker.get/post/delete/stream(...)`. Each concern file under
`services/docker/` exports a `SomethingMixin(Base)` function returning a class
that extends `Base` (ultimately `BaseDockerService`, `docker/base.ts`, holds the
shared `worker` getter onto `WorkerClient`, `src/lib/server/worker-client.ts`);
`docker.service.ts` chains all of them and instantiates once. A concern that
calls another's method does it via real inheritance (`this.inspectStatus(...)`),
which is also why the chain has a load-bearing order: containers before one-off
(`runOneOff` calls `this.pullImage`), containers and swarm before reconcile
(`syncServiceStatus` calls
`this.inspectStatus`/`this.inspectSwarmServiceStatus`), see the ordering comment
in `docker.service.ts` before reordering the chain. Creating and health-gating
the container/swarm-service itself for a real deploy no longer goes through this
mixin chain at all, that now runs in the Go worker, see the `containers.ts`
bullet below.

`WorkerClient` (`src/lib/server/worker-client.ts`) is the whole of that HTTP
client: thin `get`/`post`/`delete`/`putRaw`/`postRaw`/`stream` methods against
`config.worker.url` (env `WORKER_URL`, default `http://localhost:7430`),
authenticated with a bearer token both sides read from `WORKER_TOKEN` — or, when
that's unset, both independently derive from `AUTH_SECRET` (`config.ts`'s
`deriveWorkerToken`/Go's `httpapi.DeriveToken`, same HMAC-SHA256 over the
literal `"homerun-worker-control"`), so an app and a worker started with nothing
but a shared `AUTH_SECRET` already agree on a token with no file or extra env
var to pass between them. A non-2xx answer throws `WorkerRequestError` (status +
the worker's own `{error}` message, `isNotFound()` for a 404); a worker that
can't be reached at all throws a distinct "Couldn't reach the Homerun worker"
error rather than a bare `fetch failed`, since that's a different failure with a
different fix. `stream()` has no timeout (a followed log, the terminal, a pull's
progress are meant to stay open, the caller's `AbortSignal` is what ends them);
every other call gets a generous 60s timeout, since some of these are genuinely
slow against the daemon rather than broken (`docker stop`'s SIGTERM grace
period, a Traefik recreate doing stop+remove+create in one request).
`AdminService`'s setup diagnostics check the worker and the daemon it fronts as
two separate checks (`GET /v1/health` then `GET /v1/info`) precisely because
they now fail for different reasons with different fixes, see
`observability.md`.

- `client.ts`, no longer a dockerode singleton, now just the
  `RemoteHostConnection` interface : the shape a `remote_host` row stores and
  the Go worker's own `dockerapi.RemoteHost` expects. A remote build server's
  actual Docker connection (`tcp://`, optionally TLS) is opened in Go
  (`internal/dockerapi.NewRemote`, from `internal/jobs/deploy/build.go`), not by
  this app; see Build servers below.
- `labels.ts`, pure label-building (no Docker client, no state), stays a plain
  exported function rather than a mixin: every container gets
  `homerun.managed=true` + `homerun.service.id=<id>`, plus Traefik discovery
  labels (unless `dnsResolvable` is false, then only the two managed labels, no
  `traefik.*` at all, so it never gets a router). Any code enumerating this
  app's own containers **must** filter on `homerun.managed=true` (the old
  blanket `listManagedContainers()` helper is gone, nothing lists
  indiscriminately anymore : status/lifecycle is always by a stored
  `containerId`/`swarmServiceId`, Docker Cleanup's host-wide listing is the one
  deliberate exception, see below), this app must never touch a container it
  didn't create. The public subdomain is `<slug>.<baseDomain>`
  (`defaultHostname`, `src/lib/service-domains.ts`); `slug` itself is
  stack-scoped at creation time (`src/lib/slug.ts`'s `stackScopedSlug`: prefixed
  with the stack's own slug unless it already is one, so a stack's slug is never
  doubled into the hostname), not re-prefixed again here — see Stack-scoped
  slugs in `services-and-templates.md`. `serviceHostnames()`
  (`src/lib/service-domains.ts`) resolves the full hostname list — the default
  hostname first when `defaultDomainEnabled`, then each of `domains` — and one
  Traefik router is added per hostname (router name `<slug>` for the first,
  `<slug>-<n>` after it), all pointing at the _same_
  `traefik.http.services.<slug>` backend, one loadbalancer config, N hostnames
  reaching it, not a duplicated service block. When `authRequired` is set, a
  forwardAuth middleware is attached to every router for the service, pointing
  at `authCheckUrlFor(serviceId)` — `config.authCheckUrl` with a `?service=<id>`
  query param, so the gate identifies the service from the URL rather than
  having to resolve `X-Forwarded-Host` back to a slug or domain — plus
  `authResponseHeaders` for `GATE_IDENTITY_HEADERS`. Because these are labels,
  turning the wall on or off only takes effect on the next deploy.
- `networks.ts`, `DockerNetworkMixin`, per-stack Docker networks.
  `stackNetworkName(stackId)` is deterministic (`homerun-stack-<id>`, no
  separate id stored, stays a plain exported pure function).
  `ensureStackNetwork`/`removeStackNetwork` (idempotent create/remove over the
  worker's `POST`/`DELETE /v1/networks`, called from
  `StackDTO.create`/`cascadeDelete`) →
  `DockerService.ensureStackNetwork`/`removeStackNetwork`. A container actually
  joining its stack's network under a DNS alias equal to the service's slug
  (sibling services address each other by that plain slug; whether it happens to
  carry the stack as a prefix depends only on whether `slug` itself does, see
  Stack-scoped slugs in `services-and-templates.md` — the network alias itself
  never adds one) is `joinStackNetwork` in the Go worker now, not a TS mixin
  method at all, same re-assert-on-every-deploy shape as the Go worker's own
  `ensureBridge()` call for a container deploy
  (`internal/jobs/deploy/container.go`, formerly `createAndStartContainer`'s own
  `ensureSharedNetwork()` call, see below): a network a prune or a Docker
  Cleanup run removed out from under a still-live stack row gets recreated,
  rather than failing every subsequent deploy with a raw 404 from the Engine.
- `core-services.ts`, `DockerCoreServicesMixin`, the Traefik container itself :
  `findTraefikContainer`/`restartTraefikContainer`/`updateTraefikContainer`
  (image-only recreate), plus **`applyTraefikFlags(flags)`**, which rewrites
  `--key=value` entries on the _running_ container's command line and recreates
  it from its own inspected config. That one crosses the line
  `updateTraefikContainer` documents ("never invents new command-line flags") on
  purpose: Traefik reads its ACME account, its providers and its entrypoints
  from **static** configuration at process start, so a dashboard field that only
  writes a database row is a field that does nothing. Two callers today:
  `applyAcmeEmail` (Settings → Networking) and `enableSwarmMode`. Both no-op
  when every flag already holds the requested value, so saving an unchanged
  section never bounces the proxy. `applyFlags` itself is a pure exported
  function with its own unit test (`tests/unit/app/traefik-flags.test.ts`) : it
  matches whole keys, so `providers.docker` never clobbers
  `providers.docker.exposedbydefault`, and a null value removes a flag.
- **Switching orchestration mode actually prepares the host.**
  `enableSwarmMode()` runs `docker swarm init` if the daemon isn't a manager,
  ensures an **attachable overlay** network, attaches Traefik to it and turns on
  `--providers.swarm`. The overlay is deliberately a _second_ network,
  `<networkName>-swarm` (`swarmNetworkName()`): swarm services can only join an
  overlay, the shared network already exists as a bridge with the app and
  Traefik attached, and a live bridge network can't be converted in place.
  `buildContainerLabels` therefore takes a `networkName` so a swarm service's
  `traefik.docker.network` points at the overlay. `disableSwarmMode()` removes
  the provider flags and **leaves the swarm running** :
  `docker swarm leave --force` would kill every swarm service on the host,
  including ones this app never created, which is not something a dashboard
  select should do behind your back.
- `containers.ts`, `DockerContainerMixin` (the old `service.ts`, renamed to
  avoid reading as "the Service service" next to `dto/service-dto.ts`), the
  operational surface, merged in right after the network mixin (see the ordering
  note above):
  - `pullImage(image, tag, auth?, onProgress?)` streams `POST v1/images/pull`
    off the worker and calls `onProgress` once per layer _status change_ (not
    per byte-tick, the Engine's raw progress events are far too chatty to log
    one-for-one), used to build the live deploy-progress log. →
    `DockerService.pullImage`.
  - **Creating and starting the container for a real deploy runs in the Go
    worker now, not on this mixin.** `deploy.service.ts`'s
    `DeploymentService.deployService()`/`enqueueDeploy()` (via
    `prepareWorkerDeploy`/`deployWorkerSpec` in `deploy/worker-spec.ts`) hands
    the worker a `containerCreateTemplate()` body (still built in this file,
    pure) plus the readiness/rollout inputs, and
    `internal/jobs/deploy/container.go`'s `startContainer` does the actual
    create+start, `rollout.go`/`readiness.go` the health gate — the direct Go
    port of what used to be `DockerContainerRolloutMixin`
    (`docker/container-rollout.ts`, deleted). Container names still include a
    random suffix (`<namePrefix>-<hex8>`, `randomSuffix` in
    `internal/jobs/deploy/readiness.go`) so a redeploy never collides on "name
    already in use"; the _previous_ containers for a service are still found by
    their `homerun.service.id` label, not by name. **Redeploys are still
    health-gated**: `RolloutStrategy` (`internal/jobs/deploy/rollout.go`, tested
    in `tests/unit/go/internal/jobs/deploy/logic_test.go`, the same pure
    decision `docker/rollout.ts`'s `rolloutStrategy` used to make) picks
    blue-green or recreate — recreate (nothing running, host networking, or a
    writable volume on a service with no Traefik labels, `Routed`; a routed one
    whose blue-green fails is retried once as a recreate, `RetryStopFirst`,
    since an embedded database locking its data dir exits when a second copy
    starts, and swarm's start-first update gets the same stop-first retry)
    removes the previous containers first; blue-green starts the new one
    alongside, `awaitReadyOrDiscard` polls `ReadinessVerdict` every 2s (healthy
    healthcheck, or running 5s with none; failed on exit, any restart,
    disappearance, `unhealthy`, or not ready in 5 minutes), then
    `removePrevious`. On failure it logs the new container's last 20 lines,
    removes it and reports a `rollout-failed` outcome, which
    `deploy.service.ts`'s `workerFailure` turns back into a `RolloutFailedError`
    (`docker/rollout.ts`, which now only keeps the shared
    `ContainerHealthSample`/`containerSampleFromInspect` type and this error
    class — still used by `DockerRevisionMixin.containerHealthSample` and the
    post-deploy health watch) that `#recordFailure` treats like a scan block
    (service not marked failed). What keeps traffic off the new container until
    it's ready is its Docker healthcheck, picked by `planReadiness`
    (`internal/jobs/deploy/readiness.go` now, see "Readiness gate" below). The
    container is aliased as its slug on the shared network so other services can
    reach it at `http://<slug>:<containerPort>` regardless of the randomized
    name; when the service is in a stack, `joinStackNetwork` also joins that
    stack's network under the same alias, best-effort. Volumes still become
    `HostConfig.Binds` (`"source:containerPath[:ro]"`) inside
    `containerCreateTemplate`, before the spec ever reaches the worker.
    `DockerContainerMixin` itself now only keeps `pullImage`,
    `start`/`stop`/`restart`/`removeContainer`, `inspectStatus`, `streamLogs`
    and `buildAuthConfig` — no create/start method, and no dependency on the
    network mixin ahead of it anymore.
  - `start/stop/restartContainer`, `removeContainer`, `inspectStatus` →
    `ContainerStatus`, `containerHealth` → the container's own `State.Health`
    verdict (`null` when the image declares no `HEALTHCHECK`, which is the
    common case; the uptime probe prefers it over any probe of its own, see
    `observability.md`), `streamLogs` (follow-mode web `ReadableStream`),
    `buildAuthConfig`, all exposed the same way, `DockerService.<name>`.
    `ContainerStatus` (`src/lib/types.ts`) has a `"missing"` value alongside
    pending/pulling/starting/running/stopped/failed, for a container Docker
    can't find at all (a 404 on `inspect()`, e.g. removed manually outside the
    app, `docker rm`), distinct from `"failed"` (the container still exists but
    exited non-zero); `inspectStatus` only returns `"missing"` for a real 404,
    any other inspect error still falls back to `"failed"` as before. See
    Observability → Events in `routing.md` for the "Resolve" action
    (`ServiceDTO.resolveOrphan()`) this status backs, and Remote hosts/Homerun
    Agent below, `agent-client.service.ts`'s `inspectStatus` and
    `internal/dockerapi`'s `ErrNotFound` (mapped to a real HTTP 404 by
    `internal/agent/server.go`'s `saveImage`) make the same distinction for an
    agent-backed host. Docker doesn't strip a container's own ANSI color codes
    from its stdout, every raw-log-line surface (the live log viewer, deploy
    progress panel, deployment history, Observability → Events) renders each
    line through `src/lib/components/ansi-line.svelte` (backed by
    `src/lib/ansi.ts`'s `parseAnsiLine()`), which splits a line into styled
    `<span>`s rather than using `{@html}`, no injection surface even though the
    source is a live container's own output.
- `reconcile.ts`, `DockerReconcileMixin`, `syncServiceStatus`: poll-on-page-load
  status reconciliation, merged in after the container and swarm mixins so
  `this.inspectStatus`/`this.inspectSwarmServiceStatus` are available. There is
  intentionally no Docker event subscriber for status itself (yet, see Planned
  features) — distinct from the Go job worker that now executes
  deploys/scans/backups/cron jobs/cleanups, see `worker.md`. →
  `DockerService.syncServiceStatus`; syncing every one of a user's services in
  parallel is now just `Promise.all` at the call site
  (`service-status.remote.ts`'s `syncServiceStatuses`), not a mixin method.
- `core-services.ts`, `DockerCoreServicesMixin`, `findTraefikContainer()`, a
  deliberate narrow exception to the managed-label-only rule: lookup of the
  Traefik container by image-name prefix, which System Logs uses to put
  Restart/Update on Traefik's row of the stack list (its logs stream through the
  same per-container route as every other stack container). →
  `DockerService.findTraefikContainer`/`restartTraefikContainer`/`updateTraefikContainer`.
- `cleanup.ts`, `DockerCleanupMixin`, host-wide (not per-service, deliberately
  the one mixin that isn't scoped to `homerun.managed=true` containers, see
  Docker Cleanup below) `GET /v1/df`-backed preview (`getCleanupPreview()` →
  `CleanupPreview`) plus
  `pruneContainers`/`pruneImages(all?)`/`pruneNetworks`/`pruneBuildCache`/
  `pruneVolumes`/`pruneSystem`, thin wrappers over the worker's own
  `POST /v1/prune/*` routes (`internal/dockerapi/prune.go`). →
  `DockerService.getCleanupPreview`/
  `pruneContainers`/`pruneImages`/`pruneNetworks`/`pruneBuildCache`/
  `pruneVolumes`/`pruneSystem`.
- `one-off.ts`, `DockerOneOffMixin`, `runOneOff(params)`: pull-if-missing,
  create, start, wait, collect stdout/stderr, remove, for the two places that
  need a container as a _tool_ rather than as a service (reading a
  Docker-managed named volume out for a backup, see S3 backups above; running a
  user-defined cron job's image, see Cron jobs below). Needs the container mixin
  ahead of it in the chain (`this.pullImage`). **`Tty` is deliberately false
  here**, unlike a deployed service's own container (`containerCreateTemplate`'s
  `Tty: true`), so Docker's own stream framing keeps stdout and stderr apart : a
  caller reading a binary tarball off stdout must not get stderr interleaved
  into it, which is exactly what a TTY container would do. `timeoutMs` kills the
  container rather than leaving it running, and the result carries `timedOut` so
  the caller can say so; the container is removed in a `finally` either way. The
  attached socket is `destroy()`ed explicitly once the run finishes : without
  that it stays open and keeps Bun's event loop alive, leaking one connection
  per run in a long-lived server. → `DockerService.runOneOff`.
- `image-scan.ts`, `DockerImageScanMixin`, merged outermost (after cleanup,
  needs `runOneOff`/`pullImage`/`ensureSharedNetwork`), now just the mirror
  registry's own container lifecycle and the Registry page's API access:
  `ensureImageMirror()` lazily creates `homerun-mirror` (`registry:2`,
  `homerun-mirror-data` volume, shared network, `127.0.0.1:5055->5000`,
  `unless-stopped`, labelled `homerun.infra=mirror` and **not**
  `homerun.managed`, so nothing that lists managed containers ever treats it as
  a service), same core-infra exception as Traefik, plus
  `reconcileRegistry`/`registryInternalAuth`/`imageMirrorClient`/
  `execInImageMirror`/`imageMirrorUsageBytes`/`isRootlessDocker` for the
  Registry page and Docker Cleanup's mirror GC (see below). **The actual
  copy-into-mirror, Trivy scan and pull/load-back for a deploy run in the Go
  worker now**: `deploy.service.ts`'s `deployWorkerSpec`
  (`deploy/worker-spec.ts`'s `mirrorSpec`) hands the worker the skopeo
  copy/archive commands and the mirror's refs/credentials, and
  `internal/jobs/deploy/scan.go`'s `deployThroughMirror`/`fetchFromMirror`/
  `loadFromMirror` do the copy, scan and pull/load back, in that order (the Scan
  now job and Docker Cleanup's own scans go through `internal/jobs/imagescan`'s
  `Scan` instead, same Trivy command). The old `copyToMirror`'s
  `quay.io/skopeo/stable` command
  (`skopeo copy --quiet --dest-tls-verify=false --digestfile /dev/stdout`,
  credentials as an auth file from an env var so they never appear in argv) and
  `loadFromMirror`'s skopeo-archive-into-`docker.loadImage` shape are unchanged,
  just built as a spec on the TS side (`docker/image-scan-refs.ts`'s
  `skopeoCopyCommand`/`skopeoArchiveCommand`, still pure and tested in
  `tests/unit/app/image-scan.test.ts`) and run by Go. `scanImage`'s old
  `aquasec/trivy` command (pinned tag) with the `homerun-trivy-cache` volume on
  `/root/.cache`, JSON output parsed by `summarizeTrivyReport`, is now
  `internal/jobs/imagescan/scan.go`'s `Scan` and `imagescan.Summarize` (the Go
  port of `src/lib/image-scan.ts`'s old `summarizeTrivyReport`, which was
  deleted from the app). **Real, tested findings** (still true, now exercised
  from the worker): Docker accepts a loopback registry as insecure with no
  daemon config (verified on OrbStack); skopeo copies only the host platform's
  manifest, so the recorded digest is the platform manifest digest, not the
  upstream index digest; `--digestfile /dev/stdout` works and `--quiet` keeps
  progress off stdout. **Rootless Docker**: `isRootlessDocker()` (`docker info`
  security options, pure `isRootlessDaemon`) tells the spec to skip the loopback
  pull, whose daemon lives in RootlessKit's network namespace and can't reach
  `127.0.0.1:5055`, so the worker loads instead. `fetchFromMirror`'s order:
  loopback pull (rootful only) → mirror load → upstream pull. A loaded image has
  no `RepoDigests`, so the recorded digest is the mirror copy's. Not verified
  live on a rootless host.
- Docker Cleanup runs in the Go worker (`internal/jobs/cleanup`, prunes via
  `internal/dockerapi/prune.go`): `worker-jobs/docker_cleanup.ts`'s `prepare`
  resolves the retention lists (retained revision image ids, mounted volume
  names, live stack ids, the mirror spec from `ImageMirrorGcService.spec()`), Go
  prunes and returns the same `PruneSummary`/`SystemPruneSummary`/
  `MirrorGcResult` shapes. The mirror GC's plan, registry calls and
  `docker exec`s live in Go (`internal/registryapi`, `PlanGC` is the port of
  `planMirrorGc`); the Registry page's "Collect garbage" goes through the same
  queued `pruneMirror` job. The TS descriptions below are the reference
  behaviour the Go code mirrors.
- Mirror GC: `ImageMirrorGcService`
  (`src/lib/services/image-mirror-gc.service.ts`) runs as the `pruneMirror`
  Docker Cleanup action (exclusive `docker_cleanup` job, button + size panel on
  `/docker-cleanup` via `getMirrorUsage`), queued daily at 04:00 by
  `cron/mirror-gc-scheduler.ts` under the first admin's id (postponed while
  deploy/image_scan jobs are queued or running). Keep set is pure in
  `docker/mirror-registry.ts` (`mirrorKeepSet`, from `listMirrorReferences` in
  `src/lib/dto/mirror-reference-dto.ts`): per service the current `image:tag`,
  the digest of every **retained revision**
  (`DeploymentDTO.listRetainedRevisions`, the newest
  `instance_settings.retainedImagesPerService` (null = `RETAINED_REVISIONS`, 5;
  1 to 50 on Settings → Docker) distinct images per service,
  `src/lib/revisions.ts`), and the last `MIRROR_GC_SCANS_PER_SERVICE` (2)
  distinct mirror-scan digests (`planMirrorGc`, which diffs this keep set
  against the registry's actual inventory, is now `internal/registryapi.PlanGC`
  in Go, see above; `MirrorRegistryClient` there does catalog (Link paging) →
  tags → HEAD with an index/list-aware Accept → DELETE by digest, fetch injected
  so `tests/unit/app/image-mirror-gc.test.ts` mocks the TS `mirrorKeepSet`
  half). Reaching the API at `127.0.0.1:5055` or `homerun-mirror:5000` (first
  that answers `/v2/`, container name first when this app runs in one) and
  `docker exec`ing `du`, `registry garbage-collect --delete-untagged`, `rm -rf`
  of emptied repo dirs is Go's job too now (`internal/jobs/cleanup/mirror.go`).
  **Real, tested findings**: `--delete-untagged` sweeps every manifest with no
  tag, so a kept older digest must be re-tagged first (`homerun-keep-<digest>`,
  a GET + PUT of the same manifest bytes/content type) or the rollback copy
  vanishes; deleting a manifest by digest drops every tag pointing at it; the
  registry needs a restart after GC or its `blobdescriptor: inmemory` cache can
  claim deleted blobs still exist; a collected image re-copies fine after the
  restart. `ensureImageMirror` recreates a `homerun-mirror` lacking
  `REGISTRY_STORAGE_DELETE_ENABLED=true` (volume persists). An in-process flag
  (`ImageMirrorGcService.running`, on `globalThis`) is read into the deploy spec
  as `mirror.cleaningUp` (`worker-spec.ts`'s `mirrorSpec`), so
  `internal/jobs/deploy/scan.go`'s `deployThroughMirror` falls back to a direct
  pull while GC runs; the handler also refuses to start while a
  deploy/image_scan job is running.
- Registry (`/registry`, admin-only, sidebar under Administration): turns
  `homerun-mirror` into a real push/pull registry rather than just a scan cache.
  `RegistryService` (`src/lib/services/registry.service.ts`) owns
  `status()`/`authEnabled()`/`internalCredentials()`/`createToken()`/
  `revokeToken()`/`setAuthEnabled()`/`setPublicHost()`/`syncAuth()`/`catalogPage()`/`repository()`/
  `deleteTag()`/`deleteRepository()`. Tokens are `registry_token` rows
  (`RegistryTokenDTO`, `src/lib/dto/registry-token-dto.ts`): `username` plus a
  bcrypt `secretHash` (`Bun.password.hash`, cost 10), the plaintext returned
  only once from `createToken`. `syncAuth()` rewrites the htpasswd file
  (`writeRegistryHtpasswd`, a one-off `alpine` container writing into the
  `homerun-registry-auth` volume, since the app can't reach into another
  container's volume directly) from every token plus a reserved
  `homerun-internal` token (`REGISTRY_INTERNAL_USERNAME`, minted the moment auth
  turns on and stored as `instance_settings.registryInternalSecretEnc`, same
  AES-256-GCM scheme as `registryPasswordEnc`), then calls `reconcileRegistry`,
  which diffs the container's env/labels against a `RegistryDesiredState`
  (`docker/registry-container.ts`'s pure
  `registryEnv`/`registryLabels`/`registryMatches`) and only recreates the
  container, never the `homerun-mirror-data` volume, when they've actually
  changed. `instance_settings.registryAuthEnabled`/`registryPublicHost` back the
  Settings tab's toggle and Traefik hostname (router `homerun-registry`, no
  buffering middleware since `docker push` streams whole layers);
  `setAuthEnabled`/`setPublicHost` enforce the safety rule both ways, in the
  service and not just the UI: auth can't turn off while `registryPublicHost` is
  set, and a host can't be set while auth is off, so a registry reachable from
  the internet always requires a token. Once auth is on,
  `DockerImageScanMixin.registryInternalAuth()` (reads the same secret) is
  threaded through every internal caller so none of them changed shape:
  `copyToMirror`'s skopeo auth file gets a second entry via the renamed
  `registryAuthFileFor` (now a list, `skopeoCopyCommand` gained a `destAuth`
  flag), `pullFromMirror`'s daemon pull passes an authconfig, and `scanImage`
  swaps in the same credentials whenever `params.ref` is `isMirrorRef`. The
  Images tab's delete/garbage-collect actions go through the same
  `MirrorRegistryClient`/`ImageMirrorGcService` as Docker Cleanup's "prune
  mirror" above, same keep-set rules; a registry delete is by manifest digest,
  so deleting one tag drops every other tag pointing at the same digest.
  **Verified live**: a real `registry:2` with a Bun bcrypt htpasswd rejected an
  anonymous request and a wrong password (401 both), accepted the right token,
  and a real `docker login`/`docker push` landed in `/v2/_catalog`. **Not
  verified**: a push through a published Traefik hostname with a real
  certificate. Tests: `tests/unit/app/registry-container.test.ts`,
  `tests/unit/app/registry-auth-file.test.ts`, `tests/e2e/ui-registry.spec.ts`.

`src/lib/services/secrets.ts` (not under `docker/`, it's a generic AES-256-GCM
utility, not Docker-specific, also used by SMTP/OAuth/S3-backup secrets),
`encryptSecret`/`decryptSecret` for `registryPasswordEnc` and every other `*Enc`
column, key derived via `scryptSync` from `config.auth.secret`.

Containers attach to the shared `homerun` Docker network rather than publishing
host ports, true for the default `networkMode: "bridge"`; see Network mode below
for the `"host"` exception. **The Go worker's `ensureBridge()` calls
`EnsureNetwork` on every local bridge-mode deploy**
(`internal/jobs/deploy/container.go`, formerly `createAndStartContainer`'s own
`ensureSharedNetwork()`) rather than assuming a one-time
`docker network create`: compose creates it for a compose-run instance and
nothing does for a bare `bun run start`, and Docker Cleanup's network prune
removes it once the last container detaches. Its absence fails at container
**start**, not create ("network homerun not found"), which is why the deploy
looked like it had gotten further than it had.

**Compose files.** The actual service definitions live once in
`tools/compose/{base,app,worker,agent}.compose.yaml` (Traefik + Postgres in
`base`, the app, worker and Agent in the others); each root-level file is a thin
`extends:` composition of those, so Traefik's flags or Postgres's image change
in one place. **Only the worker service mounts `/var/run/docker.sock`**, in
every compose file that has one : the app container carries no Docker socket
mount at all any more, it reaches Docker over `WORKER_URL` (`http://worker:7430`
between containers) instead, see the Docker integration section above.

- `compose.yaml`, **local dev**, Traefik + Postgres only. Deliberately no `app`
  service: dev runs the app directly on the host (`bun run dev`/`bun run start`,
  alongside `bun run dev --only=worker`, see `worker.md`) so its own logs aren't
  viewable in-app (see `system-logs/` above). This is what
  `docker compose up -d` brings up, and what the app assumes exists.
- `compose.dev.yaml`, the same plus `app`, `worker` and `agent` built from this
  repo's own `Dockerfile` (`target: app` for `app`, `target: worker` for both
  `worker` and `agent`, since `cmd/agent` was merged into `homerun-worker`, see
  `packages-and-release.md`; the `agent` service is that same binary started
  with no `DATABASE_URL`, which is what puts it in agent mode), for exercising
  the containerized app locally.
- `compose.prod.yaml`, the operator-facing stack: the published
  `docker.io/orochibraru/homerun` image alongside Traefik and Postgres.
  Deliberately **self-contained**, no `extends:`, since someone who `curl`s just
  this one file down has no `tools/` directory; it's Option B in
  `docs/getting-started.md`, so a change here has to stay in step with that doc
  (`bun scripts/e2e-multipass-release.ts --only=docs` checks exactly that).

**The dashboard gets its own Traefik router, off one variable
(`DASHBOARD_DOMAIN`).** The app container used to carry no `traefik.*` labels at
all in any compose file, so Homerun itself was reachable on `:3000` and nowhere
else no matter how carefully `baseDomain` was configured, while every service it
deployed got a routed hostname. The labels live in
`tools/compose/app.compose.yaml`, `compose.prod.yaml` and the installer's
generated compose (`internal/installer/fullstack.go`), and the shape they take
is the result of testing three candidates against the real dev Traefik:

- `traefik.enable` set to an empty string (what `${DASHBOARD_DOMAIN:+true}`
  expands to when the variable is unset) is **not** silently ignored: Traefik
  logs `ERR Skip container ... decoding Docker labels: strconv.ParseBool` on
  every provider refresh, which the app's own System Logs page then shows. That
  label must be exactly `true` or `false`.
- Always-on with a placeholder hostname is worse: a router with a cert resolver
  and a host rule naming `localhost` makes Traefik call the **real** Let's
  Encrypt API and log
  `Unable to obtain ACME certificate ... Domain name needs at least one dot`, a
  rate-limited request for nothing.
- What works, verified live (no log output at all, and a real 200 served through
  Traefik): always `traefik.enable=true`, a host rule reading
  `${DASHBOARD_DOMAIN:-localhost}`, `tls=true`, and a cert resolver of
  `${DASHBOARD_DOMAIN:+${DASHBOARD_CERT_RESOLVER:-letsencrypt}}`. An **empty**
  cert resolver is quietly fine and falls back to Traefik's own self-signed
  cert, and nested interpolation like that is supported by Compose (checked with
  `docker compose config`, all three branches). So unset means "dashboard on
  `https://localhost` plus `:3000`, nothing logged", set means "real hostname,
  real certificate", from one variable.

The installer bakes the address it resolved (`--domain=` or the detected host)
in as the rule's default, and picks the cert resolver by whether that address is
a bare IP, since ACME can't issue for one.

The app itself _is_ containerized for production use (`Dockerfile`,
`docker-bake.hcl`, built/pushed by `.github/workflows/docker.yaml`; see Release
automation below). The installer's `--mode=full` generates its own separate
compose file on the target host (see `cmd/installer/` below) rather than reusing
any of these.

## Swarm mode (`instance_settings.orchestrationMode`, `service.replicas`/`swarmServiceId`, `src/lib/services/docker/swarm.ts`)

Instance-wide alternative to the single-container-per-service model described
above, and the default on an installer-made instance:
`instanceSettings.orchestrationMode` (`"standalone"` | `"swarm"`, null reads as
standalone, `/settings`) makes `resolveDeployPlan()` (`deploy/plan.ts`) pick a
`swarm` `WorkloadPlan` over a `container` one for every **local** deploy.
`deploy/worker-spec.ts`'s `workloadSpec` then builds a `swarmServiceTemplate()`
(`docker/swarm.ts`, still pure TS) instead of a `containerCreateTemplate()`, and
the Go worker's `internal/jobs/deploy/swarm.go`'s `startSwarm` creates or rolls
out the real Docker Swarm Service (`Mode: {Replicated: {Replicas: n}}`) instead
of `container.go`'s `startContainer` — `deploy.go`'s `Run` branches on
`spec.Workload.Kind` the same way `deploy.service.ts` used to branch on
`orchestrationMode` inline. `DockerService.createAndStartSwarmService` no longer
exists; a route/DTO acting on an already-running swarm service still goes
through `DockerSwarmMixin` below for that.

- `service.replicas` (int, default 1, edited on Container → Compute, ignored in
  standalone mode) is the desired replica count.
- `service.swarmServiceId` is the swarm-mode equivalent of `containerId`;
  `containerId` stays null for a swarm-mode service, there's no single container
  to point it at, `DockerSwarmMixin.getRunningTaskContainerId` resolves one
  specific task's container on demand instead (used by the Terminal tab's exec).
- Mixin surface: `ensureSwarmNetwork` (idempotent overlay network, the
  swarm-mode counterpart to `networks.ts`'s per-stack bridge networks),
  `removeSwarmService`, `scaleSwarmService` (stop/start map to scaling to 0 /
  back to the configured replica count, rather than a real container
  stop/start), `restartSwarmService` (bumps `ForceUpdate` to recreate every
  task), `inspectSwarmServiceStatus` (aggregates task states into the same
  `ContainerStatus` vocabulary standalone mode uses, so the Overview tab doesn't
  need a separate rendering path), `streamSwarmServiceLogs` (same
  `ReadableStream` shape as `containers.ts`'s `streamLogs`).
  `docker/reconcile.ts`'s `DockerReconcileMixin` checks `service.swarmServiceId`
  first and calls `inspectSwarmServiceStatus` when present, falling back to the
  standard container path otherwise. The v1 REST API's `start`/`stop`/`restart`
  routes (`src/routes/api/v1/services/`) branch the same way, swarm-mode
  services are controllable via the API, not just the dashboard.

**Default mode and how it's picked.** The installer's `--mode=full` now runs the
stack on the system daemon,
`docker swarm init --advertise-addr <default-route ip>`, creates `homerun`
(bridge) and `homerun-swarm` (attachable overlay), and writes Traefik's compose
command ending in exactly the three flags `enableSwarmMode` applies, in the same
key order, because `applyTraefikFlags` compares the whole argv and would
otherwise recreate Traefik on every boot. Nothing is seeded into the database:
`InstanceSettingsDTO.getOrCreate()` reports whether this boot created the
singleton row, and `OrchestrationService.applyOnBoot`
(`src/lib/services/orchestration.service.ts`, called from `hooks.server.ts`'s
`init()`) stores `detectInitialOrchestrationMode()` on a fresh row only (pure
`initialOrchestrationMode`: swarm on an active manager with control available
that isn't rootless, standalone otherwise). An existing row is never flipped.
`--docker=rootless` keeps the old rootless install, which boots standalone.

**The host is prepared by the app, not by hand.** Saving Swarm on Settings →
Docker calls `DockerService.enableSwarmMode()` (see `core-services.ts` above):
`swarmInit` when the daemon isn't a manager, the `<networkName>-swarm` overlay,
Traefik attached to it, and Traefik v3's `--providers.swarm` flags written onto
the live container via `applyTraefikFlags`. The core-services watch
(`cron/core-services-watch.ts`, started from `hooks.server.ts`'s `init()`) calls
it again whenever the stored mode is `swarm` and the worker's `/v1/health`
`bootId` changes (first contact included), alongside the dashboard router, DNS
and `syncNewt`, since a `docker compose up` recreating Traefik from the compose
file drops flags the app added, and a worker restarted alone (or not up yet when
the app booted) would otherwise never see them re-asserted; `applyTraefikFlags`
no-ops when they already hold, so a normal boot never bounces the proxy. The
action persists the mode **only after** host preparation succeeded (it used to
save first and report "Mode saved, but the host couldn't be prepared", leaving a
rootless instance stored as swarm with every deploy failing), and the page's
`load` asks `swarmModeUnavailableReason()` so a rootless daemon shows the reason
and a disabled Swarm option before submit. Not handled by the app: a
multi-interface host where `swarmInit` can't pick an advertise address (the
installer passes one; by hand, run `docker swarm init --advertise-addr <ip>`
once and save again).

**Migrating a rootless install** (`--migrate-to-rootful`,
`internal/installer/migrate.go`'s `Migrate`): stops every container on the
rootless daemon, copies each named volume through `tar --numeric-owner` in
`alpine:3` on both daemons (ownership as the container saw it, not the subuid on
disk), recreates volumes with their labels so compose keeps owning them, sets up
swarm + networks, rewrites `homerun.yaml`'s `socketPath` and the compose file,
starts the stack, then waits for the app (so its migrations have run) and sets
`orchestration_mode = 'swarm'` plus `instance_settings.pendingServiceRedeploy`
in psql and restarts the app. `applyOnBoot` sees the flag, queues
`DeploymentService.enqueueDeploy` for every service with a `containerId` or
`swarmServiceId` under the first admin, and clears it. Progress markers live in
`<compose dir>/.rootful-migration`, so a re-run skips finished copies and never
queues the redeploys twice. Verified end to end on a Multipass VM from a real
v1.0.26 rootless install, see `cmd/installer/README.md`.

**Swarm spec details, and what swarm mode can't do.** Pure helpers in
`swarm.ts`, tested in `tests/unit/app/swarm-spec.test.ts`: `swarmMount` (an
absolute source is a bind mount, anything else `Type: "volume"`; every mount
used to be `bind`, so a service with a named volume couldn't deploy in swarm
mode at all), `swarmNetworksFor` (the overlay with the slug as an alias, so
`http://<slug>:<port>` works like in standalone, or `Target: "host"` for host
networking, which the deploy plan used to reject), `swarmRestartCondition`
(`on-failure` now maps to swarm's `on-failure`). `getRunningTaskContainerId`
only returns a task on this node (`info.Swarm.NodeID`), since exec and
pre-backup commands only reach the local daemon. The uptime probe runs its
hostname probe for swarm services (the network probe needs a container id). A
deploy log warns, once the swarm has a second node, that a `homerun-build-*`
image without a registry and any volume are per node. Still not supported:
privileged and devices (no swarm API), per-stack networks (everything shares the
overlay), terminal/stats/pre-backup on remote replicas. The Settings → Docker
page lists these.

**Per-replica stats.** `DockerSwarmMixin.listSwarmReplicas(swarmServiceId)`
lists the service's tasks (slot, node hostname, state, container id) and samples
each local task container with `sampleContainerStats`; a task on another node
comes back with `local: false` and no sample, since the app only reaches this
daemon. The service Overview renders it through `getReplicaStats`
(`stats.remote.ts`, polled) in `src/lib/components/replica-stats.svelte`, and
`StatsSampler` records the sum over local replicas (`sumReplicaSamples`,
unit-tested in `tests/unit/app/swarm-replicas.test.ts`) as the service's
`stat_sample` (`ServiceDTO.listRunningWithContainers()` now also returns running
rows with a `swarmServiceId`; the uptime probe filters those back out), so the
usage graph works in swarm mode instead of staying empty.

**This app only ever talks to the local manager.** Extra capacity comes from a
node _joining this swarm_ as a worker, which Docker then schedules onto on its
own; it is never a `remote_host` row. That's exactly why Remote Hosts was cut
back to build servers (see Build servers above), a second standalone daemon and
a swarm worker are different things and this app only wires up the latter.
`cmd/installer/swarm-join.sh` (a standalone bash script, documented in
`cmd/installer/README.md`) joins a box as a worker **on its system (rootful)
daemon** and then runs the released installer binary with `--mode=agent` for the
agent, rather than hand-copying the TS installer's rootless steps (the copy had
drifted and lacked the AppArmor profile). Usage:
`curl -fsSL .../swarm-join.sh | sudo bash -s -- --token=<SWMTKN-...> --manager=<ip>:2377`.
Once joined, the node is schedulable by the swarm itself, nothing in this app
has to register it.

**Swarm DNS alias watch** (`SwarmDnsWatch`, `cron/swarm-dns-watch.ts`, started
from `hooks.server.ts`'s `init()` alongside the other cron schedulers, see
`jobs-and-queue.md`): every 5 minutes, in swarm mode only, it `lookup()`s each
running swarm service's own slug from inside this process (Docker's embedded DNS
when the app itself runs in a container). A Docker rolling-update race can drop
a service's overlay alias when the old task sharing it shuts down after the new
one registered it — every link written as `<slug>` then fails while only the
full `homerun-<slug>-<hash>` name still resolves, the actual cause of services
reporting "can't reach redis" despite correct env vars. `lostAliases()` treats a
slug as lost only when at least one other service's slug still resolves (if none
do, this process isn't on the overlay at all — dev, or an unattached container —
and restarting would fix nothing); a lost one gets `restartSwarmService`d
(forces a new task, re-registering the alias), at most once an hour per service
(`RESTART_COOLDOWN_MS`), plus a `NotificationDTO.notify`. Unit-tested with a
stubbed `resolves()` (`tests/unit/app/swarm-dns-watch.test.ts`); not yet
exercised against a real alias-drop on a live swarm the way the rootless/rootful
findings below were.

**Real, tested finding: swarm mode can't run on rootless Docker.** On a rootless
install (the installer's default at the time), saving Swarm initialised the
swarm and created the overlay, then `connect` for Traefik failed with "attaching
to network failed ... context deadline exceeded" and the daemon logged the task
failing with `mkdir /var/lib/docker/network: permission denied` (plus a missing
`br_netfilter` for the ingress network). Docker documents overlay networks as
unsupported in rootless mode. So `enableSwarmMode` calls
`assertSwarmCapableDaemon` first, which throws before touching the host when
`docker info`'s `SecurityOptions` carry `name=rootless` (`isRootlessDaemon`,
unit-tested in `tests/unit/app/swarm-rootless.test.ts`), and the installer
became rootful by default. Verified end to end on two Multipass VMs: rootful
manager, worker joined through the script, a 3-replica service with tasks on
both nodes, Traefik answering from every replica over the overlay
(`bun scripts/e2e-multipass.ts --swarm` replays it). Traefik's swarm provider
polls every `providers.swarm.refreshSeconds`, set to 2 (`SWARM_REFRESH_SECONDS`)
by `enableSwarmMode` and the installer, so new replicas join within 2s.

## Readiness gate (`docker/readiness.ts`, `planReadiness` in `internal/jobs/deploy/readiness.go`)

A new container or swarm task gets no Traefik traffic before it's ready, like a
Kubernetes readiness probe, and the only lever that provably does that for both
providers is a **Docker healthcheck**. Verified facts, from source and live:

- **Traefik docker provider**: `keepContainer` (`pkg/provider/docker/config.go`
  in traefik/traefik, v3.7) drops a container whose `State.Status` isn't
  `running`, and one whose `State.Health.Status` is set and isn't `healthy`
  (unless `providers.docker.allowEmptyServices`). No healthcheck means `Health`
  is empty and a running container is routed at once. The provider rebuilds only
  on container events `start`, `die` and `health_status*`
  (`pkg/provider/docker/pdocker.go`), no polling, so network `connect` or
  `disconnect` is never noticed on its own. Live, behind a throwaway Traefik
  v3.7.13: a slow-starting second container with no healthcheck took 50% of
  requests as 502 for its whole startup; with a healthcheck (an image-style
  `wget` one, and the generated one below) every request went to the old
  container until the new one turned healthy, then both, zero errors.
- **Traefik swarm provider**: lists tasks with `desired-state=running` and keeps
  only `Status.State == running` (`listTasks` in
  `pkg/provider/docker/pswarm.go`), polling every
  `providers.swarm.refreshSeconds` (15s default), no events.
- **Swarm**: the executor's `Start`
  (`daemon/cluster/executor/container/controller.go` in moby/moby) returns, and
  the task becomes `running`, right after the container starts when there's no
  healthcheck; with one, only on the `health_status: healthy` event, and it
  activates the service binding (VIP and DNS) only then; an `unhealthy` event
  shuts the task down. Start-first (`manager/orchestrator/update/updater.go` in
  moby/swarmkit) removes the old task as soon as the new one reaches `running`.
  Live on a throwaway swarm: without a healthcheck an update to a task needing
  8s to listen gave about 6s of 100% 502 (old task stopped, Traefik then only
  knew the not-yet-listening one); with the generated healthcheck, zero errors
  from the gate itself. What's left is the poll lag: an old task that exits
  right away on SIGTERM gave about 4s of errors before Traefik's next poll
  dropped it. `traefik.docker.lbswarm=true` (VIP, which swarm updates instantly)
  would close that, but VIP routing didn't work at all on the OrbStack test
  daemon, so it's unverified and not used. Instead the poll is 2s
  (`SWARM_REFRESH_SECONDS`) and every router gets a `<slug>-retry` middleware
  (`labels.ts`, 4 attempts from 100ms): Traefik's retry
  (`pkg/middlewares/retry`) only retries a network error when no request bytes
  reached the backend, and never after response headers or on an upgrade, so a
  request dialing a removed container or task is replayed on the next server and
  a POST is never sent twice. It covers standalone's old container being removed
  while Traefik still lists it too. Not re-measured live.
- **Rejected alternatives**: starting the container off the Traefik network and
  connecting it after a probe (Traefik never sees the `connect`, and when the
  labelled network is missing it falls back to the container's first network
  address, routing to something it can't reach); Traefik's own load balancer
  healthcheck (a new server starts as up, and a path check fails on login-walled
  or 404-at-root apps); file-provider config (the routers come from labels).

`ReadinessCheck` (`internal/jobs/deploy/readiness.go`) picks, in order: the
service's `healthcheckCommand`; nothing when the workload isn't routed by
Traefik (`dnsResolvable` false, host networking, remote host); the image's own
`HEALTHCHECK`; nothing for a UDP-only port; nothing when the image can't be
inspected or has no `/bin/sh`; otherwise the generated **listening** check
(`listeningScript`, still pure TS in `docker/readiness.ts`, embedded into the
deploy spec upfront as `healthchecks.listening`): a `CMD-SHELL` loop over
`/proc/net/tcp` and `/proc/net/tcp6` using only shell builtins, passing once a
socket is in `LISTEN` (`0A`) on the container port on a non-loopback address. It
works without nc/curl/wget/bash, verified on busybox ash and Debian dash (a
loopback-only listener fails it, as it should: Traefik couldn't reach it
either). `/bin/sh` is detected by running a throwaway, network-less helper from
the image with entrypoint `/bin/sh -c "exit 0"` (`dockerapi.RunHelper`, 2 minute
cap): exit 0 means a shell, a start the daemon refuses means none, so `scratch`
images (`traefik/whoami`, `hello-world`) come back without one. It used to
`HEAD .../containers/<id>/archive` a never-started container, the same
archive-API-on-a-never-started-container pattern that wedged dockerd in
production (see `jobs-and-queue.md`'s S3 backups). The generated check starts
probing every second (`StartInterval`, Engine API 1.44+) for a start period as
long as `ROLLOUT_WINDOW.maxWaitMs` (`docker/rollout.ts`, still TS, read by
`listeningHealthcheck` when the spec is built), then every 30s with 3 retries,
so it's liveness too: a crash-restart resets health to `starting`, which takes
the container out of Traefik again until it listens (verified). The service
healthcheck spec (`dockerHealthcheck`) got the same 1s `StartInterval`, so a
rollout no longer waits 30s for its first probe. Containers and task specs with
the generated check carry `homerun.readiness=listening`, and `containerHealth`
returns null for them so the uptime probe keeps its own HTTP/TCP probe rather
than reporting the generated check as the image's.

The deploy log gets one `Readiness: ...` line from `ReadinessDescription` on
every deploy, standalone and swarm, and the blue-green completion line says
whether Traefik only now routes to the new container or already was. Known gaps:
`scratch`/distroless images without a `HEALTHCHECK` (no gate; the service's
healthcheck command can't help either, it's `CMD-SHELL`); stopping the old
standalone container still races Traefik's `die` handling, one request timed out
in the live run when a SIGTERM-ignoring old container was killed.

### Per-service healthcheck overrides and Observability → Health

`service.healthcheckDisabled` plus nullable
`healthcheck{Interval,Timeout,StartPeriod}Seconds`/`healthcheckRetries` (null =
default, `HEALTHCHECK_DEFAULTS` in `docker/healthcheck.ts`). The timing
overrides feed both `dockerHealthcheck` (the service's command) and
`listeningHealthcheck` (Homerun's port check, whose start period stays tied to
`ROLLOUT_WINDOW`). `readiness.disabled` in the worker spec makes
`ReadinessCheck` return `none`/`disabled` before anything else, and
`healthcheck()` then creates the workload with `Test: ["NONE"]` so the image's
own HEALTHCHECK is off too. `RevisionHealthService.#readiness` skips the HTTP
answer check for a disabled, non-DNS-resolvable or host-network service, the
same set the deploy's gate treats as not routed: before that, a queue worker
with no HTTP server (its `PORT` env notwithstanding) was flagged unhealthy on
every deploy with "It never became ready: Unable to connect". Observability's
Health section (`services/[serviceId]/observability/health/`) reads the live
container's `Config.Healthcheck`/`State.Health` through
`DockerService.containerHealthcheck` (the worker's raw `/inspect`), so it shows
what's applied, not what's configured; swarm tasks aren't inspected.

## Runtime options (`service.command`/`entrypoint`/`envFiles`/`labels`/`capAdd`/`devices`/`privileged`/`runAsUser`, Container → Runtime)

Stored as jsonb argv lists / string lists / a label map plus a boolean and a
nullable text `run_as_user`; `src/lib/service-runtime.ts`'s `runtimeOptionsFrom`
reads them off a row with defaults, and `deploy.service.ts`'s `#startWorkload`
passes them as `runtime` to both workload paths. The pure mapping is
`docker/runtime-options.ts` (`runtimeArgv` → `Cmd`/`Entrypoint`/`User`,
`runtimeHostConfig` → `CapAdd` with the `CAP_` prefix, `Devices` from
`host[:container[:perms]]`, `Privileged`), tested in
`tests/unit/app/docker-runtime-options.test.ts`. Swarm maps entrypoint to
`ContainerSpec.Command`, command to `Args`, capabilities to `CapabilityAdd`, the
run-as user to `User`, and logs that privileged/devices are ignored (the swarm
API has neither). Custom labels go through `mergeLabels`, Homerun's own labels
winning on a key clash, on the container and on both the swarm service and its
task spec. `runAsUser` is validated by `isRunAsUser` (`uid`, `uid:gid`, `name`,
`name:group`) everywhere it comes in (Container → Runtime, API, template JSON,
compose `user:`, Coolify `--user`/`-u`) and isn't host access: it's what fixes
an image whose non-root `USER` can't write a fresh, root-owned named volume
(Vikunja runs as `0`).

Env files are **host** paths, but the app runs in a container, so
`deploy/env-file-step.ts` reads each one with an `alpine:3` `runOneOff` that
binds `/` read-only at `/homerun-host` and `cat`s the path. Binding the file
itself would make Docker create a missing path as a directory on the host. An
unreadable file throws, failing the deploy. Only the local daemon: container
workloads never pass `remote` today.

## Network mode (`service.networkMode`, `service.portProtocol`, Networking tab)

Per-service, `"bridge"` (default) or `"host"`, configured in the Networking
tab's **Network** section, alongside `containerPort` and `portProtocol` (`"tcp"`
default | `"udp"` | `"both"`, which protocol(s) `ExposedPorts` declares the
container's port under). `"host"` shares the host's network namespace directly
(`HostConfig.NetworkMode: "host"` in `docker/containers.ts`), for apps that
specifically need real host-network access (mDNS/SSDP discovery, e.g. Home
Assistant), which bridge networking can't provide.

Host mode forces `dnsResolvable` off (both in the stored row, at save time, and
again defensively at spec-build time in `containerCreateTemplate`), there's no
container-specific IP/network for Traefik's docker provider to route to in host
mode, only the host's own interfaces, so Traefik labels are skipped entirely
regardless of what's stored. No stack-network join either (Docker containers in
host mode can't also join a user-defined network). A host-mode service is
reachable only directly on the host's own `containerPort`, exactly as if you'd
run it with `docker run --network host` yourself; published ports don't apply
there (the Networking tab hides them).

## Per-domain container ports (`service.domainPorts`, Networking tab)

One container can serve several HTTP ports under different hostnames (a web UI
and an API side by side). `domains` stays a plain list, since DNS sync, the
uniqueness check and compose import all read it, and `domainPorts` maps a custom
domain to the container port its router targets; a missing entry means
`containerPort`. `buildContainerLabels` emits one Traefik service per distinct
port, `<slug>` for `containerPort` (unchanged from before, so existing routers
keep their names) and `<slug>-<port>` for the others. The default
`<slug>.<baseDomain>` hostname can't be overridden: it changes when the stack is
renamed, and an override keyed on it would silently go stale. Anything that
isn't HTTP (SSH, UDP) can't be routed by hostname at all, it needs a published
port below.

## Published ports (`service.publishedPorts`, Networking tab)

HTTP(S) goes through Traefik by domain, but UDP and non-TLS TCP (a VPN, SSH for
a git forge, a game server) carry no hostname, so nothing can route them by
domain: they need a host port. `publishedPorts` is a list of
`{ hostPort, containerPort, protocol }`, turned into `PortBindings` plus
`ExposedPorts` on the container create body and an ingress `EndpointSpec` on a
swarm service. The domain side of "vpn.example.com over UDP" is just a DNS
record pointing at the box. Saving refuses host 80/443 over TCP (Traefik's), a
duplicate host port/protocol, and a host port/protocol another service already
publishes; a clash with something outside Homerun (the host's own sshd on 22)
only shows up as a failed deploy. **A service with published ports always rolls
out stop-first** (`RolloutStrategy`'s `publishesPorts`): blue-green would start
the new container while the old one still holds the port, and Docker refuses the
second bind. Swarm is exempt, the ingress port belongs to the service rather
than a task. Compose import publishes every host mapping except the main TCP
port, which stays on Traefik; ranges are skipped. Revisions snapshot the list,
so a rollback restores it.

**Real, tested finding**: `HostConfig.NetworkMode: "host"` combined with a
`NetworkingConfig.EndpointsConfig` (the shared-network attach bridge mode uses)
does **not** fail at the Docker API level the way you might expect, verified
live against a real scratch container, Docker silently accepted both and the
container ended up attached to the named network instead of `"host"`
(`NetworkSettings.Networks` showed the bridge network, not `host`).
`containerCreateTemplate` explicitly omits `NetworkingConfig` entirely when
`networkMode === "host"` specifically because of this, sending both is not a
hard error you'd catch in testing, it's a silent wrong-mode footgun. Also
verified live: with `NetworkingConfig` correctly omitted, the container comes up
with `NetworkSettings.Networks: { host: {...} }` and no IP address, as expected
for real host networking.

## Docker Cleanup (`src/lib/services/docker/cleanup.ts`, `(protected)/docker-cleanup/`)

Admin-only (nav item, Administration category, `adminOnly: true`), host-wide
Docker housekeeping, `docker system df`/`prune` exposed through the dashboard
instead of needing shell access to the host. Deliberately **not**
`homerun.managed=true`-scoped like the rest of `DockerService`, this is the one
mixin that intentionally looks at (and can delete) containers/images/
networks/volumes/build cache Homerun didn't create, that's the entire point of a
cleanup tool.

`docker-cleanup/+page.server.ts`'s `load` calls
`DockerService.getCleanupPreview()` (`docker.df()` + `listNetworks()`, filtered
to what's actually reclaimable, unused images, non-running containers,
unreferenced volumes, unused networks excluding the three Docker defaults and
whatever's still attached to a container, unused build cache entries) so the
page shows what a prune would remove before the admin commits to it. Six form
actions, each a thin call into one `DockerCleanupMixin` method
(`pruneContainers`/`pruneImages`/`pruneNetworks`/`pruneBuildCache`/
`pruneVolumes`/`pruneSystem`, `pruneSystem` running the first four in sequence
and returning one combined summary), every one refused by the request hook
without write access to System (the page itself needs read). No
confirmation-dialog/dry-run step in the UI itself, the preview list is the only
"are you sure" a prune action gets.

**Retained revisions are never pruned.** `pruneImages(all, keepImageIds)` and
`pruneSystem(keepImageIds)` take the image ids of every retained revision
(`RevisionService.retainedImageIds()`: `revisionImageRefs` per revision, the
recorded `imageId`, `image@digest`, and the unique `homerun-build-*` tag for a
git build, resolved through `DockerService.existingImageIds`), and the preview
hides them too. With a non-empty keep list the prune doesn't call Docker's
`POST /images/prune` (whose only filters are labels and age, and a pulled image
can't be labelled) but walks `docker.df()`'s unused images and removes each one
not kept, skipping any the daemon refuses. That matters for dangling-only prunes
as well: a pulled revision whose tag moved on is untagged, i.e. dangling, but
still exactly what a rollback by digest needs.

**Mounted volumes are never pruned either.** `pruneVolumes(keepVolumeNames)` and
`getCleanupPreview(keepImageIds, keepVolumeNames)` take
`ServiceVolumeDTO.mountedVolumeNames()`, the source of every `kind: "volume"`
storage volume with at least one `service_volume` row. Docker's own `RefCount`
only sees containers, so a service whose container was removed (a stopped swarm
service scaled to 0, a failed deploy, a `pruneContainers` run first) left its
data volume looking unused and `docker volume prune --all` took it. With a
non-empty keep list the prune walks `docker.df()`'s unreferenced volumes
(`prunableVolumes`, unit-tested in `tests/unit/app/docker-cleanup.test.ts`) and
removes each one not kept, same shape as the image keep list above.

## Registry (`/registry`, admin-only, `src/routes/(protected)/registry/`)

Turns `homerun-mirror` (see the Registry bullet under Docker integration above)
into a real push/pull-able private registry. Admin-only (nav item,
Administration category), four tabs, one route each: bare `+page.svelte` =
Images (the default), `tokens/`, `credentials/`, `settings/`.
`+layout.server.ts` guards on `user.role !== "admin"` and loads
`RegistryService.status()` once for every tab; `+layout.svelte` owns the
`TabNav`.

- **Images**: `catalogPage(query)` (one `_catalog` call filtered by `q` and
  paged, then the page's repositories' tags read in parallel, streamed to the
  page) with which `ServiceDTO`s reference each repository (cross-referenced
  through `mirrorRepository(image, tag)`), and the garbage-collect action. Each
  repository has its own page, `images/[...repository]` (a rest param, since
  repository names carry slashes), built on `repository(name)`, with the
  delete-tag/delete-repository actions; it redirects to the list once the
  repository has no tag left.
- **Tokens**: `listTokens()`/`createToken()`/`revokeToken()`, with a one-time
  `docker login` snippet shown on creation (`form.created`, never re-derivable,
  the plaintext secret isn't stored).
- **Credentials**: read-only, `BuildCacheRegistryDTO.list()` plus every
  `ServiceDTO` with its own `registryUsername` set, each linking to where it's
  actually edited (`/build-cache-registries` or the service's Environments &
  Deployments → Source section). No storage of its own.
- **Settings**: `status()`, `setAuthEnabled()`, `setPublicHost()`.

See the Registry bullet under Docker integration above for `RegistryService`,
the schema, and the container reconciliation this page drives.

The registry's public host gets DNS like the dashboard's: `syncCoreHostDns`
(`dns.service.ts`, `sso: false` since `docker login` can't follow Pangolin's
sign-in) runs from `RegistryService.setPublicHost` (deleting the previous host)
and from the core-services watch. Before it, a Pangolin instance's edge answered
the host with its default certificate, which the self-test reported as "no HTTPS
router matches". As a build cache (`service.buildCacheBuiltin`, the select's
`builtin` value via `buildCacheChoice`), `#builtinCacheRegistry` in
`deploy.service.ts` hands the builder `127.0.0.1:5055` (BuildKit's
`homerun-cache` builder is host-networked and treats a loopback registry as
plain HTTP) with the internal credentials for a local build, and nothing for a
build server (its cache registry doubles as the image transfer, which would
hairpin through the public hostname). `PlanGC` (`internal/registryapi`) always
keeps a `buildcache` tag, which no keep set lists.

## Object storage (`/object-storage`, `ObjectStorageService`, `docker/garage.ts`)

The built-in store is a single Garage node (`dxflrs/garage`, pinned in
`docker/garage-container.ts`), run like the registry: `DockerGarageMixin`
(merged outermost, it needs `runOneOff`/`pullImage`/`selfContainer`) creates
`homerun-garage` on the shared network with `homerun-garage-meta`/`-data`/
`-config` volumes, loopback ports 5056 (S3) and 5057 (admin), labelled
`homerun.infra=garage`. The Garage image is `FROM scratch`, so `garage.toml` is
written into the config volume by a one-off `alpine` container, and it carries
no secret: `GARAGE_RPC_SECRET`/`GARAGE_ADMIN_TOKEN` go in as env vars (minted on
first enable, stored encrypted in `instance_settings`), which is what
`garageMatches` diffs to decide on a recreate. `reconcileGarage(null)` removes
the container and keeps the volumes. `garageEndpoints()` picks the loopback or
in-network address like `imageMirrorClient` does.

A fresh node serves nothing until it has a layout:
`GarageAdminClient. ensureLayout` (admin API v2,
`src/lib/services/s3/garage-admin.ts`) assigns the node a role and applies
`layoutVersion + 1`; `UpdateClusterLayout`'s body is `{roles: [...]}`, verified
against a live v2.4.1 (a bare array is refused). **Verified live**: buckets
created over S3 by a key with `createBucket` only get a _local_ alias, invisible
to every other key, so the built-in store creates and deletes buckets through
the admin API (`CreateBucket` with `globalAlias`, then `AllowBucketKey` for
Homerun's own key) and does everything else over S3.

Every store, built-in included, is an `object_store` row (`ObjectStoreDTO`,
`summary()` is what pages get, never the encrypted secret); S3 calls go through
`ObjectStoreClient` on the shared SigV4 signer (`src/lib/services/s3/signer.ts`,
also used by backups, tested against AWS's published signature examples),
path-style only. The core-services watch calls
`ObjectStorageService.reassertBuiltin()` on a worker restart, and the public
host gets DNS through `syncCoreHostDns`, like the registry's.

Public buckets (`public_bucket`, `PublicBucketDTO`) aren't a store feature:
Garage has no bucket policies and its website endpoint picks the bucket from the
hostname, and providers differ (R2 has no policy API). Homerun serves them
itself instead: `src/routes/public/[storeId]/[bucket]/[...key]/+server.ts`
(outside `(protected)/`, so anonymous) checks the flag, fetches the object with
the store's key through `ObjectStoreClient.objectResponse` (range passed on) and
streams the body back with only its content headers. When the built-in store is
published at a hostname, `ObjectStorageService.syncPublicRoutes()` writes
`homerun-public-buckets.yml` (`src/lib/public-bucket-routes.ts`) into Traefik's
dynamic config: per public bucket, a router at priority 9300 (above Garage's
label router) matching unsigned `GET`/`HEAD` under `/<bucket>/` on that host,
with an `addPrefix` of `/public/<storeId>` onto the app, so the bucket page
shows `https://<host>/<bucket>/<key>`. Signed requests (an `Authorization`
header or `X-Amz-Signature` query) never match and still reach Garage. It's
resynced on every `ObjectStorageService.setPublic`, bucket delete, host change,
disable and `reassertBuiltin`, so always change the flag through the service,
not `PublicBucketDTO` directly. Emptying a bucket is
`ObjectStoreClient.emptyBucket`: list 1000 keys, one `DeleteObjects`, repeat
until the listing comes back empty (current versions only, a versioned AWS
bucket keeps its old versions and still refuses deletion).

Terraform state (`IacStateService`, `iac_project`/`iac_state_version`/
`iac_state_lock`, managed from `/iac/state`, not from Object Storage) is
Terraform's `http` backend: every write is a new object
(`<prefix>/<slug>/<serial>-<versionId>.tfstate`) plus a version row, the lock is
a row taken with `INSERT ... ON CONFLICT DO NOTHING`, a rollback rewrites an old
body with `serial = latest + 1`. **Verified live** with Terraform 1.x against
Garage: init, apply, a contended lock reported by Terraform with the holder's
info, force-unlock, rollback seen by the next `plan`. See the routes in
`api-and-cli.md`.

## OpenTelemetry collector (`docker/otel.ts`, `TracingService`)

The third core container on the Garage pattern: `DockerOtelMixin` (merged
outermost, it needs `runOneOff`/`pullImage`) creates `homerun-otel` on the
shared network with no published port and no Traefik label, its config written
into `homerun-otel-config` by a one-off `alpine`, its export address and token
as env vars, `reconcileOtel(null)` removing it. See `observability.md`'s Tracing
section for what it's configured with and why.

## Web terminal (`src/lib/services/docker/terminal.ts`)

Per-service "Terminal" tab, a real xterm.js terminal (`@xterm/xterm` +
`@xterm/addon-fit`, loaded with a dynamic `import()` in `onMount` so SSR never
touches it) over a `Tty: true` exec in the live container (rejects the request
if the service isn't `currentStatus: "running"`). The worker's default command
is `sh -c 'bash if present, else sh'` (`defaultShell` in
`internal/workerapi/terminal.go`); TERM is whatever the daemon sets for a TTY
exec (`xterm`). Output is written to xterm untouched, ANSI and all. Keystrokes
(`onData`) go raw as a `text/plain` body, never line by line: the page keeps one
input request in flight and batches whatever is typed meanwhile into the next
one, which both caps the request count and keeps keystrokes in order (two
parallel POSTs can land out of order). The fit addon plus a `ResizeObserver`
refits on element resize, and xterm's `onResize` posts `{cols, rows}` to
`.../terminal/[sessionId]/resize` → `POST /v1/terminal/<id>/resize` → Docker's
`/exec/<id>/resize`, once right after the session opens too. Colours come from
the `--color-bg`/`--color-text`/`--color-accent` tokens, converted to `rgba()`
through a 1px canvas rather than trusting xterm to parse `oklch()`, and re-read
by a `MutationObserver` on `<html>`'s class when mode-watcher flips dark mode.
No WebSocket, neither this app nor the Go worker hangs a `ws` upgrade off
anything, so it's chunked HTTP end to end: `POST .../terminal/open` creates the
session, `GET .../terminal/[sessionId]/stream` is one long-lived streamed
response for output (same `ReadableStream` shape as `streamLogs`),
`POST .../terminal/[sessionId]/input` sends stdin a chunk at a time,
`POST .../terminal/[sessionId]/resize` resizes the PTY,
`POST .../terminal/[sessionId]/close` ends it early. Every app route re-checks
session ownership (`userId` match) independently, `docker/terminal.ts`
(`DockerTerminalMixin`) only trusts the `containerId` it's given, it doesn't do
its own auth — the shell, the hijacked stream and the idle reaper (15 minutes,
`internal/workerapi`'s `TerminalHub`, a ticker goroutine rather than the app's
old `setInterval`) all live in the Go worker now, this mixin only keeps its own
session book (service, user, container) mapping a session id to who it belongs
to, since the worker only ever sees a container id and has no notion of users.
Opening a session is `POST /v1/terminal {containerId}` on the worker, which
returns a session id the app then streams/writes/closes by hitting
`/v1/terminal/<id>/stream`\|`/input`\|itself for `DELETE`.

**Machine terminals** (`/terminal`, `MachineTerminalService`) reuse all of the
above for a shell on a machine rather than a container: the worker's
`POST /v1/ssh` dials SSH itself (`internal/sshterm`, `golang.org/x/crypto/ssh`,
PTY + login shell) and hands the connection to `TerminalHub.Adopt`, after which
stream/input/resize/close are the same routes and the same hub (`Adopt` closes
`pidReady` up front, so there's no PID marker and no kill step: closing the SSH
channel hangs the shell up). The app keeps one ed25519 key pair in
`instance_settings` (`ssh_private_key_enc`, generated lazily, PKCS#8 PEM because
that's what `ssh.ParsePrivateKey` reads) and each machine's host/port/user/host
key on `instance_settings` (this server) or `remote_host`. Host keys are
trust-on-first-use: an empty recorded key accepts whatever is presented and the
app stores it, a mismatch is a 409; changing the host clears the key. "This
server" is reached as `host.docker.internal`, which every compose file maps to
`host-gateway` on the worker. **The hub buffers output (up to 64 KiB) while a
session has no listener and replays it to the first subscriber**: an SSH shell
prints its banner and prompt the instant it opens, before the browser's stream
request lands, and Bun doesn't send a streamed response's headers until its
first chunk, so without the replay the page sat on "connecting" forever with a
shell waiting for input nobody could send.

**Closing a session kills its processes; detaching doesn't.** Docker leaves an
exec's process running when its hijacked stream closes, and the pty's master
stays open in the shim, so the shell never gets SIGHUP: before this, every
session left a `/bin/sh` (plus whatever `top`/`vim`/background job it ran) in
the container until it restarted, 19 in a day on the dev nginx. `defaultShell`
now prints its in-container PID as an OSC sequence
(`\033]homerun-pid;<pid>\007`) before `exec`ing bash/sh; `pump` strips it
(buffering across split reads, passing output through untouched if it doesn't
start with the marker). Exec inspect's `Pid` can't replace this, it's the host
PID. A TTY exec runs as a session leader, so that PID is the session id of
everything started from the shell, but _not_ its process group once job control
gives each foreground job its own (`top` gets its own pgid), which is why
`Close` kills by session, not `kill -HUP -<pgid>`: a bounded (`killTimeout`, 5s)
`ContainerExec` of `killScript`, which scans `/proc/*/stat` with shell builtins
only (busybox `ps` can't print a sid), HUPs the session, then KILLs survivors
after 1s. Every close path runs it (the app's close route, the reaper, the
shell's own exit, `closeAll`); a kill that fails is logged and Close carries on,
quietly at debug when the shell had already exited (the container may be what
went away). `closeAll` runs them in parallel and the control API's shutdown
waits for it (`TerminalsClosed`), bounded by its 10s grace, so a worker restart
doesn't orphan shells either. On the page, `onDestroy` only fires on client-side
navigation, so a `pagehide` listener sends the close with `navigator.sendBeacon`
for a real tab close or full reload; before, those waited out the 15-minute
reaper.

**Load-bearing implementation detail, now resolved by moving to Go.**
dockerode's normal `exec.start({hijack:true})`, the standard way to get an
interactive exec's duplex stream, hangs forever under Bun: confirmed with a
minimal repro before writing any route code, `container.exec()` (plain
request/response, creates the exec) resolves fine, but `.start()` with hijacking
(an HTTP/1.1 `Connection: Upgrade` handshake handing back a raw socket) never
resolves, Bun's `node:http` compatibility layer doesn't complete that handshake
the way Node's does. The old TypeScript fix was to do the _start_ step by hand:
open a raw `Bun.connect()` Unix-socket connection to the Docker daemon, write
the HTTP/1.1 Upgrade request itself, and treat the socket as the raw duplex TTY
stream once the `101 UPGRADED` header block had been read past. That workaround
is gone along with the rest of the app's dockerode usage — Go has no such bug,
`internal/dockerapi`'s `CreateExec`/`StartExecHijacked`
(`internal/dockerapi/exec.go`) do the Engine's normal hijack protocol directly
over the daemon's unix socket with the standard library's own connection
hijacking, no manual HTTP framing needed, and `internal/workerapi/terminal.go`'s
`TerminalHub.Open`/`pump` are what actually run it. **Verified against a real
container end-to-end** (real command in, real output back) round-tripping
through the worker's control API before wiring it into the app's routes.

Audit trail is session-level, not per-keystroke: open/close are logged via the
standard `Logger` pattern on the app side (service/container/session/user ids)
and `log.Printf` on the worker side (session id, container id), individual
commands typed into the shell are not. That's a deliberate scope cut, not an
oversight, logging raw TTY bytes verbatim would be noisy and wouldn't cleanly
map to discrete commands anyway (arrow-key history, tab-completion, etc. all
flow through the same input channel).

## Orphaned stack networks (`findOrphanStackNetworks`, Docker Cleanup)

A stack's network is named from its id (`homerun-stack-<id>`) and removed when
the stack is, but a stack row that disappears any other way (a test run tearing
down the database, a half-failed create) leaves the network behind forever.
**Twenty-one of them exhausted Docker's default address pools on the dev box**,
which fails _every_ new network with "all predefined address pools have been
fully subnetted" : compose import, new stacks and three integration tests broke
at once, with the real cause nowhere in the error. `docker network prune`
doesn't help while anything is attached, and it's a sledgehammer otherwise (it
takes unrelated unused networks with it, including the shared one).

`DockerService.findOrphanStackNetworks(liveStackIds)` lists every
`homerun-stack-*` network whose id isn't in the set the caller passes
(`StackDTO.allIds()`, so the DB stays out of the docker layer), and
`reclaimOrphanStackNetworks` removes the ones nothing is attached to, reporting
the rest rather than tearing a network out from under running containers. It's a
`docker_cleanup` queue action (`reclaimStackNetworks`) like every other prune,
with its own button and an inline list of what's orphaned on the Docker Cleanup
page.

## Custom SSL certificates (`src/lib/services/docker/custom-ssl.ts`)

Per-service, only meaningful once the service has a domain outside this
instance's own base domain (Traefik's automatic ACME resolver can't cover
those), and never while the instance sits behind Pangolin (which serves
certificates itself). Cert/key PEM stored encrypted
(`service.customSslCertEnc`/`customSslKeyEnc`, same AES-256-GCM scheme as
`registryPasswordEnc`), edited on the Networking tab's SSL section.

`DockerService.syncCustomSslConfig(svc)` runs after every Networking save. It's
a **deliberate no-op unless `config.traefik.dynamicConfigDir` (env
`TRAEFIK_DYNAMIC_CONFIG_DIR`) is set**, this app never modifies the live Traefik
container's command/mounts itself (that's the same "don't touch infra without
the admin's own action" boundary as the build-server feature's Docker daemon
connections, just applied to Traefik instead). When it _is_ set, it decrypts the
cert/key and writes three files into that directory: `certs/<slug>.crt`,
`certs/<slug>.key`, and `<slug>-tls.yml` (a Traefik file-provider dynamic config
pointing at the other two), or removes all three if the cert's been cleared or
the domain's changed. **That directory is now wired by default**, so this is
only inert on an instance whose compose file predates it: every compose file in
this repo and the one the installer generates share a `traefik_dynamic` named
volume between the app (`/app/traefik-dynamic`, which the app's container
environment sets as `TRAEFIK_DYNAMIC_CONFIG_DIR`, the env fallback `config.ts`
reads when the YAML file has no `traefik.dynamicConfigDir`, and which the
generated `homerun.yaml` also points at) and Traefik (`/etc/traefik/dynamic`),
with `--providers.file.directory` and `--providers.file.watch` on. Local dev
(`compose.yaml`, app on the host) bind-mounts `./traefik-dynamic` into Traefik
instead, and `.env.example` sets `TRAEFIK_DYNAMIC_CONFIG_DIR=./traefik-dynamic`
to match (the directory is committed with a `.gitkeep` so Docker doesn't create
it root-owned on Linux). It used to be commented out with the admin expected to
wire a bind mount themselves, which meant custom SSL did nothing on a default
install. Traefik's file provider picks up changes on its own (`watch=true`), no
restart needed per certificate.

**Both certificate files hold the PEM inline** (`docker/tls-config.ts`'s
`tlsConfigYaml`, Traefik accepts the content itself in `certFile`/`keyFile`).
They used to point at `certs/<slug>.crt` paths as the _app_ saw them
(`/app/traefik-dynamic/...`), which Traefik, mounting the same volume at
`/etc/traefik/dynamic`, couldn't open; the old cert files are removed on the
next save.

**The instance certificate** (Settings → TLS, `instance_settings.tlsCertEnc`/
`tlsKeyEnc` plus `tlsCertNames`/`tlsCertExpiresAt`/`tlsCertIssuer` read off it
by `src/lib/tls-certificate.ts`'s `inspectCertificate`, which also checks the
key matches) is written by `syncInstanceCertificate` as
`homerun-instance-tls.yml`, the store's `defaultCertificate`. Traefik prefers a
router's resolver certificate over the default, so `certResolverFor` returns
null for any host `certificateCovers` (`config.traefik.instanceCertNames`,
applied from the settings row), which every label builder passes; routes change
on redeploy, and the tab offers `redeployCovered`. Verified against a real
`traefik:v3`: the inline default certificate is what `openssl s_client` gets for
a covered host.

## Redirects (`src/lib/redirects.ts`, `services/redirect.service.ts`)

The `redirect` table (source host plus optional path prefix, destination,
keepPath, permanent, enabled) is published as one file-provider file,
`homerun-redirects.yml`, rewritten whole by `RedirectService.sync()` after every
create/update/delete, on boot and on every instance-settings save. Pure
generation is `redirectsConfig` (JSON, valid YAML, so no serializer): a router
per enabled row with `noop@internal` and a `redirectRegex` middleware; a `$` in
the destination is doubled. No DNS automation: the operator points the source at
the server.

## The dashboard's own route (`syncDashboardRouter`, `docker/dashboard.ts`)

The same file provider is what makes the **Dashboard URL a real setting rather
than a compose variable**. The router that publishes this app itself is a set of
Traefik labels on its own container (`DASHBOARD_DOMAIN`, see the installer), and
**container labels are read only at creation**, so an app that can't recreate
itself can never honour a Dashboard URL typed into `/settings` : the host 404'd
at Traefik with nothing explaining why, and the only fix was editing compose by
hand. `DockerService.syncDashboardRouter()` writes `homerun-dashboard.yml` into
the dynamic-config directory instead : a router for
`dashboardHostFrom(config.auth.origin)` pointing at this container's own name on
the shared network (`selfContainer()`, found via the hostname Docker sets to the
container id, falling back to its IP), on `config.traefik.entrypoint`. It runs
from `hooks.server.ts`'s `init()` and from `applyAndRebuild()`, so every
settings save re-publishes it, and the file provider's `watch` means the change
is live with no restart of anything.

**The file route is always written, even when the container's own compose labels
route the same host** (`dashboardRouterPlan`). Traefik's Docker provider
inspects every container before building any route, so one container the daemon
is wedged on freezes every label route (a production incident took the dashboard
to 404 this way while swarm services kept working); the file provider needs
nothing from Docker. Two routers for one host don't race: the file router
carries `priority: 10000` (`DASHBOARD_ROUTER_PRIORITY`), far above the
rule-length default a label router gets, so it always wins, and both end at the
same app anyway. It targets the `homerun-auth` alias when the container has it
(the self-updater's candidate takes that alias over while the app container is
swapped, the same resilience the login wall's forwardAuth relies on), else the
container's name, else its IP, and Traefik resolves it per connection, so a
recreated app container is picked up with no rewrite. The candidate itself never
writes it (candidate mode starts no core-services watch).

What it skips: no Dashboard URL host, or an origin carrying an **explicit port**
(that instance is reached directly on it, not through Traefik : the installer's
IP-mode default), removes the file; a container it **can't inspect** (worker
down, dev outside Docker) leaves the file alone rather than taking a working
route away. An **IPv4 dashboard host** gets `tls: {}` rather than a cert
resolver because ACME can't issue for a bare IP. The matching `dashboard-router`
setup check (see `observability.md`) reports the file route as the healthy case
and a label-only route as working but not resilient.

Verified live: the encrypted round-trip, the no-op path when the dir is unset,
and, with a real directory configured, the three files actually landing with
correct byte-for-byte content, plus correct removal on clear. **Not verified**:
Traefik itself picking up the config, since that requires the live container
change this app deliberately doesn't make.

## Error pages (`docker/error-pages.ts`, `ErrorPageService`, `/homerun-error/[status]`)

`syncErrorPages` (called next to `syncDashboardRouter`, from settings saves and
the core-services watch) writes `homerun-error-pages.yml`: a catch-all
``PathPrefix(`/`)`` router at priority 1 with a `replacePath` to
`/homerun-error/404`, and the `homerun-errors` middleware (`errors`, `502-504`,
query `/homerun-error/{status}`). Both point at the forwardAuth origin
(`errorPagesTarget(config.authCheckUrl)`), not the app container, so it's
written even when `selfContainer()` can't be found. The file is never removed:
Traefik drops any router naming a missing middleware, so `buildContainerLabels`
only adds `homerun-errors@file` when `errorPagesPublished()` sees the file (and
never for a remote-host container). Existing services get it on their next
deploy, nothing forces a redeploy. Tested for real against `traefik:v3`: an
app's own 404 passes through, an app 503 and a dead backend get the page with
the status kept, and `X-Forwarded-Host` carries the original host on both paths.

The endpoint is a `+server.ts` returning one self-contained HTML document
(`renderErrorPage`, inline CSS and logo, no script): on an unrouted host every
path, `/_app` assets included, is rewritten to it. `hooks.server.ts` skips the
session lookup for it through `isAuthCheckPath`, since bots scanning the IP hit
it on every random host. A 404 checks whether any service routes the host
(`ServiceDTO.list` + `serviceHostnames`) to pick "not available yet" over
"nothing here". Branding lives in `instance_settings.error_pages` (jsonb,
`withErrorPageDefaults` fills blanks), edited under Settings → Error pages.
`syncAutoDns` runs in `prepareWorkerDeploy`, not after the deploy succeeds:
behind Pangolin, a host without its resource never reaches this Traefik, so the
catch-all couldn't show "not available yet" during a first deploy.

## Blocked paths, login wall paths and IP bans (`src/lib/path-patterns.ts`, `src/lib/ip-bans.ts`, `IpBanService`)

`service.blockedPaths`, `authPathsMode` (`all`/`only`/`except`) and `authPaths`
are routing labels, so saving them redeploys (`pathFiltersChanged` +
`DeploymentService.redeployForRouting`). Patterns become one Go regex per list
(`pathPatternsRegex`: `(?i)`, `*` → `.*`, segment-anchored `(?:^|/)…(?:/|$)`, or
`^/` with a leading slash) in a Traefik v3 `PathRegexp`; Go and JS share the
syntax, so the unit tests match paths with a JS `RegExp` of the same source.
`buildContainerLabels` gives each hostname's router up to three siblings with
explicit priorities, since the default (rule length) can't order two regex
rules: `_blocked` (9300) → `homerun-error-pages@file` through
`homerun-blocked@file` when `errorPagesPublished()`, else the service with a
deny-everyone `ipallowlist` (`<slug>_deny`, `127.0.0.1/32`); `_gate` (9200)
keeps the wall's callback and logout paths behind forwardAuth; `_paths` (9100)
carries forwardAuth (`only`) or is the ungated one (`except`). The plain router
keeps the default priority. **The `_` separator is load-bearing**: slugs are
`[a-z0-9-]`, so `<router>_blocked` can never equal another service's router
(`-blocked` collided with a slug `shop-blocked`). Every forwardAuth-less router
of a split wall carries `<slug>_strip-identity`, a `headers` middleware setting
`X-Homerun-User`/`-Email`/`-Name` to empty (which removes them), or a visitor
could forge the identity an app trusts. Redirect routers carry priority 9500
(`REDIRECT_ROUTER_PRIORITY`) so a redirect on a service's host still beats all
of these. Previews are forced to `all` (their own wall); canaries and
environments copy the parent's paths (`mirroredSettings` into
`ServiceDTO.create`).

`/homerun-error/blocked` (a `fallback` handler, exempt from the CSRF check like
everything under `/homerun-error/`, since scanners POST `wp-login.php` with no
`Origin`) serves the "blocked" page to anyone but **only counts a request
carrying Traefik's proof**: `homerun-blocked` is a chain of the `replacePath`
and a `headers` middleware setting `X-Homerun-Blocked` to
`blockedProofToken(auth secret)` (an HMAC of a fixed label), written into
`homerun-error-pages.yml`, which only Traefik reads; `validBlockedProof`
compares in constant time. Without it anyone reaching the app directly (its
published port, the dashboard host) could forge `X-Forwarded-For` and get any
address banned. With it, the address is Traefik's `X-Real-Ip`, else the last
`X-Forwarded-For` hop: Traefik strips both headers from an untrusted peer and
sets `X-Real-Ip` to that peer, so it's the remote address `ClientIP` matches,
except behind Homerun's own Newt. `syncNewt` sets
`--entryPoints.<entrypoint>.forwardedHeaders.trustedIPs` to Newt's container
addresses (`tunnelTrustFlags`), so Pangolin's `X-Real-Ip` (the visitor) survives
and the bans router matches `Header(X-Real-Ip, a)` too. Never trust Newt's whole
network: Docker's gateway is in it, and docker-proxy hands IPv6 visitors of a
published port over from the gateway, so anyone could name their own address.
Newt's address can change (a swarm task restarting); the trust is reapplied on
every `syncNewt` (worker boot, settings save), and a stale one only means the
tunnel is counted, never banned. Nothing is inserted for a request that can't
lead to a ban (no proof, bans off, an address `bannableIp` refuses, one already
banned), so `blocked_hit` rows per address are capped by the threshold.
`bannableIp` refuses private, loopback, link-local, CGNAT, multicast and
unspecified ranges (a Pangolin tunnel or Docker network) and Cloudflare's
published edge ranges (`CLOUDFLARE_RANGES`, banning an edge bans everyone behind
it; never trust `CF-Connecting-IP`, a client can send it). A ban is an `ip_ban`
row; `IpBanService.sync()` rewrites `homerun-bans.yml` (JSON) with one router,
`ClientIP(a) || …` minus the dashboard host, priority 2e9 (under Traefik's
32-bit max), `ipAllowList` deny, `noop@internal`, removed when nobody is banned.
`IpBanScheduler` lifts expired bans and drops hits older than a day every
minute; boot and settings saves resync. Settings live in
`instance_settings.ip_bans` (`withIpBanDefaults`, on, 10 hits / 10 min / 24 h),
edited under Settings → IP bans; the bans (with Unban) and the addresses being
counted (`BlockedHitDTO.addressesSince`, grouped per address over the window)
are on Monitoring → Blocked IPs. A new ban dispatches the `security.ip_banned`
channel event (`ipBanMessage`), off by default per channel. With
`instance_settings.crowdsec_url`/`crowdsec_machine_id`/`crowdsec_password_enc`
set (Settings → IP bans), `CrowdsecService` also posts each ban to that LAPI as
an alert carrying one `ban` decision shaped like `cscli decisions add`'s (origin
`cscli`, so every bouncer applies it; a ban for good is 87600h), and Unban sends
`DELETE /v1/decisions?ip=`, which drops CrowdSec's own decisions on it too. It
logs in as a machine (`/v1/watchers/login`, JWT cached until `expire`): bouncer
keys are read-only. Saving logs in first and refuses dead credentials. Expiry is
left to CrowdSec. Monitoring → CrowdSec (`monitoring/crowdsec` = Decisions,
`alerts/`, `blocklist/`, `new/`, sub-tabs through `SectionNav` in its
`+layout.svelte`, whose `+layout.server.ts` holds the settings-read guard and
whether it's set up) reads the LAPI live from a streamed `load`: a machine can't
`GET /v1/decisions` (bouncer only), so active decisions come from
`GET /v1/alerts?has_active_decision=true`, flattened by `decisionsFrom` (time
left is a Go duration, `goDurationMs`; simulated and expired ones dropped). Both
Decisions and Alerts pass `include_capi=false`: the LAPI includes the community
blocklist by default, one alert carrying 15,000 decisions, and a 4.6 MB answer
flattened to 30k rows killed the browser tab. The Community blocklist tab reads
`origin=CAPI` (never `origin=lists`, which took 53 s for nothing on a real
LAPI), flattened once and cached a minute in `CrowdsecService.blocklist` (a
delete clears it), searched in memory. Every list is paged server-side
(`parseListQuery`), so only one page reaches the browser. Delete is
`DELETE /v1/decisions/{id}`, New decision posts `banAlert`. `ban`/`unban` log
failures (`#push`), the page calls throw. Not verified against a live Traefik.

## Build servers (`remote_host` table, `RemoteHostDTO`, `/remote-hosts`)

**A registered remote host is a build server, nothing else.** Placement is
Swarm's job (see Swarm mode below): capacity comes from joining a node to the
swarm, not from pointing a service at a second daemon. `service.remoteHostId`,
the Settings tab's "Deploy target" picker, `resolveTarget`, `connectionFor` and
every remote branch in `deploy.service.ts`/`service-lifecycle.service.ts`/
`docker/reconcile.ts` were removed (migration `drizzle/0022_shiny_shiva.sql`).
Deploys run on the local daemon, or as a swarm service on the local manager.
What survives is `service.buildServerRemoteHostId`: a git-mode service can build
its image somewhere other than where it runs, which matters because a swarm
manager shouldn't have to also be the box with the build cache and the CPU
budget.

Two connection kinds (`remote_host.kind`, chosen on the "new host" form's
connection-type toggle), both real build servers:

- `"docker"` (the original/default): name + `tcp://host:port` [+ optional TLS
  client cert] or `ssh://user@host`, a raw Docker Engine connection, built with
  BuildKit in a `docker:cli` helper container on that daemon (see Build methods
  in `services-and-templates.md`).
- `"agent"`: name + `agentUrl`/`agentTokenEnc`, a registered Homerun Agent (see
  below) instead, token-authenticated HTTP rather than exposing the daemon
  itself, built through its own `POST /v1/build`. The token is verified against
  the agent (`AgentClientService.verifyToken`, which hits the authenticated
  `/v1/stats`) before the row is saved.

`RemoteHostDTO.resolveBuildTarget(hostId)` is the one place a host id becomes a
`RemoteExecutionTarget` (`{kind: "local"}` / `{kind: "docker", connection}` /
`{kind: "agent", connection}`); `deploy.service.ts` only resolves which kind of
target this deploy has, `deploy/worker-spec.ts`'s `buildServerSpec` folds the
target into the spec handed to the Go worker, and
`internal/jobs/deploy/build.go` is what actually opens the connection and runs
the build — for `kind: "docker"` that's `internal/dockerapi.NewRemote`
(`tcp://`, optionally TLS), for `kind: "agent"` its own `POST /v1/build`.
`RemoteHostDTO.listBuildServers()` is what the Source section's build-server
picker reads : every registered host qualifies, there's no per-host opt-in flag.
`services/docker/client.ts` (see Docker integration above) only keeps the
`RemoteHostConnection` shape for a `"docker"` host now, it doesn't open a client
itself; `RemoteHostDTO.toConnection()` decrypts the stored TLS material into
what `internal/dockerapi.RemoteHost` expects.

**A build server doesn't need a cache registry.** The built image lands on the
build server's own daemon, so it has to be brought across: with a registry
(`plan.registry` set), a `"docker"` host pushes and this host pulls the
published ref (an agent already pushed during `/v1/build`); without one, the
image is streamed straight from the build server's daemon into this one and
keeps its local `homerun-build-<slug>:<tag>` name. Both now live in
`internal/jobs/deploy/build.go`'s `transfer` (a `"docker"` host's
`dockerapi.Client.SaveImage` piped into `r.docker.LoadImage`, an agent's own
authenticated `GET /v1/images/save?ref=` streamed the same way, `remote` nil
distinguishing the two) — the Go port of what used to be
`docker/image-transfer.ts`'s `DockerImageTransferMixin.copyImageFromRemote` and
`AgentClientService.saveImage`, both deleted from the app. Scan targets then
only include the local copy. Not verified against a real remote daemon or agent.
The `git clone` runs on the build server for both kinds, in an `alpine/git`
container into a volume on that daemon
(`internal/agent/build.go`/`internal/agent/git.go`, now the single
implementation for a local build too, see Git-based builds in
`services-and-templates.md`), so the repo has to be reachable from the build
server.

## Dev workstations (`workstation` table, `WorkstationService`, `/workstations`)

A workstation is a long-lived browser IDE container (code-server by default)
with a persistent home volume, owned by one user: `WorkstationDTO`'s finders all
take the owner's `userId`, unlike the shared resources, and
`UserService.cleanupUserResources` removes a deleted account's workstations,
volumes included, through `WorkstationService.removeAllFor` instead of handing
them over.

**One Go implementation, two surfaces.** `internal/workstation`'s `Manager`
(`PUT`/`GET`/`DELETE /v1/workstations/{id}`, `POST .../stop`) is mounted on the
local worker's control API and on agent mode's API (`agent.NewServer`'s variadic
`mounts`), so `WorkstationService` only picks the client: `WorkerClient` for
this server, `AgentClientService.request` for an agent host. Agent mode stays
narrow on purpose: the spec is an image, env, a port, limits and its own named
volume, never a bind, a capability or privileged mode. A raw `"docker"` remote
host can't run one.

**The Go side is stateless apart from in-flight starts.** `PUT` answers 202 and
runs the start in a goroutine (pull if missing, ensure
`homerun-workstation-<id>`, force-remove any container labelled
`homerun.workstation.id=<id>`, create, start, then `git clone` by `exec` inside
the running container so the checkout belongs to its user and the home skeleton
the image ships still lands in the fresh volume). `GET` reports the in-flight
state (`pulling`/`starting`/`cloning`) or the failure, else the container's own.
A worker restart mid-start just loses the progress: the next `GET` reads the
container. Values reach the clone script as positional arguments only; the token
is redacted from any error.

**Routing.** Locally the app puts Traefik labels on the container (router and
service `workstation-<slug>`, so they never clash with a service router named
`<slug>`) and joins it to the Traefik network. On an agent the port is published
on an ephemeral host port, and `WorkstationService.view` (called by the
Overview's polled `workstationStatus` remote query) writes
`homerun-workstation-<slug>.yml` into `traefik.dynamicConfigDir` pointing at
`http://<agent hostname>:<port>`, only when the content changed, and drops it
when the workstation isn't running. With no dynamic config dir the page links
the published port directly. Either way `start` also runs `syncDns` on the
hostname (Pangolin SSO off, the IDE has its own password) and `remove` runs
`deleteDns`: behind Pangolin the hostname resolves to Pangolin, and without a
resource Pangolin serves its default certificate for it, which is what
"workstations aren't routed" was. A failed sync is thrown after the container
started, so it reaches the toast and `lastError`.

**Sign-in is the IDE's own password** (`passwordEnc`, passed as `PASSWORD`), not
the per-app login wall, whose gate is service-shaped (`gatedService`,
`AppAccessService`).

## Server enrollment (`node_enrollment`, `NodeEnrollmentService`, `/api/v1/nodes/`)

"Add a server" on `/remote-hosts` (admin only) creates a `node_enrollment` row:
the roles (`buildServer`, `swarmNode`), an optional name and the SHA-256 of a
one-time `hrn_` token, valid for an hour. The page shows
`enrollCommand(origin, token)`, which pipes `GET /api/v1/nodes/install.sh`
(`src/lib/server/node-install-script.ts`, generated with this instance's origin
and its own release tag so the agent matches the app) into bash. The script is
plain bash on purpose, a barebones server has no `jq`: it asks
`POST /api/v1/nodes/enroll` with `plan: true` what to install (the token decides
the roles, not script flags), installs Docker, runs the release installer in
`--mode=agent` for a build server and reads the worker's token file, then posts
again for real. `NodeEnrollmentService.enroll` verifies the agent
(`AgentClientService.verifyToken`) and swarm mode before claiming the token
(`claim` is a conditional `UPDATE ... WHERE used_at IS NULL`), so a failed
attempt can be rerun with the same token; losing the claim race deletes the
remote host it just created. A swarm-node enrollment answers with the worker's
`GET /v1/swarm/join` (`dockerapi.SwarmJoinInfo`: the worker join token and this
manager's own `RemoteManagers` address), and the script runs
`docker swarm join --advertise-addr`. The endpoints aren't in the OpenAPI
registry, same as the git webhook: they're machine-to-machine, token in the JSON
body (not `Authorization`, which `hooks.server.ts` reads as an API key).

The page's Swarm nodes table reads `DockerService.listSwarmNodes` (the worker's
`GET /v1/swarm/nodes`, flattened by `toSwarmNodeInfo`) and removes a worker node
with `DELETE /v1/swarm/nodes/{id}` (`force=true`). There's no load-based
autoscaling: capacity is added by running the command.
