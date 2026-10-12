# Job queue, schedulers, backups

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Job queue and worker (`job` table, `JobDTO`, `src/lib/services/queue.service.ts`, `src/lib/services/queue/`)

Every long-running, side-effecting operation in this app, deploys (including git
builds), volume backups, user-defined cron jobs, and host-wide Docker cleanups,
goes through one DB-backed queue drained by one in-process worker, instead of
running inline in whichever request or scheduler tick happened to trigger it.
That's what makes "five pushes in a minute" collapse into one build, what stops
two deploys of the same service racing each other, and what keeps a
`docker prune` from sweeping layers out from under a running build.

- **`job` table / `JobDTO`** (`src/lib/dto/job-dto.ts`) is the queue itself.
  Beyond the obvious (`type`, `payload` jsonb, `status`, `attempts`/
  `maxAttempts`, `runAt`, `error`, `result`, `title` for the UI), four columns
  carry the whole scheduling policy, and `JobDTO.claimNext()` is the one place
  they're interpreted:
  - **`dedupeKey`** collapses repeats. A partial unique index
    (`job_type_dedupeKey_queued_uidx`, `where status = 'queued'`) makes it a
    real DB-level constraint, not a check-then-insert race : a second
    `deploy:<serviceId>` while one is still waiting its turn is rejected by
    Postgres, and `QueueService.enqueue()` returns the already-queued job
    instead. Once that job starts running the key frees up, so a push landing
    mid-build still queues a follow-up build rather than being lost.
  - **`lockKey`** serialises. Only one _running_ job may hold a given key, so
    `service:<id>` means one deploy per service at a time while other services
    deploy in parallel.
  - **`dependsOnJobId`** orders a chain. A job is only claimable once its
    dependency has actually `succeeded`; if that dependency fails permanently,
    `JobDTO.cancelDependents()` cancels the rest of the chain transitively
    rather than leaving it queued behind something that will never finish. This
    is what replaced the sequential `await deployService()` loop that used to
    bring a template's linked stack up in order inside the request handler (see
    `DeploymentService.enqueueStackDeploy`).
  - **`exclusive`** is the host-wide barrier, used by Docker cleanup. An
    exclusive job runs alone (nothing else is claimed while it runs, and it
    waits for whatever is already running), and while one is _queued_ nothing
    else is claimed either, so it can't starve behind a steady trickle of
    deploys. The deliberate consequence, verified rather than assumed: a queued
    prune takes precedence over already-queued deploys, and only waits on
    in-flight ones. The reverse rule would block a waiting admin behind an
    unbounded deploy backlog.

  The claim itself is one `for update skip locked` select inside a transaction,
  so two concurrent claimers pick two different rows rather than racing for the
  same one.

- **`QueueService`** (`src/lib/services/queue.service.ts`) is the enqueue/wait
  API every caller uses : `enqueue()` (with the coalescing described above),
  `wait(jobId)` (poll to a terminal status, for the two callers that must keep
  their synchronous contract), plus the list helpers the Scheduling page reads.
- **`JobWorker`** (`src/lib/services/queue/worker.ts`) is a fourth
  `BaseScheduler` subclass alongside the three cron schedulers, overriding
  `intervalMs` to a 1s poll (`BaseScheduler` gained both that knob and a
  non-overlapping-tick guard for this). Started from `hooks.server.ts`'s
  `init()`. Each tick claims up to `MAX_CONCURRENT_JOBS` (3) jobs, claiming
  _serially_ so each claim sees the previous one's committed `running` row (a
  parallel batch of claims would each run in its own uncommitted transaction and
  could hand out two jobs sharing a `lockKey`). On the first tick and every 30s
  after it calls `JobDTO.requeueOrphaned(inFlightIds)` : this app runs one
  worker, so a row still `running` in an app-side stage (none, `prepare`,
  `finalizing`) that isn't in this process's `#inFlight` set was left there by a
  process that died (at boot) or by a job whose own bookkeeping threw
  (`markFailed` on a dead connection, later), and is put back on the queue.
  Before it ran every 30s, the second case sat in `running` until the next
  restart and blocked self-update ("1 job(s) are running") forever. The sweep is
  safe against the claim path because ticks never overlap and `#dispatch` adds
  to `#inFlight` synchronously after `claimNext` returns. `runJob()` is public
  specifically so `tests/unit/app/queue.test.ts` can drive the
  succeed/retry/permanently-fail decision without an interval.
