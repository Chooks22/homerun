# Logging, notifications, stats, diagnostics

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Setup diagnostics (`src/lib/services/admin.service.ts`)

`AdminService.runSetupChecks()`, read-only diagnostics (base domain/auth
secret/origin still at their defaults, Traefik container reachable, the Go
worker and its Docker socket reachable, SMTP fully configured if enabled), each
with a severity and the env var that fixes it. **The Docker check is really two,
reported apart on purpose**: `#dockerCheck()` first asks the worker's own
`GET /v1/health` (is the worker process even up), then, only if that answered,
`GET /v1/info` (is Docker answering _the worker_). The app holds no socket of
its own any more, so "nothing deploys" now has two different causes with two
different fixes (`WORKER_URL` pointing nowhere, vs. a live worker whose
`DOCKER_SOCKET_PATH` is wrong), and collapsing them into one "Docker socket"
line used to send the operator to check a socket the app doesn't even open.
Reads `config`, which already reflects any DB-backed instance settings merged
over the env defaults (see Config and Instance settings below), these checks
just report the effective value, they don't care which layer it came from. DNS
automation (Cloudflare/Pangolin, see below) is separate from this check,
`runSetupChecks()` doesn't currently flag an unset DNS provider, that's an
opt-in feature, not a base-instance misconfiguration.

**`dashboard-router` is the one check that reads this app's own container.**
`DockerService.selfContainerLabels()` inspects it (Docker sets a container's
hostname to its own short id, which is what makes self-inspection possible) and
`hasTraefikRouterFor(labels, host)` looks for an enabled router whose rule
carries the Dashboard URL's host. **Real, reproduced case**: an instance
installed before the app container got its `DASHBOARD_DOMAIN` router had no
Traefik labels at all, so the dashboard answered on `:3000` and Traefik returned
its own 404 for the configured hostname, with nothing anywhere saying why —
labels are only read when a container is **created**, so editing the Dashboard
URL in `/settings` can never fix it, only regenerating the compose file and
recreating the container can. The check skips itself when the origin carries an
explicit port (that instance is reached directly on that port, not through
Traefik : the installer's own IP-mode default) and when self-inspection fails
(dev, or not running in a container).

It now looks for the router file Homerun publishes first (the route that
survives a stalled Traefik Docker provider, see `docker.md`) and reports a
label-only route as working but not resilient.

**`docker-wedged` reports helper containers the Docker daemon is stuck on**,
read from the worker's `/v1/health` `wedgedContainers` (see `worker.md`'s
janitor): a danger check naming them and the fix,
`sudo systemctl restart docker`. `CoreServicesWatch` posts the same text once
per newly wedged container as a `docker_wedged` notification.

There's no standalone `/setup` page anymore (removed, it duplicated what
`/settings` already does live). `AdminService.runSetupChecks()` now only backs
the dashboard's setup-issue banner, which deep-links straight into `/settings`
with the offending field(s) highlighted: `AdminService.SETUP_CHECK_FIELDS` (same
file) maps a check's id to the `/settings` field id(s) it corresponds to;
`(protected)/+page.server.ts` builds a `highlightFields` list from the current
issues and appends it as `?highlight=a,b,c`; `/settings` is now split into one
route per tab (see the tabs convention above), so its `+layout.server.ts`
redirects to whichever tab the first highlighted field actually lives on before
that tab's own page rings the matching fields amber and scrolls the first one
into view on mount. Two checks (`auth-secret`, env-only; `traefik`, a
live-container check) deliberately have no entry in the map, nothing to
highlight for either.

## System stats (`src/lib/services/system-stats.service.ts`, `internal/hoststats`)

`SystemStatsService.getSystemStats()` is a thin call to the Go worker's
`GET /v1/host/stats`, not a local read any more : the app may itself be a
container, and its own `os`/`df` readings would describe that container's limits
rather than the real machine's, which is exactly why this moved.
`internal/hoststats`'s `StatsSampler` (Go, not to be confused with the
`src/lib/services/stats/stats-sampler.ts` one below; shared with the agent, see
`packages-and-release.md`, so a remote host's row on the dashboard renders from
the identical shape as the local one) reads `/proc/stat` and `/proc/meminfo`
directly and shells out to `df -Pk .` for disk and `nvidia-smi` for a
best-effort GPU read (`gpu: null` when absent, the common case, not an error; no
other vendor supported). CPU% needs a delta between two samples, so the sampler
keeps the last one as an instance field and diffs on each call, the first call
after the **worker** starts (not the app) always reads 0%. Polled by the
dashboard's `/system-stats` endpoint every 5s, which now round-trips through the
worker on every poll rather than reading in-process.

## Recorded resource history (`stat_sample`, `StatSampleDTO`, `src/lib/remote/stats.remote.ts`)

