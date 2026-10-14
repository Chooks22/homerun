# Data model, DTOs, config

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## The DTO layer (`src/lib/dto/`)

Every table is wrapped by a DTO class extending `BaseDTO<TRow>` (`base-dto.ts`):
a thin instance around one DB row that owns its own queries. Route files call
`ServiceDTO.get(id)`, `svc.update({...})`, `svc.delete()` etc. instead of
writing Drizzle inline, this is what "no raw SQL in page.server.ts" means in
practice, and it's also the layer a future REST/CLI API would sit on top of (not
yet built).

- `service-dto.ts`, `ServiceDTO`:
  `get`/`list`/`listByStack`/`listWithStackNames` (joins in `stack.name` for the
  grouped services list)/`listWithStackNamesPaged`/
  `listFilterFacets`/`slugTaken`/`create`/`update`/`delete`. See Server-side
  list pagination below for the paged/faceted pair.
- `stack-dto.ts`, `StackDTO`:
  `get`/`list`/`listWithServiceCounts`/`listWithServiceCountsPaged`/`create`/
  `update`/`delete` (row-only) /`cascadeDelete()` (stops+removes every member
  container, deletes deployments/services, deletes the stack row, then removes
  the stack's Docker network, the real "delete a stack" operation, see
  `stacks/[stackId]/settings/+page.server.ts`'s `delete` action). Removing a
  workload goes through `docker/workload-removal.ts`'s `tryRemoveWorkload` (a
  Docker 404 counts as gone); any other failure throws `WorkloadDetachError`
  before a row is touched unless `{ force: true }`.
  `ServiceLifecycleService.deleteService(svc, { force })` has the same contract,
  and is what the service Settings delete, the services list's single/bulk
  delete and `DELETE /api/v1/services/:id` (`?force=true`) all call; the two
  Settings pages turn the action's `fail(409, { detachFailed })` into a "Delete
  anyway" confirm.
- `template-dto.ts`, `TemplateDTO`: `get(id)` (built-in or custom, for
  deploy-from-template), `list`, `listPaged("builtin" | "custom", query)`,
  `listCategories`, `create`. Built-ins have `ownerId: null` and are seeded on
  boot (see below); a custom template's `ownerId` is its creator.
- `template-link-dto.ts`, `TemplateLinkDTO`: `listForTemplate(templateId)`
  (joined with the linked template's own image/tag/port/envVars/resources and
  runtime options as `linkedTemplateRuntime`, for both display and for actually
  deploying it), `countForTemplate`, `create`, `remove`. See Template links
  below.
- `deployment-dto.ts`, `DeploymentDTO`: `get`/`listForService`/`listRecent`
  (joins in service name/slug, for the
  dashboard)/`create`/`update`/`appendLog(line)` (appends to the live progress
  log, see below).
- `storage-volume-dto.ts`, `StorageVolumeDTO`:
  `get`/`list`/`listPaged`/`create`/`delete`, for the `/storage` page's volume
  sources.