- **Go-executed job types** skip any in-process handler: a non-null module in
  `src/lib/services/queue/worker-jobs/`
  (`src/lib/services/queue/worker-jobs/index.ts`'s `workerJobs`) makes `runJob`
  run its `prepare` step and hand the job to the Go worker, and the tick's
  finalize pass runs its `finalize` step once the worker reports back. See
  `worker.md`. **Every heavy job type is Go-executed now** : `deploy`
  (`worker-jobs/deploy.ts`, wrapping `DeploymentService`'s
  `prepareWorkerDeploy`/`finalizeWorkerDeploy`), `backup`/`backup_restore`,
  `cron_job`, `docker_cleanup`, `image_scan`. Only `notification_delivery` still
  runs fully in-process.
- **`src/lib/services/queue/handlers.ts`** maps a `JobType` to an in-process
  handler for whatever's left : `notification_delivery` →
  `NotificationChannelService.retryDelivery`, and `core_service` (turning the
  built-in object store on or off, publishing it, the Docker registry's auth and
  public hostname), queued by `enqueueCoreServiceJob`
  (`src/lib/services/core-service-queue.ts`, one `lockKey` per service so its
  changes run in order) and logged line by line with `JobDTO.appendLog`. The
  form actions run the cheap checks first (`builtinPublicHostProblem`,
  `authProblem`, `publicHostProblem`) so a typo fails at once, then return the
  `jobId`; `queuedJobToast` (`src/lib/job-toast.ts`) turns that into a "View
  task" button opening `/scheduling/jobs/[jobId]`
  (`jobHandlers: Partial<Record<JobType, JobHandler>>`, so a Go-executed type
  simply has no entry). A handler still parses its own payload through a zod
  schema in `queue/payloads.ts` rather than casting : a payload written by an
  older version of the app fails as a clean job error instead of deep inside
  whatever it touches. Throwing is how a handler reports failure.

**What changed at each trigger point.** `DeploymentService`'s pipeline is now
split across the prepare/execute/finalize stages (see `worker.md`) rather than
running inline as one function, but it's still the single source of truth; what
moved is _who calls it_. `DeploymentService.enqueueDeploy()` creates the
`deployment` row up front with status `"pending"` (and sets the service's
`currentStatus` to match) and queues the job, so the Overview tab's existing
progress polling, which already treated `pending` as in-flight and already
resumes from `svc.currentStatus` after a reload, works unchanged for a deploy
that hasn't started yet. `prepareWorkerDeploy()` reuses an existing deployment
row when handed its id instead of always creating one.

**The Overview tab's progress polling had to grow two things for this**, both
real bugs found by driving a template quick-deploy in a real browser rather than
by reading the code. It now `refreshAll()`s on every status transition and once
more at the end : the header status pill and the deployment-history rows come
from `load`, not from the progress endpoint, so a deploy started _somewhere
else_ (a quick-deploy, the create wizard, cron) left them frozen at whatever
they were when the page loaded, and only a manual reload caught up. And
`onMount` resumes from the latest deployment row's own `status`, not just
`svc.currentStatus` : on a redeploy the layout's `syncServiceStatus` inspects
the still-running _old_ container and writes `"running"` back over the in-flight
`"pending"`, so the service-level check alone could miss a deploy that really
was in flight. The progress panel also renders while
`pendingAction === "deploy"` even with zero log lines yet (a queued job, or a
pull that hasn't emitted a status change), showing "Waiting for the deploy to
start…" rather than nothing, and the "this service hasn't been deployed yet"
banner is suppressed during a first deploy.

- Service Overview's `deploy` action, `services/new`'s `createAndDeploy`, the
  templates gallery's `quickDeploy` and the cron redeploy scheduler all enqueue
  and return immediately. The two create-a-service-and-deploy-it paths no longer
  block the request on a real image pull at all, which is what makes the
  redirect land on the service page with live progress instead of a spinning
  button.
- `POST /api/v1/services/<id>/deploy` enqueues _and_ `QueueService.wait()`s, so
  its "returns once the deploy is done" contract (and therefore
  `homerun services deploy`) is unchanged, verified by `tests/integration/`'s
  real deploy tests still passing untouched.
- The Docker Cleanup page's actions enqueue and return the `jobId` (via
  `queueCleanup` in `src/lib/services/docker-cleanup-queue.ts`), like every
  other dashboard-triggered job; the toast's "View task" opens the job's page,
  which shows the reclaimed-space summary (`describeCleanupResult`,
  `src/lib/cleanup-result.ts`) next to its log.
- `job.worker_version` records which build ran a job: the Go worker stamps
  `buildinfo.Version` when it claims one (`PGStore.Claim`), the app stamps
  `APP_VERSION` before running an in-process handler. Unlike `worker_id` it's
  kept after the job finishes, for the job list and the job page.
- Backups (`/backups`'s and `storage/[volumeId]`'s "Run now", plus the backup
  scheduler) enqueue and return : a tar-and-upload could comfortably take a
  while, so the request just returns. The `backup_run` row is opened by the
  `backup`/`backup_restore` worker jobs' `prepare` step
  (`worker-jobs/backup.ts`, `S3BackupService.backupSpec`) when the job is
  claimed, not when the app enqueues it.

**Retries** are per job type (`maxAttempts`, default 1) with exponential backoff
: backups get 2 attempts, a notification channel delivery retry gets 4 (queued
30s after the inline attempt failed, see Outbound notification channels in
`observability.md`), deploys and cleanups get one, since a failed deploy is
something the user should see and decide about rather than have silently
retried. Finished rows are amortized-pruned after 7 days on ~2% of inserts, the
same convention as `AppLogDTO`/`NotificationDTO`.

**Visibility** is the Scheduling page's new "Job queue" section
(`src/lib/components/job-queue-panel.svelte`, which loads itself through
`src/lib/remote/jobs.remote.ts` rather than taking props off that page's `load`,
running/queued plus the last 15 finished, refreshing itself every 3s while
anything is active).

**Verified against real Postgres**, not just reasoned about : a throwaway
database driven through `JobDTO` directly covered dedupe/coalescing, the lock
key skipping a same-service job while claiming another, dependency gating and
transitive cancellation, both directions of the exclusive barrier, priority
ordering, `runAt` gating and retry rescheduling, orphan requeue, and eight
racing `claimNext()` calls handing out five jobs exactly once each. The
browser-level flow was verified live too : a real template quick-deploy against
an isolated instance, driven through Playwright, lands on the service page with
the progress panel already streaming, no stale "not deployed yet" banner, and
the status pill reaching RUNNING with no manual reload. The API-level end-to-end
path is covered by `tests/integration/` (real image pulls, real containers,
local deploys, git builds, and the failure path) passing unchanged through the
queue, and the policy layer by `tests/unit/app/queue.test.ts`.

## Schedulers (`src/lib/services/cron.service.ts`, `src/lib/services/cron/`)

`CronService` (`cron.service.ts`) composes three instances of one generic
`DueScheduler<T>` (`cron/due-scheduler.ts`), one per scheduled concern: cron
redeploy (`ServiceDTO.listCronEnabled()` → `DeploymentService.enqueueDeploy`),
volume backup (`StorageVolumeDTO.listBackupEnabled()` → `enqueueVolumeBackup`)
and user cron jobs (`CronJobDTO.listEnabled()` → `enqueueCronJobRun`, see Cron
jobs above). All three were separate near-identical classes before; the config
object (`list`/`schedule`/`lastRunAt`/`markRun`/`fire`/`describe`/`label`) is
the only thing that actually differed. Each `list()` is unscoped by user, since
a scheduler isn't running on behalf of a request. Due-checking is
`cronMatches(schedule, now)` plus a `sameMinute(lastRunAt, now)` guard against a
double-fire within one matching minute.

A fourth scheduler doesn't fit `DueScheduler` and extends `BaseScheduler`
directly: `StatsSampler` (`src/lib/services/stats/stats-sampler.ts`) has no
schedule expression and no per-row `lastRunAt`, it just samples every tick, see
Recorded resource history in `observability.md`. It's also the only one with
`runOnStart = true`. `UpdateCheckScheduler` (`cron/update-check-scheduler.ts`)
is another plain `BaseScheduler` on a 10-minute tick, see Version pinning and
update checks in `services-and-templates.md`.

`DueScheduler` extends `BaseScheduler` (`cron/base-scheduler.ts`), which owns
the shared "60s `setInterval`, HMR-safe via a `globalThis`-backed registry keyed
on `label`, non-overlapping ticks, idempotent `start()`" boilerplate. **Keyed on
`label`, not `constructor.name`**: three instances of the same class would
collide on the latter. `JobWorker` (`queue/worker.ts`) is the fourth subclass,
overriding `intervalMs` to a 1s poll, see Job queue and worker above.
`CronService.startCronScheduler()`/`startBackupScheduler()`/
`startCronJobScheduler()` (all called from `hooks.server.ts`'s `init()`) just
call `.start()` on the composed instance.

`cron/cron-expression.ts` holds the small dependency-free 5-field cron matcher
(wildcard/number/range/list/step, minute resolution, server-local time, no
external cron package, matching this app's generally dependency-light posture)
as plain exported functions (`parseCronSchedule`/`cronMatches`/`sameMinute`),
pure and stateless, so it stays outside the class hierarchy, same "pure
transform doesn't need an instance" precedent as `docker/labels.ts`;
`CronService.parseCronSchedule`/`cronMatches` just delegate to it, and two
route-level validation call sites call those directly. Day-of-month and weekday
follow the standard cron OR rule: when **both** fields are restricted a date
matches if **either** does (`0 0 1 * 1` fires on the 1st _and_ every Monday);
when one is a wildcard only the other applies. "Restricted" means the field
doesn't start with `*`, matching Vixie cron's own star flag, so `*/2` counts as
unrestricted. Covered by `tests/unit/app/cron-expression.test.ts`.

## Cron jobs (`cron_job`/`cron_job_run` tables, `CronJobDTO`, `src/lib/services/cron-job.service.ts`, `/cron-jobs`)

A user-defined scheduled task that isn't tied to a service, unlike
`service.cronSchedule` (which redeploys an existing service). Three kinds:

- **`kind: "image"`** runs a throwaway container: image + tag, an optional
  command override, env vars, and optional private-registry credentials
  (`registryPasswordEnc`, same AES-256-GCM scheme as everything else). The
  command override is parsed by `src/lib/command-parse.ts`'s `parseCommand`, a
  small pure tokenizer (quotes group, backslash escapes, and a leading `[` is
  taken as Docker-style JSON exec form), tested in
  `tests/unit/app/command-parse.test.ts`.
- **`kind: "exec"`** ("Host command") runs on the Docker host itself, not in the
  app's container: a throwaway `alpine:3` helper, `privileged: true`,
  `pidMode: "host"`, whose command is
  `nsenter -t 1 -m -u -i -n -p -- sh -c <command>` (`docker/host-command.ts`'s
  `hostCommandArgs`, busybox ships `nsenter`, still pure TS built into the spec
  below). It used to be `execFile` inside the app container, which is not the
  host at all once Homerun runs from compose, and handed the app's own
  environment (`AUTH_SECRET`, `DATABASE_URL`) to the command; now only
  `job.envVars` reach it. Verified by hand:
  `docker run --rm --privileged --pid=host alpine:3` running that `nsenter` line
  with `hostname` prints the host's (OrbStack VM's) hostname. Under rootless
  Docker PID 1 of the daemon's PID namespace is rootlesskit's, so "host" there
  means the rootless user namespace. **Admin-only, enforced in
  `src/lib/server/cron-job-form.ts`** (shared by both the create and edit
  actions, so neither can skip it) rather than only hidden in the UI : it is
  root on the host, the same class of power the Docker socket already gives.

- **`kind: "script"`** ("Source code") is inline source (`cron_job.source`) run
  on a fixed runtime image (`cron_job.runtime`, the table is
  `SCRIPT_RUNTIME_SPECS` in `src/lib/cron-job-script.ts`: Bun, Node, Deno,
  Python, `sh`, all official Alpine images). It isn't a separate executor:
  `CronJobService`'s `#containerFor` turns it into an ordinary container spec,
  the source becoming the first config file (`/homerun/main.<ext>`) and the
  command the runtime's interpreter on it, working dir `/homerun`.

**Config files** (`cron_job.files`, `{ path, content }[]`, image and script
kinds, dropped for exec) are written into the container before its process
starts by `internal/dockerapi`'s `WithFiles`, applied inside `RunOneOff`: it
inspects the image for its `Entrypoint`/`Cmd`, replaces the entrypoint with
`/bin/sh -c <FilesScript> homerun-files` and passes the original argv
(configured or image entrypoint, then configured or image command, with Docker's
rule that an overridden entrypoint drops the image's command) as the script's
`"$@"`. Each file's content travels in its own `HOMERUN_FILE_<n>` env var,
written with `printf '%s'` (no `base64` needed in the image), unset, then
`exec "$@"`. **Deliberately not Docker's archive API**:
`PUT /containers/<id>/archive` on a never-started container is the call that
hung dockerd in the backup incident below. Costs: the image needs `/bin/sh`, the
path must be writable by the image's user (Renovate's image runs as non-root, so
`/tmp`), text only (a NUL byte is refused), 20 files of 64 kB at most
(`MAX_CRON_JOB_FILES`/`MAX_CRON_JOB_FILE_BYTES`, under Linux's 128 kB
per-variable limit). `FilesScript` is exercised under a real `/bin/sh` in
`tests/unit/go/internal/dockerapi/files_test.go`.

**Container options** (image and script kinds, all dropped for exec):
`cron_job.runAsUser` (Docker `User`, same `isRunAsUser` check as services),
`cron_job.mounts` (`{ volumeId, containerPath, readOnly }[]`, jsonb rather than
a join table, resolved to `Binds` from each storage volume's `source` in
`prepareRun`, which fails the run when a volume is gone or the job targets a
`"docker"` build server, where the volume doesn't exist),
`cron_job.dockerSocket` and a per-file `mode` (`chmod` right after the `printf`
in `FilesScript`). The socket is a toggle rather than a bind volume because a
non-root user (Renovate runs as 12021) can't use it without the socket's group:
`cronjob.go`'s `withSocket` binds `job.DockerSocket` (a remote host's default
path) at `/var/run/docker.sock` and, locally, adds the socket file's gid to
`GroupAdd`. It's root on the host, so `cronJobNeedsHostAccess` (exec **or** the
socket) gates create, edit, run and delete exactly like a host command
(`manageableCronJob` in `cron-job-form.ts` for every route action).

**One route per tab**: `[cronJobId]/` is Runs (with the `runNow` action the
layout's header button posts to), `configuration/` and `settings/` (plus
`delete`). A run has its own page, `[cronJobId]/runs/[runId]/`, nested inside
the job's `TabNav` (Runs stays active) with a `SectionNav` for its own **Logs**
(bare page) and **Traces** (`traces/`) tabs, a second `TabNav` there would fight
the job's over the "tabs beside the page" sub-nav slot; its layout header shows
status, trigger, timing and exit code and re-reads `getCronJobRun` every 2s
while the run has no `finishedAt`, the Logs tab reading the same query instance.
**`cron_job_run.jobId`** is the queue job that executed the run and
**`cron_job_run.trigger`** (`"cron"`/`"manual"`, from the payload's `scheduled`)
what started it, both stamped by `prepareRun` from the queue entry and null on
runs from before they existed. `jobId` is how the Traces tab finds the run's
trace (`TraceSpanDTO.spansOfJob`, the same lookup as the Scheduling job page),
and how the Runs tab tells a queued run from the previous one: `getCronJobRuns`
also returns the cron job's active queue job
(`JobDTO.findActive("cron_job", "cron_job:<id>")`), and `latestCronJobRun`
(`cron-job-script.ts`) shows "waiting" until a run row carrying that job id
exists, then that run with its live output. **Run now** navigates to Runs and
`refresh()`es `getCronJobRuns` on success, which is what starts the poll; it
keeps polling while something is waiting or unfinished. The Traces tab
`refreshAll()`s every 2s while the run has no spans yet and either hasn't
finished or finished under 30s ago, since the worker's batch exporter writes the
spans a few seconds after the job span ends. The worker's
`internal/jobs/cronjob` adds a `run container` span around `RunOneOff` with
`process.exit.code` and `homerun.cronjob.timed_out`, failed on a non-zero exit
or a timeout.

**New volume from the job form**: `cron-job-mounts.svelte` opens a dialog with
the same `NewVolumeFields` as Storage → New volume (its `idPrefix` keeps the ids
clear of the job form's own `name`/`description`) in its own `<form>`, portaled
out of the job form so it never nests, and calls the `createStorageVolume`
remote command (`volumes.remote.ts`, write on `storage`,
`VolumeSettingsService.create` like every other volume create), then adds the
volume to the picker's options and a mount row selecting it. Each tab's form
only carries its own fields, so `parseCronJobSection` overlays them on the
stored row (`SECTION_FIELDS`, a missing checkbox is off) and runs the whole job
through `parseCronJobInput` again, the same way the API's `PATCH` merges a
partial body.

A job with its schedule off is a manual task: **Run now** on its page, or
`POST /api/v1/cron-jobs/{cronJobId}/run` (202 with the queue job id, same
`enqueueCronJobRun` dedupe as the button). Its runs are readable over the API
too, `GET /api/v1/cron-jobs/{cronJobId}/runs` (newest first, `limit` up to 100,
`outputLength` instead of the output) and `.../runs/{runId}` (one run with its
output), which is what the MCP server's `list_cron_job_runs`/`get_cron_job_run`
call.

All three kinds run as a throwaway one-off container **in the Go worker now**,
not through `DockerService.runOneOff` in-process (see "Executed by the Go
worker" below); `CronJobService.prepareRun`/`finishRun` write one `cron_job_run`
row per attempt on every path including a spec that couldn't even be built, same
shape as the backup/restore worker jobs (see S3 backups below). A run keeps
`exitCode`, `success`, `error`, and the captured stdout+stderr
(`CronJobRunDTO.finish` keeps the **last** 64k characters rather than the first,
since a failure's useful output is at the end).

Wiring follows the existing patterns exactly rather than inventing anything:
`JobType` gains `"cron_job"` (`src/lib/types.ts` + `JOB_TYPE_LABELS`), with its
own zod payload (`queue/payloads.ts`) and handler (`queue/handlers.ts`), an
`enqueueCronJobRun` helper (`cron-job-queue.ts`, mirroring `backup-queue.ts`)
keyed `cron_job:<id>` for both dedupe and lock so one job never runs twice
concurrently, and a third `DueScheduler<T>` instance (`cronJobScheduler` in
`cron.service.ts`, started from `hooks.server.ts`) with the same due-check plus
same-minute double-fire guard as the redeploy and backup schedulers. Routes are
the usual list/new/detail trio (`/cron-jobs`, `new/`, `[cronJobId]/`) sharing
one form component (`src/lib/components/cron-job-fields.svelte`) and one
server-side parser (`src/lib/server/cron-job-form.ts`); enabled jobs also render
on the Scheduling page next to cron redeploys and backups.

**Executed by the Go worker** (`worker-jobs/cron_job.ts`,
`internal/jobs/cronjob`). `CronJobService.prepareRun` creates the run row and
resolves the spec (image ref or the `nsenter` helper, parsed command, env,
labels, registry auth, and for an image job on a `"docker"` build server its
`tcp://` connection; `ssh://` hosts are rejected by the worker, agent hosts by
prepare). Go runs it through `dockerapi.RunOneOff`, appends output to
`cron_job_run.output` at most once a second (`cronjob.go`'s own `flusher`, the
Go port of the old in-process `OutputFlusher`), and returns
`{exitCode, output, timedOut}`; `CronJobService.finishRun` maps that onto the
outcome (same messages as before) and finishes the run. The old in-process
`CronJobService.runJob`/`#runImage`/`#runExec` and its `OutputFlusher` are gone
from the app entirely, not just dead code kept around.

## S3 backups (`src/lib/services/s3-backup.service.ts`, `internal/jobs/backup`, `/backups`, `/s3-destinations`)

Per-volume, off by default. The destination itself is a separate, named,
reusable row (`s3_destination`, `S3DestinationDTO`, managed on
`/s3-destinations`, shown as "Backup Destinations") that a volume points at via
`storageVolume.s3DestinationId`, so several volumes can share one
bucket/credential pair; the volume only owns
`backupEnabled`/`backupSchedule`/`backupPrefix`, edited on `storage/[volumeId]`.
`/s3-destinations/[destinationId]` is the detail page: the volumes using it
(`StorageVolumeDTO.listForDestination`), the same fields as the create form
(`src/lib/components/backup-destination-fields.svelte`, parsed with
`keepSecret: true` so a blank secret keeps the stored one; the type can't
change) and a **Test destination** action. `S3BackupService.testDestination`
writes `.homerun-test-<uuid>` and deletes it, against the saved row: a signed
`PUT` then `DELETE` for S3, `rclone touch` then `rclone deletefile` through
`runOneOff` for the rest (`testRemote`). Listing alone would pass a read-only
key that every backup then fails with. Every attempt, scheduled or manual,
writes a `backup_run` row (`BackupRunDTO`, opened by the
`backup`/`backup_restore` worker jobs' `prepare` step and finalized on every
return path including a spec that couldn't be built), and `/backups` is the page
over that history, plus a "Run now" action per volume, the same one
`storage/[volumeId]` offers.

**The tar-then-upload (and download-then-unpack) pipeline itself runs in the Go
worker now**: `S3BackupService` (`s3-backup.service.ts`) only resolves and
returns the spec `internal/jobs/backup/backup.go`'s `Run` needs —
`backupSpec(volume)`/`restoreSpec(volume, key, options)`, called from
`worker-jobs/backup.ts`/`backup_restore.ts`'s `prepare` — the destination
(decrypted via `destinationFor`), the helper image/mount path, the pre-backup
command's target and, when `backupStopServices`/`options.stopServices`, the
running services to stop (all resolved by
`src/lib/services/backup/volume-services.ts`'s `VolumeServices`, see Quiescing
below). `S3Config`'s hand-rolled AWS Signature V4 client (`signedRequest`,
`listBackups`'s `ListObjectsV2`) is the one part still in TS, since the app
itself lists backups for the Restore picker; the Go side has its own S3 client
(`internal/s3`) for the actual PUT/GET. **A destination has a `type`**
(`src/lib/backup-destinations.ts`: `s3`, `sftp`, `smb`, `webdav`), and
`destinationFor` returns either `{ destination: S3Config }` or
`{ remote: RcloneRemote }` (`src/lib/services/backup/rclone.ts`), so the spec's
`Spec.Remote` is set instead of the S3 fields. A non-S3 row reuses the S3
columns (`endpoint` = `host[:port]` or the WebDAV URL, `bucket` = the path, for
smb the share then an optional path, `accessKeyId` = username,
`secretAccessKeyEnc` = password or an sftp PEM key, `region` empty), parsed by
`src/lib/server/backup-destination-form.ts`. `backup.go`'s `archives()` picks
`internal/rclone` when `Spec.Remote` is set, else `internal/s3`. **rclone
transport**: a throwaway `rclone/rclone` helper (`RCLONE_TAG`), one remote named
`dest` configured only through `RCLONE_CONFIG_DEST_*` env vars, an `sh -c`
entrypoint running `rclone obscure` on the password inside the container, sftp
with `shell_type = none` and no host key check. `Remote.Upload` is `rclone rcat`
of the gzip stream to `<key>.partial`, then `rclone moveto` to the key, and
`deletefile` of the partial on any failure; one stream, no parallel parts, a
progress line every 30s. `Remote.Get` is `rclone cat`. **Both volume kinds are
supported**: `kind: "bind"` is tar'd straight off the host, and `kind: "volume"`
(Docker-managed, whose content isn't visible on the host filesystem the same
way) is mounted read-only into a throwaway helper container that tars it to
stdout — both `internal/jobs/backup/backup.go`'s `archiveAndUpload`, one code
path for both kinds since a bind's source is as mountable as a named volume. The
helper is **started** and streams through its own process
(`tar -C <mount> --numeric-owner -cf - .`, read off a hijacked attach by
`dockerapi.RunHelper`, gzipped on the fly and piped straight into the multipart
upload, no temp file whatever the volume's size). A non-zero exit from the
helper fails the run with the helper's own stderr attached, and the upload is
aborted rather than left truncated.

**Destination capacity** (`BackupCapacityService`, `BackupCapacityScheduler`,
hourly, `src/lib/backup-capacity.ts`): SFTP/SMB/WebDAV destinations are measured
with `rclone about --json` in a one-off rclone container (`remoteAbout`). SFTP
answers through the server's statvfs extension even with `shell_type=none`
(**verified live** against an OpenSSH server); only when that fails is it asked
again through `dest,shell_type=unix:` (`df` over a shell). The figures, the
error and when it was checked live on `s3_destination.capacity_*`; a failed
check keeps the last good figures. `capacityAlertChange` alerts once on crossing
`capacity_alert_percent` (85 by default) through the `backup.storage_low`
channel event and clears 5 points under it, so a destination hovering at the
line doesn't alert hourly. S3 has no size and is never measured.

**Real production incident** (2026-09-28): the S3 endpoint answered part PUTs
with `504 Gateway Timeout`, and every failed run said only "the upload stopped
reading the archive": `archiveAndUpload` returned the helper's broken-pipe error
(the upload had stopped reading because it failed) instead of the upload's own.
The upload error now wins. `internal/s3`'s buffered requests (single PUT, parts,
multipart start/completion) each get `RequestTimeout` (10m) and
`RequestAttempts` (3) tries on a transport error, timeout, 429 or 5xx, every
retry and a throughput line every 30s going to the job log through `Client.Log`.
The activity watchdog alone couldn't bound these: an endpoint trickling bytes
counts as progress. `backup_run.size_bytes` is `bigint`, it was `integer` and
any archive over 2 GiB failed the finalize write.

**Uploads send 16 parts at once** (`internal/s3`'s `uploadParts`,
`UploadConcurrency`, from a pool of buffers so memory stays bounded; parts start
at 8 MiB and double every 2000 up to 32 MiB, `PartSizeFor`, which keeps the
10000-part cap at about 240 GiB) and the archive is gzipped at `BestSpeed`.
**Real production incident** (2026-09-29): a backup to Hetzner's object storage
ran for five hours before being cancelled. Parts went up strictly one at a time,
and Hetzner caps one connection at about 1.3 MiB/s: measured with
`tests/integration/s3-backup.test.ts` on a 256 MiB volume, one part at a time
took 196s, 4 at a time 54s, 8 at a time 27s, 16 at a time 16s (the uplink of the
machine running the test was likely the limit by then). The shared HTTP client
keeps `UploadConcurrency+2` idle connections per host, because
`http.DefaultTransport` keeps two and the rest would redo TLS per part. That
test runs a backup and a restore against a real bucket when `HOMERUN_TEST_S3_*`
is set (see `tests/integration/README.md`).

**Never Docker's archive API on a never-started container.** Backups used to
create an `alpine` helper with entrypoint `true`, never start it, and read the
volume out through `GET /containers/<id>/archive` (restores used
`PUT .../archive`, the readiness probe `HEAD .../archive`). **Real production
incident** (Docker 28.5.2): that archive call hung forever, the job kept
heartbeating so it never looked stale, and it blocked the self-update ("1 job(s)
are running") for hours; after a forced restart the requeued backup's fresh
helper wedged dockerd itself (`docker inspect`/`docker rm -f` on it hung until
dockerd restarted), and because Traefik's Docker provider inspects every
container before building any route, every label-routed site, the dashboard
included, went 404 (swarm services kept working). The file format is unchanged
(a gzipped tar of `./`-prefixed entries), so archives made the old way restore
through the new `tar -x` (verified with a `docker cp` archive, symlink and uid
999 file included). Scheduled backups are one `DueScheduler` config over
`StorageVolumeDTO.listBackupEnabled()`, see Schedulers above.

**Quiescing** is resolved in `src/lib/services/backup/volume-services.ts`
(`VolumeServices`) but executed in Go. `storage_volume.backupStopServices`
becomes a `stopTargets` list (services mounting the volume,
`ServiceVolumeDTO.serviceIdsForVolume`, filtered to the ones a live
`syncServiceStatus` says are running) in the spec;
`internal/jobs/backup/backup.go`'s `whileStopped` stops each one around the
tar/unpack (a container `StopContainer` or a swarm service scaled to 0) and
starts every one it stopped again in a `finally`-equivalent, a failed start
logged rather than thrown (the pure ordering policy, `stopAround`, is now a Go
generic, the port of the old TS `stopAroundWork`). `backupPreCommand` still runs
first, while everything is still up: `VolumeServices.preCommandTarget` resolves
which container it runs in (the volume's picked service, or the first running
one using it), and `backup.go`'s `runPreCommand` executes it through
`/bin/sh -c` via `internal/dockerapi`'s container exec (a 15 minute wait cap). A
non-zero exit fails the run with the output tail, before anything is tarred.
Both are per-volume, which is also per-schedule, since a volume has one
schedule.

## Cron jobs on another daemon, and live output

`cron_job.remoteHostId` (nullable FK to `remote_host`, "Run on" on the job form)
picks which daemon a kind `image` job runs its container on;
`RemoteHostDTO.resolveBuildTarget` resolves it the same way a build server is
resolved, and an **agent** host is refused with a message rather than silently
running locally : the agent has no one-off run endpoint. Kind `exec` ignores it
by definition, it's a shell command on the host of this app's own Docker daemon.

**Output arrives while the job runs, not after it.**
`internal/dockerapi.RunOneOff` takes an `onOutput` callback fed from the same
demuxed stdout/stderr streams it already collects, and `internal/jobs/cronjob`'s
own `flusher` (the Go port of the old in-process `OutputFlusher`) batches those
chunks into `CronJobRunDTO.appendOutput` once a second (one write a second, not
one per chunk). The job's Runs tab re-reads `getCronJobRuns` every 2s while a
run is queued or has no `finishedAt`, and the run's own page re-reads
`getCronJobRun`, so a long job shows progress instead of a spinner and then a
wall of text.

## Restoring an S3 backup

`S3BackupService.listBackups(volume)` is ListObjectsV2 against the volume's own
prefix (same hand-rolled SigV4 as the app-side upload listing, `signedRequest`
shared between GET and LIST) for an S3 destination; for sftp/smb/webdav it is
`listRemoteBackups` (`rclone lsjson` through `DockerService.runOneOff`, the
worker's one-off endpoint; exit 3, a directory that doesn't exist yet, is an
empty list). And `restoreSpec(volume, key, { wipe, stopServices })` is what the
`backup_restore` worker job hands the Go worker to download `key` and unpack it
back into the volume.

**It's a queue job**, `backup_restore` (`enqueueVolumeRestore` in
`backup-queue.ts`, payload `backupRestoreJobPayload`), deduped on
`restore:<volumeId>`, sharing `volume:<volumeId>` as its lock with backups so a
restore never races a tar of the same volume, and `maxAttempts: 1` (retrying a
half-applied restore isn't something to do silently). It writes a `backup_run`
row with `kind: "restore"` and the object `key` (backups now record their
uploaded `key` too), so the run log and `/backups` (Kind filter) show both.
`internal/jobs/backup/backup.go`'s `restore` downloads before `whileStopped`, so
services are down only for the optional `wipe` (a helper
`find <mount> -mindepth 1 -delete`) and the unpack. The unpack is a started
helper running `tar -C <mount> --numeric-owner -xf -` with the archive fed into
its stdin over a hijacked attach (`backup.go`'s `unpack`, gunzipping in Go when
the object starts with the gzip magic, so a plain tar works too), then the
connection half-closed so `tar` sees EOF (`OpenStdin`+`StdinOnce`). One path
covers both volume kinds, since a bind's source is as mountable as a named
volume. Compose import's file mounts (`DockerService.extractIntoVolume`) go
through the same shape: the worker's `PUT /v1/volumes/archive` runs the helper
with the request body as its stdin.

Without `wipe` it's a **restore-over** : files in the archive replace what's on
disk and anything else is left alone. `stopServices` defaults to on in the UI;
the confirm dialog's text follows both toggles.

**Restoring from a service's Storage tab** (`restoreVolumeBackup` in
`src/lib/services/backup/volume-restore.ts`, the `restoreBackup` action,
`RESTORE_MODES` in `src/lib/restore-modes.ts`): `replace` is a plain restore
job; `backupFirst` chains the restore on a backup job (`dependsOnJobId`), so a
failed backup cancels it. `revision` creates a new Docker volume with the old
one's backup settings, restores into it, and enqueues a deploy that depends on
the restore and carries `mountSwap` in its payload (its own dedupe key, so it
never coalesces into another queued deploy and loses the swap). The swap is
applied in that deploy's prepare step (`swapRestoredVolume`), not when it's
queued, so a failed restore leaves the service mounted on the old volume. Every
deploy's `configSnapshot` records `volumeMounts`, and a rollback with
`restoreConfig` puts them back; the swap also backfills them onto the revision
it replaces when that one predates the field. A dependent job cancelled by a
failure or a cancel used to leave a deploy's deployment `pending` forever:
`closeCancelledDeploys` fails it and re-syncs the service, from the worker's
failure path and from `cancelBackupRun`.
`tests/integration/volume-restore.test.ts` runs the revision and backup-first
paths end to end against an in-process S3 stub.