The live poll above keeps nothing, so the graphs read a recorded history
instead. `StatsSampler` (`src/lib/services/stats/stats-sampler.ts`, a
`BaseScheduler`) writes one `stat_sample` row a minute for the host and one per
service with a running container (`DockerService.sampleContainerStats`, a
non-streaming `docker stats` read), and prunes past a year every sixtieth tick.
It's the one scheduler with `runOnStart = true`: without it a fresh instance
shows an empty chart for a full minute, and unlike the due-date schedulers
there's nothing to double-fire.

`StatSampleDTO.history(range, serviceId)` buckets that table per range at query
time (`live` 15min/1min … `all` 1-day buckets) rather than maintaining rollup
tables, averaging CPU and memory and turning the **cumulative** network counters
into a per-second rate across each bucket, clamped at zero because a container
restart resets its own counters. Two Postgres details are load-bearing: the
bucket width is `sql.raw`'d rather than bound, since dividing by an untyped bind
parameter makes Postgres reject the expression as an ambiguous operator (that
was a real "Couldn't load the history" bug), and `latestPerService` uses
`selectDistinctOn`. `serviceId` null is the host itself, so the dashboard's
chart and a service's own chart are the same query.

## Logging

Every module that mutates state (`page.server.ts` actions, the Docker layer,
cascade-delete helpers) instantiates `new Logger("Domain")` from
`src/lib/logger.ts` at module scope and calls `.info()`/`.warn()`/`.error()` on
start/success/failure of each operation, with entity + user ids for correlation.
`App.Locals.logger` is declared in `app.d.ts` but never populated, that's
dead/aspirational, don't use it; the per-module `Logger` instance is the real
pattern.

## In-app notifications (`notification` table, `NotificationDTO`, `/notifications`)

A curated lifecycle event feed, one copy per account, deliberately separate from
the `app_log`/Errors-tab system above: written explicitly at each event site
rather than derived from logs, so it stays a short, meaningful list rather than
every warn/error the app produces. The header's bell
(`src/lib/components/notification-bell.svelte`) is a link to the
`/notifications` page with the unread badge; it used to be a Popover dropdown.
`/notifications` is in `OPEN_ROUTES` (`permissions.ts`): every account reads its
own feed, so no permission area gates it.

- `notification` table: `id`, `userId` (FK, cascade delete), `serviceId`
  (nullable FK, cascade delete), `message`, `detail` (nullable multi-line text,
  shown under the message on the page), `type` (a TS union on a text column, see
  `schema.ts`), `createdAt`, `readAt` (nullable, unread until set). Indexed on
  `(userId, createdAt)`.