- `service-volume-dto.ts`, `ServiceVolumeDTO`: `listForService` (joined with the
  volume's name/kind/source), `attach`/`detach`, the mounts of a StorageVolume
  into a service, shown on the service's Storage tab.
- `remote-host-dto.ts`, `RemoteHostDTO`:
  `get`/`list`/`listPaged`/`listBuildServers`/`create`/`update`/`delete`,
  `toConnection()` (decrypts TLS material into what the Go worker's
  `internal/dockerapi.RemoteHost` wants), and the static
  `resolveBuildTarget(hostId)` that turns a host id into the
  `RemoteExecutionTarget` a build's spec carries to the worker, see Build
  servers below.
- `s3-destination-dto.ts`, `S3DestinationDTO`:
  `get`/`list`/`listPaged`/`create`/`update`/`delete`, plus
  `decryptSecretAccessKey()` (for the S3 client only, never a `load` return
  value), a named, reusable S3 target several volumes can share, see S3 backups
  below.
- `backup-run-dto.ts`, `BackupRunDTO`: `create`/`finish`/`listForVolume`/
  `listRecent`/`listPaged` (joins in the volume's name), one row per backup
  attempt, the history behind `/backups`.
- `cron-job-dto.ts`, `CronJobDTO`: `get`/`list`/`listPaged`/`listEnabled`
  (unscoped by user, for the scheduler tick, same precedent as
  `ServiceDTO.listCronEnabled`)/`create`/`update`/ `delete`, and
  `cron-job-run-dto.ts`, `CronJobRunDTO`:
  `create`/`finish`/`listForJob`/`listRecent` (joins in the job's name), one row
  per cron job attempt with its captured output. See Cron jobs below.
- `image-scan-dto.ts`, `ImageScanDTO`: `create` (keeps the newest 25 per
  service, pruned on every insert)/`listForService`, one row per image scan. See
  Image scanning in the pipeline in `services-and-templates.md`.
- `build-cache-registry-dto.ts`, `BuildCacheRegistryDTO`:
  `get`/`list`/`listPaged`/`create`/`delete`, a shared registry credential a git
  build uses as its BuildKit registry cache
  (`--cache-from`/`--cache-to type=registry`), see Git-based builds in
  `services-and-templates.md`.
- `git-connection-dto.ts`, `GitConnectionDTO`: one user's OAuth authorization
  against one configured git provider, see Git provider connections below.
- `oauth-client-dto.ts`, `OauthClientDTO`: `list`/`get`/`getByClientId`/
  `setDisabled`/`delete`/`summary()`, reads over the `oauth_client` table only,
  a registered "Sign in with Homerun" app. Creating, editing and rotating a
  client's secret go through `OauthAppService` instead (better-auth's own admin
  endpoints own secret hashing), see Homerun as an OIDC provider in `auth.md`.
- `app-log-dto.ts`, `notification-dto.ts`, `user-preferences-dto.ts`,
  `instance-settings-dto.ts`, `invitation-dto.ts`, each covered by its own
  section below.

**`toJSON()` before returning from `load`**: DTO instances are server-only;
SvelteKit serializes `load` return values with devalue, which can't serialize a
class instance. Every `load` maps DTOs to plain objects via `.toJSON()` (or
`.map(d => d.toJSON())`) before returning.

## Server-side list pagination (`src/lib/server/list-query.ts`, `src/lib/server/api-pagination.ts`)

Every list page, and the three paginated REST endpoints below, share one
query-parsing layer instead of loading a user's entire table and
searching/filtering it in memory, which is what every list page (and the
services list's status-sync loop, see below) used to do, and what a handful of
history views (`/backups`) silently truncated to their newest N rows instead of
paging through.

- `list-query.ts`'s
  `parseListQuery(url, {filterKeys, pageParam, perPage, sortKeys}, userPerPage)`
  turns a request's `URL` into a `ListQuery` (`page`/`perPage`/`limit`/
  `offset`/`q`/`filters`, plus `active`, true when a search term or any filter
  is set, what a page uses to tell "you have nothing yet" apart from "nothing
  matched"). Page size precedence: the URL's `perPage`, then `options.perPage`
  (the REST API's fixed 100), then `userPerPage`, the signed-in account's
  `user_preferences.per_page` that every dashboard list `load` passes from
  `(await parent()).preferences.perPage`, run through `resolvePerPage` (one of
  `PER_PAGE_OPTIONS`, 25/50/100/200 in `src/lib/list-sorts.ts`, else
  `DEFAULT_PER_PAGE`, 50). Hard-capped at 200 regardless of what's requested;
  malformed/negative `page`/`perPage` fall back rather than erroring.
  `PagedResult<T>` (`{items, page, perPage, total}`) is the shape every paged
  DTO finder below returns. `searchCondition(q, columns)` builds a
  case-insensitive `ilike` `or(...)` across the given columns, escaping
  `%`/`_`/`\` in `q` first. `narrowFilter(values, allowed)` narrows raw URL
  strings down to a column's enum union, needed because `service.currentStatus`
  (`$type<ContainerStatus>()`) and `remote_host.kind` (a `text(..., {enum})`
  column) both reject a bare `string[]` passed to `inArray`.
- `api-pagination.ts`'s `parseApiListQuery(url)` is the same parser with a
  100/page default (API callers don't get the dashboard's per-account one);
  `jsonPage(items, meta)` wraps `Response.json()` and stamps
  `x-total-count`/`x-page`/`x-per-page` response headers, see REST API below for
  why the body itself stays a plain array rather than growing an envelope.
- Every paged DTO finder does its search/filter/count in SQL, not in memory, the
  row query and a `count()` query run in one `Promise.all`:
  `ServiceDTO.listWithStackNamesPaged` (+ `ServiceDTO.listFilterFacets`, every
  distinct status/stack the user actually has, so the filter pills stay stable
  no matter which page you're on), `StackDTO.listWithServiceCountsPaged`,
  `TemplateDTO.listPaged("builtin" | "custom", query)` (+
  `TemplateDTO.listCategories`), `StorageVolumeDTO.listPaged`,
  `RemoteHostDTO.listPaged`, `S3DestinationDTO.listPaged`,
  `BuildCacheRegistryDTO.listPaged`, `BackupRunDTO.listPaged`, and
  `UserService.listUsersPaged`. The old unpaged finders (`ServiceDTO.list`,
  `list`/`listRecent`/etc. on the others) stay, for internal callers that need
  every row regardless of the requesting user's current page: schedulers, Docker
  Cleanup, cascade-delete.
- `services/+page.server.ts`'s `load` used to call
  `DockerService.syncAllServiceStatuses` for every service the user owns on
  every page load, one Docker `inspect` per service, then re-run the full query;
  syncing only got scoped down to the current page's already-deployed services
  before it was cut from `load` entirely. **The sync is a remote function now**
  (`service-status.remote.ts`'s `syncServiceStatuses`, see "Remote functions" in
  `services-and-templates.md`): `load` just pages
  `ServiceDTO.listWithStackNamesPaged`, renders the stored `currentStatus`
  immediately, and the client patches it once the sync round-trips, rather than
  the page itself blocking on a Docker call.

**Verified live** against a seeded Postgres, in a real browser and over the REST
API/CLI: every list page pages correctly, search and filters reach the whole
table rather than the loaded page, selection is dropped when the page changes,
and out-of-range `page`/`perPage` clamp instead of erroring. `/backups` is the
one worth remembering: it previously capped at the newest 50 runs with nothing
in the UI saying so.

## Data model (`src/lib/server/db/schema.ts`)

better-auth-owned tables (`user`, `role` is `"admin"` | `"developer"`, see Auth
below, `session`, `account`, `verification`, `apikey`, `passkey`, plus the
OIDC-provider set `jwks`/`oauth_client`/`oauth_access_token`/
`oauth_refresh_token`/`oauth_consent`/`oauth_client_assertion` and the unused
`oauth_resource`/`oauth_client_resource`, hand-written from `getAuthTables()`
output since the drizzle adapter needs every column explicit; see Homerun as an
OIDC provider in `auth.md`) plus:

- `service`, image/tag, registry creds (`registryPasswordEnc`, AES-256-GCM),
  envVars (JSON), `secretEnvKeys` (jsonb `string[]`, migration 0065, the subset
  of `envVars`' own keys the owner marked secret in Environments & Deployments →
  Environment Variables; always redacted for the MCP server regardless of name,
  see the MCP server section in `auth.md`; `cron_job` has the same column with
  the same meaning), port/restart-policy/resource limits, `desiredState` (user
  intent) vs `currentStatus` (live reconciled Docker state), `containerId`,
  `stackId` (nullable FK, `onDelete: "set null"`),
  `cronEnabled`/`cronSchedule`/`cronLastRunAt` (opt-in scheduled redeploy, see
  below), `authRequired` + `authProviders`/`authAllowedUserIds`/
  `authAllowedEmails`/`authAllowedGroups` (the per-app login wall and its access
  policy, see Per-app login wall below), `buildSource` (`"image"` | `"git"`) +
  `gitUrl`/`gitRef`/`gitBuildContext`/`gitDockerfilePath` (see Git-based builds
  below, `image`/`tag` hold the resolved local build tag when `buildSource` is
  `"git"`, not user-editable directly in that mode), `gitProviderId`/`gitRepo`
  (the connected-account repo a git service was picked from, next to `gitUrl`) +
  `autoDeployOnPush`/`gitWebhookId`/`gitWebhookSecretEnc`/`gitWebhookError`
  (push-to-deploy, see Push-to-deploy in `services-and-templates.md`),
  `customSslCertEnc`/`customSslKeyEnc` (see Custom SSL certificates below),
  `requireStatusChecks` + `requiredStatusChecks` (jsonb `string[]`, git builds
  only, see Required status checks in `services-and-templates.md`),
  `autoRollback` (default false), `networkMode` (`"bridge"` default |
  `"host"`) + `portProtocol` (`"tcp"` default | `"udp"` | `"both"`) (see Network
  mode below), `buildCacheRegistryId` (nullable FK to `build_cache_registry`) +
  `buildServerRemoteHostId` (nullable FK to `remote_host`, build this service's
  image somewhere other than where it runs; `deploy.service.ts` rejects that
  unless a cache registry is also set, since a cross-host build has no other way
  to hand the built image over), both see Git-based builds below.
- `remote_host`, a registered build server: `kind` (`"docker"` | `"agent"`),
  `dockerHost` (`tcp://...` or `ssh://...`) plus optional
  `tlsCaEnc`/`tlsCertEnc`/`tlsKeyEnc` for the former, `agentUrl`/`agentTokenEnc`
  for the latter (all AES-256-GCM, same scheme as `registryPasswordEnc`). See
  Build servers below.
- `deployment`, history of deploy attempts: status, image digest, error message,
  timestamps, and `log` (text, default `""`), the live-appended progress log
  described above, kept after the deploy completes as an audit trail (shown as
  an expandable panel per row in the deployment history). A row that reached
  `running`/`stopped` with an `imageRef` is a **revision** (no separate table):
  `imageRef` (plain `image:tag`, never `@digest`), `imageDigest`, `imageId`
  (local image id, what the cleanup keep list resolves), `buildSource`,
  `gitCommit`/`gitRef`, `health` (`watching`/`healthy`/`unhealthy`/
  `rolled_back`, null before the watcher existed or once a newer deploy
  superseded a `healthy`/`watching` row) and `rollbackOfDeploymentId` (the
  revision a rollback redeployed, also what makes `deployService` take the
  `revision` plan). Migration 0038 backfilled `imageRef`/`buildSource` on each
  service's latest running row from the service's current image. See Revisions
  and rollback in `services-and-templates.md`.
- `service.domains` (text[], the service's own hostnames),
  `defaultDomainEnabled` (boolean, default true: whether
  `<slug>.<serviceDomain()>` is still routed) and `primaryDomain` (nullable, the
  main one), replacing the old single `customDomain`. `serviceDomain()`
  (`config.ts`) is the base domain, or `<serviceSubdomain>.<baseDomain>` once
  `instance_settings.serviceSubdomain` (Settings → General, "Services
  subdomain", one DNS label, DB-only) is set: every service hostname helper call
  takes it instead of `config.baseDomain`, which stays for the base domain's own
  uses (cookies, workstations' legacy fallback, core host suggestions). A save
  that adds an entry (a domain, or the default hostname a slug/stack change
  moves) goes through `serviceDomainConflicts` (`server/hostname-owner.ts`):
  core hosts, workstations and enabled redirects compare on the host, other
  services on the exact entry, so path entries can share a host.
  `DomainConflictError` (409) carries the conflicts; `takeOverDomains` (REST
  body, the Networking tab's "Take over and save") hands them to
  `takeOverDomains()` (`services/domain-takeover.ts`), which strips the entry
  from a service owner (default hostname or public routing off when that's all
  it had) or disables a redirect, then the saving service is redeployed. The old
  owner keeps its Traefik route until its own redeploy, which is what makes the
  move downtime-free. The REST routes answer that 409 with `err.body()`:
  `conflicts` as `{domain, owner, ownerKind, ownerId, canTakeOver}` beside
  `error` (the manifest route carries it through `ManifestError.body`), and the
  CLI's `decodeJSON` adds a `--set takeOverDomains=true` hint when `canTakeOver`
  is set. Previews (skip the templated domain), environments, canaries (refuse)
  and compose import (drop the domain) run the same `serviceDomainConflicts`,
  without a takeover; only redirects still check `ServiceDTO.domainTaken`. Each
  routed hostname gets its own Traefik router sharing the primary router's
  backend service, see labels.ts below. Pure helpers in
  `src/lib/service-domains.ts` (`defaultHostname`, `serviceHostnames`,
  `primaryHostname`, `isUnderDomain`, `normalizeDomains`). Configured on the
  service's Networking tab (Domains card).
- `stack`, name/description/userId/`slug` (unique, DNS-safe, prefixes every
  member service's container name and public subdomain, see Docker integration
  below). Every stack has a matching Docker network (see below), created
  alongside the row and removed on cascade-delete. Account deletion hands stacks
  over to another account (`UserService.cleanupUserResources`, see Shared
  resources below); only the last account's deletion removes their networks
  before `stack.userId`'s `onDelete: "cascade"` drops the rows. `parentId`
  (nullable self-FK, `onDelete: "set null"`) nests a stack inside another, to
  any depth; `StackDTO.setParent` refuses a cycle (`src/lib/stack-tree.ts`'s
  `wouldCycle`/`ancestorIds`). Nesting is purely a grouping/display
  relationship, not a network one: a substack keeps its own Docker network and
  its members' slugs are unprefixed by the parent, see Stack-scoped slugs in
  `services-and-templates.md` and Stacks in `routing.md`.
- `stat_sample`, one point on the resource graphs: `serviceId` (null = the host
  itself), CPU%, memory, the cumulative network counters and a timestamp,
  written every minute by `StatsSampler` and read back bucketed per range. See
  Recorded resource history in `observability.md` for why it's raw samples
  rather than rollup tables.
- `image_scan`, one row per scan of a service's image: `status` (`ok` | `failed`
  | `skipped`), `imageRef`, `digest`, `source` (which target answered: the
  mirror, this host, a build cache registry), `counts` jsonb per severity,
  nullable `fixableCounts` jsonb (same shape, findings with a fixed version,
  null on rows from before it existed), `findings` jsonb (top 200, most severe
  first), `totalFindings`, `error`, nullable `deploymentId` (`set null`, null
  for a Scan now), `serviceId` cascade. `instance_settings.imageScanEnabled`
  (null = on), `imageScanBlockSeverity` (null = off, `CRITICAL`/`HIGH`/
  `MEDIUM`/`LOW`), `imageScanBlockFixableOnly` (null = false) and
  `imageScanRequired` (null = false, fail the deploy when nothing could be
  scanned) plus `service.imageScanEnabled` (default true) are its settings.
  `instance_settings.retainedImagesPerService` (null = 5) is how many distinct
  images per service `retainedRevisions` keeps.
- `uptime_check`, one appended row per liveness probe per tick (the heartbeat
  strips read the last 40, "now" is the newest). See Uptime probes in
  `observability.md`.
- `status_page`, a published-or-private page grouping services: `scope`
  (`"global"` | `"stack"` | `"custom"`), nullable `stackId`, unique `slug`,
  `isPublic`. A `global`/`stack` page resolves its members **live** from
  `service` on every read, so a newly deployed service appears without editing
  the page; only a `custom` page reads `status_page_service`. See Status pages
  in `services-and-templates.md`.
- `status_page_service`, the explicit membership join for a `custom` page only,
  with a unique index on (`statusPageId`, `serviceId`).
- `notification_channel`, a destination Homerun posts lifecycle events to:
  `kind` (`"webhook"` | `"discord"` | `"email"`), `target`, `enabled`, `events`
  (jsonb `NotificationEvent[]`, DB default and DTO default
  `["build.failed","build.checks_failed","update.failed","deploy.unhealthy","deploy.rolled_back"]`;
  migration 0038 appended the three new events to existing channels already
  subscribed to a failure event), `lastError` (the last delivery failure, so a
  silently-broken channel is visible). Account-wide, no longer scoped to a
  status page (see Outbound notification channels in `observability.md`).
- `template`, image/tag/port/envVars/etc., `ownerId` nullable (null = built-in,
  seeded, immutable).
- `template_link`, a template linking to another template (a database, a cache,
  a worker, whatever) so deploying the first also deploys the second :
  `templateId` (the "primary"), `linkedTemplateId`, `alias` (unique per
  `templateId`, used both for display and as the `{{alias}}` token an env var
  can reference). See Template links below.
- `storage_volume`, a named local volume source: `kind` (`"bind"` | `"volume"`),
  `source` (an absolute host path for bind, or a Docker-managed volume name,
  Docker's own `Binds` syntax tells the two apart by whether it looks like a
  path). Its optional backup config is
  `backupEnabled`/`backupSchedule`/`backupPrefix`/`backupLastRunAt` plus
  `s3DestinationId` (nullable FK, `onDelete: "set null"`), the endpoint/bucket/
  region/credentials themselves live on `s3_destination`, not here, so several
  volumes can share one target, see S3 backups below.
- `s3_destination` (`S3DestinationDTO`), a named, reusable S3-compatible target:
  `name`/`type` (`s3` default, `sftp`, `smb`, `webdav`)/`endpoint`/`bucket`/
  `region`/`accessKeyId`/`secretAccessKeyEnc` (AES-256-GCM, same scheme as
  `registryPasswordEnc`), shared by every account, managed on `/s3-destinations`
  (labelled "Backup Destinations"; table, DTO, route and `s3DestinationId` kept
  their names). A non-S3 row reuses the S3 columns: `endpoint` is `host[:port]`
  or the WebDAV URL, `bucket` the path (smb: share, then optional path),
  `accessKeyId` the username, `secretAccessKeyEnc` the password or an sftp PEM
  key, `region` empty, see S3 backups in `jobs-and-queue.md`.
- `backup_run` (`BackupRunDTO`), one row per backup attempt (scheduled or manual
  "Run now"): `volumeId`, `startedAt`/`finishedAt`, `success` (null while still
  running), `sizeBytes`, `error`. Opened by the `backup`/`backup_restore` worker
  jobs' `prepare` step (`worker-jobs/backup.ts`/`backup_restore.ts`, see
  `jobs-and-queue.md`), the one place both the scheduler and the manual action
  funnel through, so every path gets a log entry including validation failures.
  Backs `/backups`; `storage_volume.backupLastRunAt` alone only ever remembered
  a timestamp.
- `cron_job` (`CronJobDTO`), a user-defined scheduled task, independent of
  `service.cronSchedule`: `name`/`description`/`schedule` (5-field cron)/
  `enabled` (off by default), `kind` (`"image"` | `"exec"`), `image`/`tag`/
  `command` (a shell command for `"exec"`, an optional override for `"image"`),
  `envVars` (JSON), `registryUrl`/`registryUsername`/`registryPasswordEnc`
  (AES-256-GCM, same scheme as `service.registryPasswordEnc`), `timeoutSeconds`
  (default 900), `lastRunAt`. See Cron jobs above.
- `cron_job_run` (`CronJobRunDTO`), one row per cron job attempt (scheduled or
  manual "Run now"): `startedAt`/`finishedAt`, `success` (null while running),
  `exitCode`, `output` (stdout+stderr, last 64k characters), `error`. Same shape
  as `backup_run`, plus what the command printed.
- `build_cache_registry` (`BuildCacheRegistryDTO`), a shared container registry
  credential (`registryUrl` with no scheme, `username`, `passwordEnc`) used only
  as a build cache source/destination, not as a deploy image source, managed on
  `/build-cache-registries`. See Git-based builds below. Editable in place from
  `/build-cache-registries/[registryId]` (`update()`, with a blank password
  meaning "keep the stored one", the same convention the SMTP password field
  uses); it was create-and-delete-only before, so fixing a typo meant re-adding
  it and re-picking it on every service that used it.
- `service_volume`, join table: one mount of one `storage_volume` into one
  `service` (`containerPath`, `readOnly`). A volume becomes "shared" simply by
  being mounted into more than one service, no separate stack-volume concept.
- `service_dependency` (`ServiceDependencyDTO`), one service explicitly
  depending on another (`serviceId` → `dependsOnId`, both cascade, unique per
  pair), written by every service link and by compose import's `depends_on`.
  Drives start order; see Linking in `services-and-templates.md`.
- `registry_token` (`RegistryTokenDTO`), a push/pull credential for the built-in
  registry (`homerun-mirror`, see Registry in `docker.md`): `username` (unique)
  plus a bcrypt `secretHash` (`Bun.password.hash`), the only hash registry:2's
  htpasswd auth accepts. The plaintext secret is returned once from
  `RegistryService.createToken()` and never stored.
- `instance_settings.onboardingCompletedAt`, nullable timestamp, non-null once
  the onboarding wizard (see Onboarding below) has run. Not part of the
  config-override merge in `config.ts`, it's onboarding-flow state, not an
  instance config value, unlike every other column on this table (see Instance
  settings below).
- `invitation`, a pending admin-sent invite (`InvitationDTO`, not
  better-auth-owned so it's a normal DTO): `email`, `role`, `token` (unique, 32
  random bytes hex), `invitedByUserId`, `expiresAt` (7 days), `acceptedAt`
  (nullable, null means still pending). See User roles & invitations below.
- `app_log` (`AppLogDTO`), persisted warn/error-level `Logger` output: `level`,
  `scope`, `message`, `metadata` (JSON-stringified extra log args), `serviceId`
  (nullable, heuristically populated, see below). Backs the "Application errors"
  section of a service's Observability → Events, a lightweight Sentry-adjacent
  view of app-level failures alongside deployment failures (see
  `services/[serviceId]/observability/events/` below).
  `Logger.warn()`/`.error()` (`src/lib/logger.ts`) fire-and-forget a
  `AppLogDTO.create()` call on every warn/error log, dynamically imported (not a
  top-level import) since `logger.ts` isn't under `src/lib/server/`, keeping
  server-only db code out of the module graph unless a warn/error call actually
  fires; never awaited, never throws, so a logging call can't fail the operation
  it's logging. `serviceId` is extracted by regex-matching this codebase's own
  `service=<uuid>` convention already present in most Docker/deploy log
  messages, rather than threading an explicit serviceId through every existing
  call site, a log with no match is still visible on a future instance-wide log
  view, just not attributed to one service's Events section.
  `AppLogDTO.create()` amortized-prunes the table back to the newest 5000 rows
  on ~2% of writes, rather than adding a third scheduler alongside
  `CronService`'s two.
- `notification` (`NotificationDTO`), a curated lifecycle event feed, one copy
  per account (deploy success/failure, service created/started/stopped,
  auto-redeploy, runtime error), deliberately separate from `app_log` above, see
  In-app notifications below.
- `instance_settings.orchestrationMode` (`"standalone"` | `"swarm"`, null reads
  as standalone; a fresh database stores swarm when the daemon is a rootful
  swarm manager, see Swarm mode in `docker.md`), plus
  `service.replicas`/`swarmServiceId`. `pendingServiceRedeploy` is set by the
  installer's `--migrate-to-rootful` and consumed on boot.
- `instance_settings.cloudflareApiTokenEnc`/`cloudflareZoneId` and
  `pangolinApiBaseUrl`/`pangolinApiTokenEnc`/`pangolinOrgId`/
  `pangolinMainSiteName`/`pangolinTargetPort`, optional DNS automation, see DNS
  automation below.
- `instance_settings.registryAuthEnabled`/`registryPublicHost`/
  `registryInternalSecretEnc` (AES-256-GCM, same scheme as
  `service.registryPasswordEnc`), the built-in registry's own auth toggle,
  Traefik hostname and reserved internal token, see Registry in `docker.md`.
- `user_preferences` (`UserPreferencesDTO`), one row per user, `userId` itself
  as the primary key (a genuine 1:1 extension of `user`, not a singleton like
  `instance_settings`): `theme` (`"light"` | `"dark"` | `"system"` default),
  `accentColor` (nullable hex string, null = the built-in bordeaux), `perPage`
  (not null, default 50, the account's default list page size, see Server-side
  list pagination above). See Appearance preferences below.

**Postgres enforces the schema's `onDelete: "cascade"`/`"set null"` FK
constraints for real.** (This app ran on SQLite until the Postgres conversion
below, SQLite's `PRAGMA foreign_keys` was intentionally left off there, making
`onDelete` decorative for row data; Postgres has no equivalent global disable,
so it's now a genuine DB-level safety net, not just documentation.) Explicit
app-level cascade logic still exists and is still required,
`StackDTO.cascadeDelete()` and `src/lib/services/user.service.ts`'s
`UserService.cleanupUserResources()` (account deletion, see User roles &
invitations in `auth.md` for why that had to be pulled out of `auth.ts`'s
`beforeDelete` into its own method rather than left inline), because a DB
constraint can't stop/remove a real Docker container or network, and because
every `userId` FK being `onDelete: "cascade"` would otherwise delete shared rows
another account still uses.

## Shared resources (no `userId` scoping)

Every account sees and manages every resource. The finders on `service`,
`stack`, `storage_volume`, `backup_run`, `s3_destination`,
`build_cache_registry`, `remote_host`, `cron_job`, `cron_job_run`, `status_page`
(its `global` scope is every service on the instance), `uptime_check`,
`deployment`, `job` and `template` take no `userId`: `get(id)`, `list()`,
`listPaged(query)`, `search(q, limit)`. Their `userId` (`ownerId` on `template`,
where null still means built-in) only records who created the row, and git
builds use that account's git connection. Personal data stays scoped by
`userId`: sessions, API keys, `user_preferences`, `git_connection`, terminal
sessions, `notification` (the bell) and `notification_channel`. Events fan out
instead: `NotificationDTO.notify`/`notifyServiceError` insert one row per
account (`broadcast`), and `NotificationChannelService.dispatch(message)` sends
to every account's enabled channels subscribed to the event. A new table with a
`userId` FK needs a line in `UserService.cleanupUserResources`, which reassigns
shared rows to the acting admin (or another admin, or any other account on
self-delete) before the user row cascades.

Migrations are incremental under `drizzle/`, Postgres dialect (`0000` is the
full-schema baseline generated at the SQLite→Postgres conversion, see below,
every table in one migration, not the original per-feature history). Mid-session
schema changes get applied directly via a one-off script using
`drizzle-orm/bun-sql/migrator`'s `migrate()` against a live Postgres connection,
without needing to restart the dev server. **Adding a NOT-NULL column to a table
that already has rows**: Postgres's `ALTER TABLE ADD COLUMN NOT NULL` requires a
`DEFAULT` (or a two-step add-nullable-then-backfill-then-set-not-null), same
shape of problem SQLite had, different exact syntax; the ORM-level `notNull()`
in `schema.ts` is what matters for new rows going forward either way
(app-enforced). **Changing the meaning of an existing nullable column**:
back-fill by hand too, don't assume a nullable/already-populated column is fine
to reinterpret without a data pass.

**SQLite → Postgres conversion, real/tested**: this app originally ran on
`bun:sqlite` (a single `database.db` file, zero setup), converted to Postgres
(via Bun's built-in `SQL` client, `drizzle-orm/bun-sql`, no `pg` npm dependency)
because a real multi-writer-safe, backup/replication-friendly DB was worth the
extra `docker compose up -d` step, and jsonb/native boolean/timestamp types are
a better fit for this schema than SQLite's affinity typing. Verified live
against a real (scratch, disposable) Postgres container, not just reasoned
about: the generated migration applies cleanly; insert/select round-trips
returned real `Date` objects and real `boolean`s (not the `0`/`1`/epoch-int
values `bun:sqlite` mode-typed columns produced); `jsonb` columns
(`instanceSettings.oauthProviders`, `template.envVars`, `service.envVars`)
round-tripped as parsed objects/arrays with no manual `JSON.parse`/`stringify`
needed on either side, same as before. **That round-trip hides a trap**: the
bun-sql driver double-encodes on write, so every `jsonb` value is stored as a
JSON _string_ (`jsonb_typeof` is `string`), and Drizzle only parses it back on
read. Any SQL-side jsonb operator (`@>`, `->`, `?`) therefore silently never
matches. Filter in code after the select instead: a real bug where
`NotificationChannelDTO.listSubscribed` used `@>` and no channel ever received a
deploy notification. `seed.ts`'s `onConflictDoNothing()` is idempotent on
Postgres the same way it was on SQLite; `StackDTO.cascadeDelete()`'s
child-before-parent deletion order (deployments, then services, then the stack
row) was already FK-safe by inspection, so real FK enforcement doesn't break it.
**Not carried over automatically**: any data in a pre-conversion `database.db`,
this was a schema/dialect switch, not a data migration; a fresh Postgres
database starts empty (migrations + `seedBuiltinTemplates()` on first boot, same
as before).

`src/lib/server/db/seed.ts`, `seedBuiltinTemplates()`, called from
`hooks.server.ts`'s `init()` on every boot (idempotent, fixed ids like
`"builtin-redis"`, `.onConflictDoNothing()`).

**Real, tested finding**: `hooks.server.ts`'s `waitForDatabase()` (retries a
trivial `select 1` up to 10 times, 2s apart, before `init()` proceeds to
migrations) used to `throw` once it exhausted its retries. SvelteKit's own
dev-mode handling of a thrown server `init()` hook doesn't crash the process, it
silently leaves the server in a broken state where every subsequent request just
hangs/fails with no useful error, rather than either recovering or exiting
loudly. Fixed by calling `process.exit(1)` instead once retries are exhausted,
so an unreachable Postgres at boot fails fast and visibly (a restart loop under
`docker compose`/systemd, a hard failure locally) instead of leaving a
half-started server up that looks alive but answers nothing correctly.

## Config (`src/lib/config.ts`)

Zod-validated YAML config, not env vars, except `DATABASE_URL`/`AUTH_SECRET`/
`PORT`/`CONFIG_FILE` (env-only, needed before the file/DB are reachable), plus
`STORAGE_BASE_PATH` (`config.dataDir`, default `./data`, `/app/data` in the
image: the app's on-disk cache, today only Dashboard Icons). `CONFIG_FILE`
(default `./homerun.yaml`) points at the YAML file; missing file = all defaults,
every field optional. `yamlConfigSchema` is the file's own schema (exported so
`scripts/generate-config-schema.ts` can turn it into `homerun.schema.json`, a
JSON Schema `homerun.example.yaml` references via a
`# yaml-language-server: $schema=` comment for editor linting); `configSchema`
extends it with the env-only fields for the full `AppConfig` type. Notable
groups: `docker.{socketPath,networkName}`, `baseDomain`,
`traefik.{entrypoint,certResolver}`, `auth.{origin,secret}`, `smtp.*`. See
`docs/configuration.md`.

`config.auth.secret` reads `AUTH_SECRET` **falling back to
`BETTER_AUTH_SECRET`**, don't collapse this to one var without checking both are
honored. Env values go through `firstNonBlank()`, so an empty `AUTH_SECRET=` (as
`.env.example` ships it) falls through to `BETTER_AUTH_SECRET` and then the
`default-secret` placeholder rather than signing with an empty key;
`isPlaceholderAuthSecret()` is what the setup check and onboarding test against.
`auth.oauthProviders` is deliberately **not** in the YAML schema: the
Authentication page edits the DB column only, so a file value could never be
removed from the UI.

`config` is a single stable object every other module imports and reads
properties off live, the file+env-parsed values are captured once into a private
`fileDefaults`, then `config` starts as a clone of that and is **mutated in
place** (never reassigned) by `applyInstanceSettings(override)`. See Instance
settings below for who calls that and when.

## Instance settings (DB-backed) (`instance_settings` table, `InstanceSettingsDTO`, `/settings`)

Most of `config`, OAuth providers, Docker socket/network defaults, Traefik
entrypoint/cert-resolver/dynamic-config-dir, SMTP, and core settings (base
domain, origin, the auth-check URL, cross-subdomain cookies), is now
live-editable from the dashboard, not just env vars. All of it lives on
`/settings` except the OAuth providers, which moved to their own top-level
`/authentication` page (see Authentication page below) — `/settings` therefore
has four tabs now (General, Docker, Networking, Email), not five.
`instance_settings` is a **singleton row** (`InstanceSettingsDTO`, id always
`"default"`, auto-created on first read): every column is nullable, `null`
meaning "fall back to the env default", a non-null value overriding it. Secrets
(`smtpPasswordEnc`, each OAuth provider's `clientSecretEnc` inside the
`oauthProviders` JSON array) use the same AES-256-GCM scheme as
`service.registryPasswordEnc` (`src/lib/services/secrets.ts`, reused as-is).

**Not DB-backed**, `databaseUrl`/`port`/`auth.secret`/`logLevel`/`logFormat`
stay env-only: `databaseUrl` has to be known before the DB is even reachable,
and `auth.secret` is the key every `*Enc` column's encryption derives from, so
DB-backing it would be circular.

`InstanceSettingsDTO.toConfigOverride()` decrypts every stored secret and
returns the plain-value shape `applyInstanceSettings()` merges over
`envDefaults`. This runs twice: once in `hooks.server.ts`'s `init()` at boot
(before the server accepts any request, so DB-backed settings are in effect from
the very first request, not just after a save), and again at the end of every
`/settings` action, so a saved change is live immediately, no restart, for every
section including OAuth (see Auth below for how that one specifically applies
live). `/settings` itself is split into one route per tab (bare `+page.svelte` =
General/Core, `docker/`, `networking/`, `email/`, see the tabs convention under
Conventions above), so this apply-plus-rebuild pair is pulled into a shared
`applyAndRebuild(settings)` helper
(`src/lib/server/validation/instance-settings-form.ts`, alongside
`nullableText`/ `checkbox` form-parsing helpers every tab's actions use), each
tab's own action calls it rather than duplicating the two calls per file.

`config.ts` deliberately never imports the DTO or `db` itself, `db/lib.ts`
imports `config.ts` for `databaseUrl`, so `config.ts` has to stay a leaf module
or the two would form a circular import. The DB-reading glue lives in
`hooks.server.ts` and `settings/+layout.server.ts` instead, the latter now
shared across every tab (fetches `InstanceSettingsDTO.get()` once, plus the
setup-issue-banner deep-link redirect described below).

**Real, tested finding from building this**: a bad OAuth provider
(unreachable/invalid discovery URL) isn't just a broken login button,
better-auth's `genericOAuth` plugin validates every configured provider's
discovery document while building its auth _context_, which every request
touching auth goes through, including plain `getSession()` on every page load
and even email/password sign-in. Saving one unvalidated **locked the whole app
out**, `/settings` included, with no way back in short of editing the DB
directly, verified live. Fixed two ways:
`settings/authentication/+page.server.ts`'s `updateOauth` action fetches and
validates each provider's discovery document (must return 200 with a JSON body
containing an `issuer`) _before_ persisting anything, rejecting the save with a
clear error otherwise, deliberately **not** the "warn, don't block" precedent
the image-existence checker uses, since the failure mode here is total lockout
rather than one broken service. And as defense in depth against any other cause,
`hooks.server.ts`'s `authHandler` wraps `auth.api.getSession()` in a `catch`
that degrades to "no session" on any error rather than letting it 500 every
request, so even if auth context construction fails for some other reason, the
rest of the app (and `/settings`, to fix whatever's wrong) stays reachable, just
signed out.