- `NotificationDTO`: `listForUser(userId, limit, unreadOnly)` (joins in the
  related service's slug and stack name), `unreadCount(userId)`,
  `markRead`/`markAllRead`/`delete`/`deleteAll` (owner-scoped), and a
  fire-and-forget static `notify(input)` helper, never awaited, swallows its own
  errors, same posture as `Logger.warn`/`.error`'s `AppLogDTO` write. `notify`
  goes through `broadcast(input)`, which inserts one row per account and
  amortized-prunes each feed back to its newest `MAX_ROWS_PER_USER` (200) rows
  on ~5% of writes. `notifyServiceError(serviceId, message)` broadcasts too,
  used by `Logger.error`.
- **Scheduled work reports once per run**: `NotificationChannelService`'s
  `#deliverGroup` writes `scheduledNotification(messages)`
  (`notification-grouping.ts`) for every _scheduled_ group the grouper flushes,
  channels subscribed or not: a lone outcome keeps its title, service and
  detail; several become `Scheduled tasks: …` with `summaryFields` as the
  detail. Type `scheduled_failure` when any failed, else `scheduled_summary`;
  `notificationHref` sends both to `/scheduling`. A cron-triggered deploy writes
  no in-app row of its own any more (the old cron-only `ScheduledBellDigest` is
  gone). Held messages are in memory, so a restart drops the summary too.
- `src/lib/remote/notifications.remote.ts`: `getNotifications` (the whole feed,
  for the page) and `getUnreadNotifications` (unread count plus the newest five
  unread, for the bell and the dashboard's `unread-notifications.svelte`), and
  one command per mutation, each refreshing both queries server-side.
- **Browser notifications** (`src/lib/notification-feed.ts`): the bell polls
  `getUnreadNotifications` every 30s and, once permission is granted, shows a
  `Notification` for each unread id it hadn't seen (seeded from the first
  result, so a reload doesn't replay old ones; `tag` is the row id so two tabs
  don't show it twice). It skips that entirely once this browser has a Web Push
  subscription (see Browser push below), so nothing shows twice.

## Browser push (`src/service-worker/`, `web-push.ts`, `WebPushService`, `push.remote.ts`)

A browser is a notification channel of kind `"browser"`, one row per browser,
whose `target` is its push subscription as JSON (`{endpoint, keys}`), so it gets
the channel events matrix, test, edit, enable and delete for free and the
grouping/retry path above. `browser-notifications-button.svelte` →
`enableBrowserPush` (`src/lib/browser-push.ts`) asks permission, waits on the
service worker SvelteKit auto-registers from `src/service-worker/index.ts`,
subscribes with the instance's VAPID public key (re-subscribing when the stored
subscription used an older key) and calls `registerBrowserPush`, which upserts
the channel by endpoint, named by `browserDeviceName` and subscribed to
`DEFAULT_BROWSER_EVENTS`. The service worker only handles `push` (shows the
notification) and `notificationclick` (focuses a tab and navigates it, or opens
one); it caches nothing. Its own `tsconfig.json` extends
`$app/tsconfig/service-worker` (WebWorker lib) and `bun run check` runs `tsc`
over it, since the root tsconfig excludes it.

**No `web-push` dependency**: `src/lib/server/web-push.ts` does RFC 8291
(`aes128gcm`, Web Crypto ECDH/HKDF/AES-GCM, one record) and RFC 8292 (an ES256
JWT via `jose`) itself, round-trip tested in `tests/unit/app/web-push.test.ts`.
The VAPID key pair is generated on first use and stored on `instance_settings`
(`vapidPublicKey`, `vapidPrivateKeyEnc` encrypted with the auth secret); if the
auth secret changes it can't be decrypted, a new pair is generated, and every
browser has to turn push on again. `pushPayload` keeps the body to one line and
tags it `<serviceId>:<event prefix>`, so a `build.started` push is replaced
(with `renotify`) by that build's `build.succeeded`/`build.failed`. A 404/410
from the push service is `PushSubscriptionGoneError`: the channel is disabled
with its `lastError` set and no retry is queued. A channel's `target` never
reaches the dashboard or the API, `channelTargetLabel` shows `Push via <host>`.
The REST API lists browser channels but can't create one.

`build.started`/`deploy.started` (`deployStartedEvent`, `deployStartedMessage`)
are sent by `prepareWorkerDeploy` through `notifyDeployStarted` once the
deployment is marked pulling; never for a `cron` trigger, whose outcome goes
into the scheduled run summary anyway.

## Outbound notification channels (`notification_channel`, `NotificationChannelDTO`, `notification-channel.service.ts`)

The account-wide counterpart to the in-app feed above: a `notification_channel`
row is a `kind` (`"webhook"` generic JSON POST, `"discord"` embed, `"slack"`
incoming-webhook attachment, `"telegram"` Bot API `sendMessage`, `"email"`, or
`"browser"` Web Push, see Browser push above) plus a `target` and an `events`
jsonb column (`NotificationEvent[]`, DB default and DTO default
`["build.failed","build.checks_failed","update.failed","deploy.unhealthy","deploy.rolled_back"]`),
managed on `/notification-channels` (create/test/delete) with the events matrix
itself edited on `/profile/notifications`.

`NotificationEvent` (`src/lib/types.ts`) and its catalog
(`src/lib/notification-events.ts`, `NOTIFICATION_EVENTS`,
labels/groups/descriptions for the settings matrix) cover four pairs:
`build.failed`/`build.succeeded` (a git-source service, any trigger),
`update.failed`/`update.succeeded` (an image service redeployed by its own cron
schedule, i.e. pull + restart), `deploy.failed`/`deploy.succeeded` (a manual
image deploy), and `service.down`/`service.up` (an uptime probe transition, see
Uptime probes below), plus three that aren't pairs: `build.checks_failed`
(`statusChecksMessage`, sent by `notifyStatusChecksFailed` in
`deploy/status-check-step.ts` _instead of_ `build.failed` when a git build is
stopped by required status checks), `deploy.unhealthy` and `deploy.rolled_back`
(`revisionHealthMessage`, sent by `RevisionHealthService`). The bell gets the
matching `build_checks_failed`/`deploy_unhealthy`/`deploy_rolled_back` rows.
`isFailureEvent` lists all three explicitly, since `build.checks_failed` doesn't
end in `.failed`. `deployEvent(buildSource, trigger, ok)` picks the right one of
the first three from what `deploy.service.ts` already knows; `isFailureEvent` is
what colors a Discord embed red vs. green.

`NotificationChannelService.dispatch(message)` fans a message out to every
account's enabled channels subscribed to that event
(`NotificationChannelDTO.listSubscribed`, filtered in code, not with jsonb `@>`,
see the jsonb trap in `data-and-config.md`), one delivery attempt per channel
via `Promise.all`; a channel that throws is caught, logged and written to its
own `lastError` rather than aborting the others, same posture as
`status-alert.service.ts` below. **A failed delivery is retried through the job
queue** (see `jobs-and-queue.md`): `#send` enqueues
`deliveryRetryJob(channel, message)`, a `notification_delivery` job owned by the
channel's user carrying `{channelId, message}` (`notificationDeliveryJobPayload`
re-validates it, including the event name), `runAt` 30s out and `maxAttempts` 4,
so the worker's own `10s * 2^attempts` backoff spaces the rest. Its handler
calls `NotificationChannelService.retryDelivery`, which loads the channel
unscoped (`NotificationChannelDTO.getForDelivery`), returns `{delivered: false}`
for a channel deleted, disabled or unsubscribed since, and otherwise rethrows a
failure after writing `lastError` so the worker schedules the next try.
`sendTest` stays a single direct attempt. `notify`/ `notifyDeploy` are
fire-and-forget (never awaited) so a channel outage can't fail the deploy or
probe tick that triggered it. `deploy.service.ts` calls `notifyDeploy` from both
`#recordFailure` and its success path; `status-alert.service.ts`'s
`StatusAlertService.dispatch` calls the shared `dispatch` directly for uptime
transitions, it no longer has its own delivery code (that used to be scoped to a
status page's channels, see Status pages in `services-and-templates.md` for why
it isn't anymore). Email requires SMTP configured and says so instead of failing
opaquely; a Discord target is validated to look like
`https://discord.com/api/webhooks/...` (or the `discordapp.com`/`canary`/`ptb`
variants) and a Slack one to be an https
`hooks.slack.com/services|triggers|workflows/` URL before it's saved
(`validateChannelTarget`, `src/lib/server/validation/notification-channel.ts`).
**A Telegram channel has two secrets and one `target` column**: the create form
posts `telegramBotToken`/`telegramChatId`, `channelTargetFromForm` packs them as
`<bot token>/<chat id>` (`src/lib/notification-channel-target.ts`, split back
with `parseTelegramTarget` on the last `/`), validated as `\d+:[\w-]{30,}` and a
numeric chat id or `@name`. `/notification-channels`' `load` swaps every target
for `channelTargetLabel`, so a Telegram row reaches the browser as `Chat <id>`
and the token never does; a Telegram error reports Telegram's own `description`,
never the request URL that carries the token. The payload builders
(`messageSubject`/`messageBody`/`discordPayload`/
`slackPayload`/`telegramPayload`) and `deployEvent`/`isFailureEvent` are pure
and unit-tested in `tests/unit/app/notification-channel.test.ts`.

**Grouping** (`src/lib/services/notification-grouping.ts`).
`dispatch(message, { scheduled })` hands every message to a
`NotificationGrouper` (pure, driven by timestamps so tests pass a clock): a
message with nothing sent in the last 60s goes out at once, later ones are held
until 60s of quiet (5 min cap), and `scheduled` ones (a `cron`-triggered deploy,
a backup or cron job enqueued by its scheduler, the `scheduled` payload flag)
are always held until 60s of quiet _and_ `JobDTO.hasActiveScheduledWork()` is
false (1h cap). That check filters payloads in code because of the
double-encoded jsonb trap in `data-and-config.md`. A 10s ticker (`flushDue`,
public so tests drive it with `setSystemTime`) runs only while something is
held. `#deliverGroup` resolves each channel once across the group's events and
sends it only its subscribed messages: one as itself, several folded by
`groupedMessage` (counts in the title, first failure's event, link and colour,
failures' detail tails). Held messages are in memory; a restart drops them.
Tests call `discardPending()` in `afterEach`, since otherwise consecutive
dispatches in one test file group. Backup outcomes are notified from
`worker-jobs/backup.ts`'s finalize (a failure only once no retry is left), cron
jobs from `worker-jobs/cron_job.ts`'s.

**A message is built once, in `notification-messages.ts`, and every channel
renders the same shape**: `title`, `detail`, a list of `fields` (name/value) and
a dashboard `link` (only when `auth.origin` is set). `deployMessage` fills the
fields from the finished deployment row: stack, trigger (Manual/ Scheduled),
image and short digest or repository/branch/short commit, duration, and the
public URL on success; a failure's `detail` is the error plus the last 15 log
lines (ANSI and phase markers stripped), since the error alone is often just
"Build failed.". `uptimeMessage` adds the probe kind and, for the external
probe, the host. Discord shows the fields as embed fields (inline when short)
and keeps the _end_ of an oversized detail, where the error is; Slack does the
same as a coloured attachment; Telegram sends escaped HTML (bold labels, a
`<pre>` detail tail) and falls back to the plain-text body when the rendered
message would pass its 4096-character limit; email lists them as `Name: value`
lines; a generic webhook gets the message object as-is. `notifyDeploy` loads the
stack itself, so both deploy exits pass the same `{dep, ok, svc, trigger}`.

## Uptime probes (`uptime_check`, `UptimeCheckDTO`, `src/lib/services/uptime/uptime-probe.ts`)

Two probes a minute per service with `uptimeEnabled` (default
`!isDatabaseImage(image)` in `ServiceDTO.create`, so off by default for a
datastore, toggled by the Observability tab's `?/setUptime` action or
`uptimeEnabled` on the REST PATCH) and a live container, run by another
`BaseScheduler`:

- **internal** — asks the container itself, on the Docker network
  (`DockerService.containerAddress`) and its container port. This is what a
  sibling service sees, and it catches a dead process inside a container the
  daemon still reports as running.
- **external** — HTTP to the hostname Traefik publishes (`primaryHostname()`:
  the service's chosen main domain, else `<slug>.<baseDomain>`). It fails for
  entirely different reasons: DNS, a missing router, a tunnel that isn't up.

**An untrusted certificate is not an outage, and treating it as one reported
healthy services as down.** The probe's own comment always claimed a self-signed
certificate was the normal case behind a tunnel, but nothing implemented it:
Bun's `fetch` verifies by default, so a service sitting behind a Pangolin tunnel
whose edge hadn't issued a certificate for that subdomain showed
`TLS failed: unable to verify the first certificate` and 0% uptime while serving
200s perfectly well. The probe now tries verified first and, **only** when the
failure is a certificate one (`isCertificateError`), retries with
`tls: {rejectUnauthorized: false}` : a success on the retry is `ok` with
`certificate not trusted` appended to the detail, so the cert problem stays
visible without being an outage, and a connection refused or a timeout still
fails on the first attempt as before.

**The healthcheck detail is stripped of ANSI escapes** (`stripAnsi`,
`src/lib/ansi`) before it's stored. A container whose `HEALTHCHECK` prints
coloured output put raw `\x1b[32m` sequences into the uptime row, which the
panel renders as plain text : they showed up on screen as `[32mStatus: 200`.

**A swarm service gets an internal probe too.** It used to be skipped outright
(`containerId` is null in swarm mode), so its "From the network" row sat on "No
beats recorded yet" forever with no hint why. The probe now resolves the
service's running task on this node (`getRunningTaskContainerId`) for the
healthcheck, and aims TCP/HTTP at the overlay alias `<slug>:<port>` rather than
a container IP. That only resolves because `enableSwarmMode` attaches this app's
own container to the overlay (re-asserted on every boot by `CoreServicesWatch`).
No running task on this node records a failure. For that attach to be
idempotent, the worker's `/v1/containers/{id}/connect` passes the daemon's
status through (403 already attached, 404 missing) instead of a blanket 500,
which had also made every re-assert after the first fail on Traefik's
already-attached overlay.

**The internal probe isn't always HTTP**, and
`internalProbeMethod(image, hasHealthcheck)` picks between three, in this order:

1. `healthcheck` — the image declares its own `HEALTHCHECK`, read back off
   `State.Health` by `DockerService.containerHealth`. Always preferred: the
   image author knows what ready means for that software, and it's the only one
   of the three that can tell a Postgres mid-recovery from a ready one.
   `starting` counts as up (the container is inside its own start period), only
   `unhealthy` is a failure.
2. `tcp` — a datastore (`isDatabaseImage`, i.e. anything `detectLinkEngine`
   recognises) with no healthcheck of its own. "The port accepts a connection"
   is the honest liveness signal there and nothing more is claimed.

   **`Bun.connect` needs real socket handlers.**
   `Bun.connect({hostname, port, socket: {}})` throws
   `Expected at least "data" or "drain" callback` synchronously, before it opens
   anything — so the first version of this probe failed for _every_ database and
   stored that sentence as the outage reason. `tcpConnect` passes
   `open`/`data`/`error`/`connectError` and resolves from `open`, racing a
   `TIMEOUT_MS` timer. It's covered against a real `Bun.listen` socket (open
   port, closed port, unroutable address) in
   `tests/unit/app/uptime-probe.test.ts`, deliberately not with a mock: a mock
   would have accepted the broken call too.

3. `http` — everything else, where a status code means something.

That hierarchy exists because speaking HTTP at a Postgres is how a perfectly
healthy database read as **down** in the uptime panel, with Bun's own "pass
`verbose: true` in the second argument to fetch()" hint shown to the user as the
reason it was down. `probeErrorMessage` strips that tail and collapses the cases
people actually hit (timeout/abort, refused, TLS) into one actionable sentence;
both it and `internalProbeMethod` are pure and unit-tested in
`tests/unit/app/uptime-probe.test.ts`.

**Any HTTP response under 500 counts as up**, including 401/403 (a service
behind the login wall is alive, it's just refusing the prober) and 404 (it
answered, it just has no route at `/`). A 5xx is down: it's either the app
saying it isn't ready (AIOMetadata answers every route with 503 while it waits
forever for its Redis) or Traefik's 502/503/504 for a backend that isn't there,
and counting those as up showed a broken service green for hours. A transport
error or the 5s timeout is a failure too, and `redirect: "manual"` keeps a
redirect from being chased.

**The external probe is skipped, not failed, when the hostname is a loopback
one** (`externalProbeSkipReason`: `localhost`, `127.0.0.1`, `::1`, `0.0.0.0`,
`*.localhost`). A `localhost` base domain is the dev/first-boot default, so the
"public" hostname resolves to this machine and probing it proves nothing about
whether anyone else can reach the service — reporting that as an outage would be
noise, reporting it as up would be a lie. The panel says why instead.

Results are **appended, one row per probe** (`id` primary key), not upserted:
the panel renders the last `BEAT_WINDOW` (40) as a heartbeat strip, which needs
the history. `UptimeCheckDTO.beats(serviceId, kind)` returns them oldest-first
for the strip, `latest` uses a `selectDistinctOn` for the "now" view, and
`prune()` drops anything past a 7-day retention, amortized one tick in 60. The
service Observability tab renders both probes with per-probe troubleshooting
steps when one fails; the dashboard shows a banner listing every failing probe,
linking into the service that owns it.
`src/lib/components/heartbeat-strip.svelte` is the shared strip, also used by
both status-page surfaces.

**A state change also fires alerts** (`status-alert.service.ts`). The tick reads
`UptimeCheckDTO.latestByProbe` _before_ recording its own results, and
`detectTransitions` compares the two: a probe with no previous beat is
deliberately not a transition, or the first tick after a deploy (or after
`prune()` cleared the window) would alert on every service at once.
`AlertDamper` then filters them: a flapping service (a swarm task that passes
its healthcheck for ten minutes, gets replaced, fails again, forever) used to
send a down and a recovered alert every cycle. Now a probe already alerted down
stays silent until it has been up for `RECOVERY_STABLE_MS` (15 minutes), and
only then sends one recovered. The state is in memory, so a restart costs at
most one extra alert. Each remaining transition is handed to
`NotificationChannelService.dispatch` (`service.down`/ `service.up`), which fans
it out to every channel account-wide subscribed to that event, see Outbound
notification channels above, no longer scoped to a status page. A channel that
throws is caught, logged and written to its own `lastError`, never allowed to
abort the tick.

## Error tracking (`error_project`/`error_issue`/`error_event`, `src/lib/error-tracking/`, `ErrorTrackingService`)

Sentry-protocol ingest so official SDKs work unchanged (GlitchTip's approach):
`POST /api/<projectId>/envelope/` and legacy `/store/`
(`src/routes/api/[projectId=integer]/`), public, keyed by `X-Sentry-Auth` or
`sentry_key`, CORS open, gzip/deflate, 1 MB cap (413; a gzip bomb past the cap
is a 400), 120 events/min per project (429 +
`Retry-After`/`X-Sentry-Rate-Limits`). Only `event` items are stored;
transactions, sessions, replays, attachments and client reports get 200 and are
dropped so SDKs don't retry. The pure parts live in `src/lib/error-tracking/`:
`envelope.ts` (envelope/auth parsing, `isIngestPath`), `event.ts`
(`normalizeEvent` trims everything: 60 frames, 5 chained exceptions, 50
breadcrumbs, capped strings/contexts), `grouping.ts` (SDK `fingerprint` with
`{{ default }}`, else exception type + in-app frames without line numbers, else
the message with numbers/hex/uuids normalized), `source-links.ts` (strips build
roots like `/app/` and schemes like `webpack://` to a repo path, links it at the
release SHA or the deployment live at event time for GitHub/GitLab/
Gitea/Bitbucket), `dsn.ts` (public DSN from `config.auth.origin`, internal DSN
to the dashboard's network alias, `sentryEnv` for deploy injection of
`SENTRY_DSN`/`SENTRY_RELEASE`/`SENTRY_ENVIRONMENT`, never overriding a user-set
var; a git build's release is filled in by the worker from the commit it built).
Previews and the canary report to the parent's project.

Two real findings from the end-to-end run with `@sentry/node`: the SDK sends no
`Content-Type`, and SvelteKit's dev (Node) adapter drops a body without one, so
`vite.config.ts`'s `ingestContentTypePlugin` sets one on ingest POSTs in dev
(the built server is fine); and the SDK posts events of one issue in parallel,
so `ErrorIssueDTO.record` decides "regressed" with a conditional
`UPDATE ... WHERE status = 'resolved' RETURNING id` before the upsert, which
only one concurrent request can win (a timestamp comparison let two through).
Notifications (`error.issue.new`, `error.issue.regressed`, in the default
channel subscriptions) are capped at 10 per service per hour per kind
(`WindowRateLimiter` keyed `serviceId:new|regressed`), so a burst of new issues
can't hide a regression. `error-retention-scheduler.ts` prunes hourly: 100
events kept per issue, 30 days of events, closed issues with nothing newer.
Source maps (`error_source_map`, `ErrorSourceMapDTO`,
`src/lib/error-tracking/source-maps.ts`): uploaded per service and release
through `POST /api/v1/services/:id/sourcemaps` (multipart, a field per map named
after its path in the build output, `homerun services sourcemaps upload` walks a
directory and batches), stored as text in Postgres, 10 releases kept. They're
applied at ingest, before grouping, so issues group on real names: a frame whose
`abs_path` is an http(s) URL is matched to the map whose name is the longest
suffix of the URL path, resolved with `@jridgewell/trace-mapping` (position,
`names` for the function, `sourcesContent` for context lines), and the culprit
is recomputed. Parsed maps are cached in memory by id (32). Resolving at ingest
means a late upload doesn't fix stored events; that's the Sentry behavior too.
Operator doc: `docs/error-tracking.md`.

## Resource incidents (`src/lib/resource-incidents.ts`, `CapacityService`, `resource_incident`)

Modelled on baba (github.com/orochibraru/baba, `internal/monitor`): each
resource has at most one incident. `ResourceIncidentTracker` is pure and
time-based (the stats sampler calls `CapacityService.evaluate` every minute): a
breach opens an incident once it has lasted `resourceAlertSustainSeconds` (disk
at once), escalates soft → hard, reminds every `resourceAlertReminderMinutes` (0
never) and recovers on the first reading under the soft limit. Incidents are
rows so a restart restores the open ones (`restore`) instead of alerting again
or losing the recovery; breach timers live in memory and start over. One check's
events are grouped into at most five messages (critical, warning, the two
reminder kinds, recovered) on the existing `resource.*` events.

## Monitoring (`traffic_sample`, `TrafficSampleDTO`, `MonitoringService`, Observability → Monitoring, stack Monitoring, `/monitoring`)

Traefik runs with Prometheus metrics on an entrypoint only reachable inside its
container (`TRAEFIK_METRICS_FLAGS`, `:8082`): in every compose file, and in
`expectedTraefikFlags` as "the request metrics" so the core-services watch and
`reassertTraefikConfig` put them back on a Traefik that lacks them (which
recreates it once on an existing instance). `DockerService.traefikMetrics` reads
them with `wget` through the worker's `/v1/exec` inside the Traefik container,
so nothing gets published and it works where the app can't reach container IPs
(a dev machine on macOS). `StatsSampler` parses them each tick
(`src/lib/traffic-metrics.ts`: summed per Traefik service over code, method and
protocol, mapped back to a slug, `<slug>-<port>` included for a domain on
another port) and writes the delta against its previous read per running
service; the first read after a start is only a baseline, a counter going down
means Traefik restarted, and a minute without requests writes no row. Pruned
past a year with `stat_sample`, and uptime beats are now kept a year too (they
were a week) so availability covers the long ranges.

`MonitoringService.forService(serviceId, range, zone)` sums a range: totals and
a series from `traffic_sample`, `stat_sample` and `uptime_check`, bucketed by
`bucketSecondsFor` (about 48 points, five-minute steps; inlined into the SQL
like `StatSampleDTO.history`). `src/lib/monitoring-ranges.ts` owns the ranges:
**Today** starts at midnight in the viewer's time zone (`startOfDay`, via `Intl`
offsets, DST-safe), read from a `tz` cookie the Monitoring view sets on mount
(it invalidates once when the cookie was missing or different, so a first visit
briefly shows UTC). The Observability tab is a sub-nav
(`observability/+layout.svelte`): the bare route is Monitoring, `events/` is
what the tab used to be (uptime, logs, failed deploys), and every link that
meant the old content points at `events` now.

It's called monitoring, never analytics: these are SRE numbers (response time,
error rate, uptime, resource use), not visitor analytics, and "analytics" would
read as the latter. `MonitoringService.forScope` takes a `MonitoringScope`: the
service ids whose traffic and uptime count, and a `ResourceScope` for CPU and
memory (the same ids, or `"host"` for the instance page, which reads the host's
own samples). Several services' resources are summed per sampler tick (`ticks()`
in `StatSampleDTO`, grouping on `created_at`, which every row of one tick
shares), so a stack's peak is a real simultaneous peak. A stack's scope is the
stack plus `descendantIds`; `breakdown` returns one row per service in the
scope, busiest first, for the **By service** table.

Every range but all time also carries `previous`: the same totals over
`previousWindow` (yesterday up to this time for today, the span right before for
the fixed windows), through the DTOs' optional `until`.
`src/lib/monitoring-changes.ts` turns the pair into a `Change` per metric
(`formatChange`: relative for counts, times and sizes, percentage points for
error rate and uptime; `HIGHER_IS_BETTER` decides the colour, null for requests
and bandwidth, which are neither good nor bad news).

## Tracing (`trace_span`, `TraceSpanDTO`, `TracingService`, `src/lib/tracing/`, Observability → Traces, Monitoring → Traces)

OpenTelemetry traces, opt-in per service (`service.tracesEnabled`). There's no
trace table: a trace is every `trace_span` row sharing a `trace_id`, unique on
`(trace_id, span_id)` so a retried export never duplicates. A row with no
`service_id` is Homerun's own (the worker writes
`service_name = homerun-worker`); `TraceScope` is `{ serviceId }` or
`{ instance: true }`, and `listTraces` groups by trace in SQL (root name = the
parentless span's, else the earliest; duration = last end minus first start;
`status=error` is a HAVING on the failed-span count; search matches any span
name or the trace id through a subquery, so a match keeps the whole trace). A
trace page shows every span of the trace, any service, as long as one span is in
scope.

**Collector** (`DockerOtelMixin`, `docker/otel.ts` + `otel-container.ts`, run
like Garage, see `docker.md`): `otel/opentelemetry-collector-contrib` pinned in
`OTEL_IMAGE_TAG`. 0.162.0 was the latest release but Docker Hub never got that
tag (only ghcr did), so it's 0.161.0; check the tag on Docker Hub before a bump.
Receivers on 4317/4318 on the shared network only, `memory_limiter` + `batch`,
one `otlp_http` exporter (`otlphttp` is a deprecated alias in 0.161 and logs a
warning) with `encoding: json` to the app. The config file holds `${env:...}`
references only: the export base URL and bearer token are env vars, plus a
digest of the config (`HOMERUN_OTEL_CONFIG`), so `otelMatches` recreates the
container when the image, address, token or file change. The app's address is
`errorPagesTarget(config.authCheckUrl)`, the forwardAuth origin Traefik already
reaches (the `homerun-auth` alias in production, `host.docker.internal:<port>`
in dev, which is why the container gets `host-gateway` as an extra host).
Re-asserted from `CoreServicesWatch` when the toggle is on, which it is by
default (`otel_collector_enabled` null reads as on; only an explicit `false`
turns it off).

**Ingest** (`POST /api/v1/otlp/v1/traces`, not in the OpenAPI document): only
the collector calls it, with `Bearer otlpIngestToken(AUTH_SECRET)` (an HMAC with
its own label, compared in constant time). `hooks.server.ts` exempts the path
from the session/API-key layer (a bearer there isn't an API key) and the CSRF
check. JSON only (415 otherwise), 10 MB cap before and after gzip/deflate
(`decodeBody` from error tracking), parsed by the pure `parseOtlpTraces` (hex
ids validated, nanosecond strings through BigInt, `AnyValue` flattened, enum
names accepted). `spanOwner` maps a resource to a service by
`homerun.service.id`, then `service.name` = slug, only when that service has
traces on; `homerun`/`homerun-worker` are kept with no service; the rest is
dropped and still acknowledged (200 `{}`) so the collector doesn't retry it. The
service list is cached 30s and dropped when a service's toggle changes.

**Deploy env**: `withTracingEnv` (in `deployWorkerSpec`) adds the five `OTEL_*`
variables, never over a user-set one, and prepends `homerun.service.id=<id>` to
the user's own `OTEL_RESOURCE_ATTRIBUTES`. Previews start with traces off (a new
service row).

**Job traces**: every worker job span carries `homerun.job.id`;
`TraceSpanDTO.spansOfJob` finds its traces (one per attempt) through the partial
expression index `traceSpan_jobId_idx` on `attributes ->> 'homerun.job.id'`
where `service_id` is null, and the Scheduling job page renders each one's
waterfall.

**Retention**: `TraceRetentionScheduler`, hourly, deletes spans that started
before `traceRetentionDays` (7 by default, 1 to 90, Monitoring → Settings, which
is admin-only) in batches of 5000.

**Verified live** against a throwaway Postgres, the real worker and the real
collector container created through `reconcileOtel`: OTLP/JSON posted to
`homerun-otel:4318` from another container on the shared network landed in
`trace_span` through the gzip export (mapping by slug and by
`homerun.service.id`; a traces-off service and an unknown one dropped); a second
reconcile was a no-op and a config change recreated the container; a job leased
by the worker produced its job/execute/finish spans with the error recorded; the
list, search, error filter, sorts and pruning queries returned what they should.
Gotcha found there: Drizzle over bun-sql writes `jsonb` values as JSON strings
(every table here does), while the Go exporter's `::jsonb` casts store objects;
Drizzle reads both back as objects, so don't query span attributes with jsonb
operators without accounting for that.
