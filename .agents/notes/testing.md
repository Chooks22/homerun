# Testing

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Unit tests (`tests/`)

`bun:test`, run directly by Bun — `bun test --timeout 120000` (every
`test`/`test:*` script passes `--timeout` explicitly since `bunfig.toml`'s
`[test].timeout` key is silently unhonored on Bun 1.4.0). Covers
`tests/unit/app/`: the SvelteKit app itself. Tests live under
`tests/unit/<package>/`, not next to the source files they cover. `cmd/worker/`,
`cmd/cli/` and `cmd/installer/` are all separate Go packages (one repo-root
`go.mod`) and aren't part of `bun:test` at all, but their tests follow the same
not-next-to-source convention as the TypeScript side: every `*_test.go` in the
repo lives under `tests/unit/go/<same path as the package it covers>` (e.g.
`internal/httpapi/token.go` is covered by
`tests/unit/go/internal/httpapi/token_test.go`) as an external test package
(e.g. `package agent_test`, importing the real `agent` package), never inside
`internal/`/`cmd/` themselves. Getting there meant exporting the unexported
functions/types/fields each test exercises, rather than a same-package white-box
test or an `export_test.go` shim (which would have to stay in the package
directory). Fake/helper types shared by several test files in one package sit in
their own file in that same `tests/unit/go/...` directory (e.g.
`tests/unit/go/internal/agent/fake_docker_test.go`, shared by that package's
other test files). Run with:

```sh
go test ./cmd/worker/... ./internal/worker/... ./internal/agent/... ./tests/unit/go/internal/worker/... ./tests/unit/go/internal/agent/...
```

for the worker (including its agent mode), the `cli`/`installer` equivalents
scoped the same way, or all of it via
`go test ./cmd/... ./internal/... ./tests/unit/go/...` (part of `bun run test`).
Shared Go libraries under `internal/` (`buildinfo`, `release`, `homerun`,
`dockerapi`, `worker`, `jobs/*`, etc.) are covered the same way
(`tests/unit/go/internal/release/release_test.go`, etc.), scoped the same
path-narrowing way as any of them since there's no dedicated script per
sub-project. `tests/unit/app/` covers the SvelteKit app itself, a couple of
component tests plus the pure modules under `src/lib` that are worth pinning
down directly (`queue.test.ts`; `toast.test.ts`; `compose-import.test.ts`;
`service-link.test.ts`; `deploy-phases.test.ts`; `command-parse.test.ts`;
`auth-providers.test.ts`; `app-gate.test.ts`, the login wall's token
signing/expiry/tampering, its cookie parsing, and OIDC group-claim extraction) :
anything that's a real transform with no DB or Docker dependency belongs here
rather than in `tests/integration/`, which is still where most of `src/` is
exercised.

Run everything: `bun run test` —
`go test ./cmd/... ./internal/... ./tests/unit/go/...` first, covering
`cmd/worker/` (including its agent mode), `cmd/cli/` and `cmd/installer/`, then
`bun --config=bunfig.unit.toml test tests/unit` afterward for the app half. That
config's own `[test].preload` (not `bunfig.toml`'s) is what keeps this
unit-only: it doesn't preload `tests/integration/support/setup.ts` at all, so
the real-Postgres-container integration bootstrap never runs for it, unlike a
bare `bun test` (which reads `bunfig.toml`, does preload it, and gates it with
`HOMERUN_SKIP_INTEGRATION_SETUP` instead). Scope the Go half to one sub-project
the same way as above; there's no dedicated script per sub-project any more.
`tests/integration/` is a separate suite with its own `beforeAll`/`afterAll`
(real Postgres/Docker/worker, see `tests/integration/README.md`), and
`tests/e2e/` is a third, Playwright, outside `bun test` entirely (see E2E
browser tests below). `tests/integration/README.md` and `tests/e2e/README.md`
are the counterparts living next to the code.

**Where Postgres comes from, `HOMERUN_TEST_POSTGRES_URL`.**
`tests/integration/support/postgres.ts`'s `startTestPostgres()` is the one entry
point both `tests/integration/` and `tests/e2e/` resolve their database through,
and it branches on that env var alone: **set** (CI, where
`.github/workflows/code_quality.yaml`'s `ts-test` and `e2e.yaml`'s `e2e` jobs
each declare a job-level `services: postgres:` container) means connect to that
server and `create database` a uniquely-named per-run database on it, dropped
`with (force)` in teardown; **unset** (local dev, the default) means the
original behavior, a throwaway `postgres:18-alpine` container this suite
`docker run`s itself on a random host port (`support/postgres-container.ts`,
still the fallback, not dead code). Two reasons for the CI half, both about the
job no longer racing its own container: the runner pulls the service image and
gates every step behind its `pg_isready` health check before our code runs at
all (the inline `docker pull` eating the readiness budget on a cold runner is a
real, previously-observed CI failure documented in `postgres-container.ts`), and
a fresh database name per run is what makes a re-run meaningful — the second run
gets an empty database on the same still-running service container instead of
inheriting the first one's already-bootstrapped admin account. The deploy tests
still need a real Docker daemon either way; only Postgres moved. Verified live,
both paths: the full integration suite and the full Playwright suite each pass
against a stand-in service container (twice back to back, the re-run case, no
leaked databases) and against the local `docker run` fallback.

**Vitest was tried and abandoned for this suite.** It fixed the `[test].timeout`
bug above (real `hookTimeout`/`testTimeout` config) and gave each test file its
own module registry (no more `mock.module` leaking across files). But
`coverage.provider: "v8"` crashes under Bun once coverage from more than one
test file needs merging — `@bcoe/v8-coverage`'s recursive merge throws
`RangeError: Maximum call stack size exceeded`, reproduced directly, confirmed
independent of provider (`istanbul` avoided it, `v8` didn't). Given that, plus
`bun:test` being the simpler/native option, the suite moved back. `mock.module`
mutating one process-global registry is a real, accepted tradeoff again — every
`tests/unit/app/*.test.ts` that calls `mock.module` (e.g.
`docker-cleanup.test.ts`, `orchestration.test.ts`) has to coexist with the rest
of the suite in one process without colliding, restoring spies with
`mock.restore()` where it matters. This used to also cover the Bun-based agent's
own test suite (`tests/unit/agent/docker.test.ts` mocked `"dockerode"`
wholesale); that suite is gone along with the Bun agent, replaced by
`internal/agent/`'s own Go tests (imported by `cmd/worker`'s agent mode, no
standalone `cmd/agent/` any more), which fake the Docker client via a real
interface instead (`tests/unit/go/internal/agent/fake_docker_test.go`).

`tsconfig.json` (`include: ["src", "tests", "*"]`) type-checks `tests/` and the
root config files as part of `svelte-check` (part of `bun run type-check`, which
no longer passes `--tsgo`: tsgo can't resolve `.svelte` files through `#lib`
subpath imports), same as `src/`. Tests mock `$app/env` (not `$app/environment`)
and `mock.module` specifiers use the `#lib/...js` form. It used to exclude
`tests/` entirely, which meant ~115 test files had no type-checking gate at all;
re-including them surfaced a handful of real bugs (a `[Date, Date]` tuple cast
in `queue.test.ts` that should've been `[string, Date]`, a `never`-typed
`daemon` in `git-fixture.ts` from a TS/tsgo control-flow quirk that doesn't
re-widen a `let` narrowed to `null` across a closure call inside a `catch`
block, worked around with a `{ daemon: T | null }` object instead of a bare
`let`). `bun:test`'s `spyOn` needs an explicit `Mock<typeof console.log>`
annotation rather than `ReturnType<typeof spyOn>`, which resolves to `any` since
`spyOn`'s type parameters can't be inferred without a call site.

## `cmd/cli/`'s Go tests set `$HOME` per test, no preload needed

`internal/homerun/config.go`'s `ConfigDir`/`ConfigPath`, which the CLI's login
flow reads through, resolve the config file path from `os.UserHomeDir()`, which
re-reads `$HOME` on every call — unlike the old TypeScript CLI's `os.homedir()`,
fixed for the life of the process (reassigning `process.env.HOME` mid-run didn't
change it, verified on Bun 1.4.0), which is why that version needed
`tests/unit/support/homedir-preload.ts` mocking `node:os` via a `bunfig.toml`
`[test].preload`. `tests/unit/go/internal/cli/cli_test.go` just calls
`t.Setenv("HOME", t.TempDir())` per test instead, reset automatically by Go's
own test runner; there's no shared preload and nothing under
`tests/unit/support/` is involved for `go test`.

## Coverage

`bunfig.toml`'s `[test].coverage = true` turns on Bun's native coverage for
every run, scoped away from `tests/**` (`cmd/cli/generated/**` was in this
exclusion list too, back when that directory existed for the TypeScript CLI). No
threshold enforced yet.

## Retries (`bunfig.toml`'s `[test].retry`)

`retry = 2` retries a failing test up to 2x (3 attempts total) before it's
reported failed, to absorb transient CI flakiness (real Postgres/Docker in
`tests/integration/`). Unit and integration are the only suites this governs,
`test:e2e` is Playwright and `scripts/e2e-multipass.ts` is its own script,
neither reads `bunfig.toml`. `beforeEach`/`afterEach` **do** re-run around each
retry attempt (verified, only `beforeAll`/`afterAll` stay once-per-file), so a
test that cleans up per-test gets a genuinely fresh attempt rather than
inheriting the failed one's leftovers.

`[test].rerunEach` (run every test file N times, to surface a flake rather than
hide one) is the opposite policy and **cannot be combined with `retry`**, Bun
1.4.0 hard-errors (`"retry" cannot be used with "rerunEach"`) when both are set,
whether both are in this file or split across the file and a CLI flag. Running
it therefore needs a separate config file (`bun test --config=<file>`, which
replaces `bunfig.toml` rather than merging with it), which is why there's no
rerun policy checked in here.

## Fakes over mocking libraries

`internal/installer/exec.go`'s `Runner` is a real Go interface (`StepRunner`
implements it), so its Go tests
(`tests/unit/go/internal/installer/steps_test.go`, `fullstack_test.go`,
`migrate_test.go`, `flow_test.go`, `main_test.go`, sharing a `fakeRunner` from
`support_test.go`, all in that same directory) pass a fake implementation
instead of the real one, no mocking library needed. Before the Go rewrite, the
same collaborator was a TypeScript interface and its `bun:test` tests
(`tests/unit/installer/`, now gone) took the equivalent shortcut with a plain
object literal and `mock()`-wrapped methods.

## Real bugs this suite caught

- `Bun.write(path, data, { mode: 0o600 })`'s `mode` option is silently a no-op
  on Bun 1.4.0 — the file lands with whatever the umask produces (0644 under the
  common 022 umask) regardless of what's passed. The old Bun-based agent's
  persisted token — a full-access API credential — was affected by exactly this,
  fixed at the time by calling `node:fs/promises`'s `chmod()` explicitly after
  `Bun.write` (`node:fs`'s own `mode` option is honored, verified). The agent's
  Go rewrite sidesteps the whole bug class: `internal/agent/token.go`'s
  `resolveToken` calls `os.WriteFile(tokenFile, token, 0o600)` then an explicit
  `os.Chmod`, both of which Go actually honors. If a future change writes
  another secret to disk via `Bun.write` anywhere in this repo, `chmod`
  afterward too.
- `bunfig.toml`'s `[test].timeout` key is silently not honored by Bun 1.4.0 for
  `test()` bodies — every `test/test:*` script passes `--timeout 120000` on the
  CLI instead.
- `[test].retry` genuinely is honored (verified: a test failing on attempts 1-2
  and passing on 3 reports as 1 pass under `retry = 3`, no CLI flag needed), but
  `[test].rerunEach`'s config key is camelCase only, the CLI flag's own spelling
  (`rerun-each`, kebab-case) is silently ignored as a bunfig key, same failure
  mode as `[test].timeout` above just for a different key. See Retries below.
- Bun's `Bun.serve()` `idleTimeout` (10s by default, now set to `0` in the
  adapter config) kills a request that's still _being handled_, not just an idle
  socket, and only on Linux — so `POST /services/<id>/stop` died with
  `ECONNRESET` in CI while passing on every macOS dev machine. Caught by
  `tests/integration/`, root-caused by reproducing it in `oven/bun:1.4.0`. See
  Long-running requests and Bun's idle timeout below.

This section is scoped to what `tests/` itself caught; a sibling finding from
the same "Bun's own APIs quietly diverge from `node:fs`" family, but caught by
manual live installer testing rather than this suite, lived in the old
TypeScript installer's `steps/rootless-docker.ts` doc comment:
`Bun.file(path).exists()` could return `true` for a `/proc` pseudo-file while
`.text()` silently returned `""`, `node:fs/promises`' `readFile` read it
correctly. Moot since the installer's Go rewrite — Go's `os.ReadFile` has no
such quirk, and `internal/installer/docker.go`'s doc comment on
`AllowRootlessUserns` records the history. See Homerun Agent + installer below.

## E2E browser tests (`tests/e2e/`, `playwright.config.ts`)

**This repo has a real browser harness again** (an earlier session deleted the
previous one in `feat: better classes`, `87c925d`, and this document said for a
while that none existed, that's stale, it was rebuilt from scratch rather than
un-deleted). Real Playwright driving real Chromium against a real _built_ app
(`bun run build` first, this suite doesn't build for you) backed by a throwaway
Postgres container, run with `bun run test:e2e`, deliberately outside
`bun run test`, Playwright is its own runner and `bunfig.toml`'s retry/coverage
settings don't reach it. See `tests/e2e/README.md` for the full detail; the
load-bearing parts:

- **`globalSetup` runs under Node, not Bun.** Playwright's CLI has a
  `#!/usr/bin/env node` shebang, so even `bunx playwright test` runs the config
  and its `globalSetup` under Node (verified: importing
  `tests/integration/support` there fails with `Cannot find package 'bun'`, that
  code uses `Bun.SQL`/`Bun.spawn` throughout). `support/global-setup.ts`
  therefore spawns `support/bootstrap-runtime.ts` as a genuine `bun run` child
  process, which starts Postgres, migrates, spawns the built app, prints one
  `READY <json>` line once `/api/health` answers, and stays alive until it's
  SIGTERM'd at teardown.
- **Fixed port, one shared app instance.** Playwright reads `use.baseURL` at
  config-load time, before a `globalSetup` could resolve a free port the way
  `tests/integration/` does, so the port is fixed (`support/config.ts`) and
  `workers: 1`/`fullyParallel: false` share one live app+database across every
  spec. Don't run this suite twice concurrently on one machine, and create a
  fresh account per spec file rather than assuming a clean slate (see
  `bootstrap.spec.ts`'s `test.describe.serial` for depending on order _within_ a
  file).
- **Auth rate limiting is disabled for it** (`HOMERUN_DISABLE_AUTH_RATE_LIMIT=1`
  on the spawned app), see Auth below for the real finding behind that.
- **`bunfig.toml` excludes it from `bun test`**
  (`pathIgnorePatterns = ["**/tests/e2e/**"]`), these specs match `bun test`'s
  own `*.spec.ts` discovery and would otherwise be picked up and fail there.
- **`E2E_IMAGE` runs the suite against a built Docker image instead of the local
  `build/server` binary** (`tests/integration/support/app-container.ts`'s
  `startAppContainer`, chosen by `bootstrap-runtime.ts` when the variable is
  set). This is how CI tests the exact artefact it is about to publish rather
  than a second build of the same source, see the CI pipeline note under Release
  automation below. Everything else about the harness is unchanged : the same
  throwaway Postgres, the same migrations, the same fixed port, the same
  health-check wait. Two details are load-bearing : on Linux (CI) the container
  runs with `--network host`, so `DATABASE_URL` and the port need no rewriting
  and, more importantly, `docker run` creates no veth or port proxy. A bridged
  container's new interface fires a netlink address change a second or two after
  it starts, right as Playwright's first navigation is in flight, and Chromium
  aborts every pending request on that with `net::ERR_NETWORK_CHANGED` : the
  sign-up page's JS chunks failed, SvelteKit rendered its 500 page, the
  bootstrap spec never created the admin, and ten more specs failed behind it
  (the `main` run for PR #17, green on the PR itself). Elsewhere (Docker Desktop
  has no host networking by default) it stays bridged, with
  `localhost`/`127.0.0.1` in `DATABASE_URL` rewritten to `host.docker.internal`
  and `--add-host=host.docker.internal:host-gateway`; and `assertAppIsBuilt()`
  is skipped in image mode, since there is no local build to assert on. The
  container also runs under a **fixed** name (`homerun-e2e-app`), removed before
  each start rather than given a unique one : a container left behind by a
  crashed or killed run otherwise holds the suite's fixed port forever, and CI's
  three whole-suite retries all failed on
  `Bind for 0.0.0.0:4310 failed: port is already allocated` before the app could
  even start. Safe for the same reason the port is fixed, this suite already
  can't run twice concurrently on one machine. **Verified live**: the full suite
  against a locally-built `app` image passes 23/23, and passes again with a
  leaked container already holding 4310, which is the retry case that was
  failing.

Covered today: blank-instance bootstrap sign-up landing on `/onboarding`, the
sign-up→sign-in redirect once an account exists, clicking the whole onboarding
wizard through to completion, sign-in/sign-out, the service-creation wizard's
own submit path, (`remote-functions.spec.ts`) the remote-query/command surfaces,
that the dashboard's Host Resources panel, the notification feed and the
job-queue panel each resolve past their skeleton against real data, and that a
mark-read/delete command updates the feed with no page reload, and
(`ui-login-wall.spec.ts`) the Authentication page's presets and the service
Access section's reveal-and-validate behaviour, and (`ui-form-state.spec.ts`)
that a saved settings section keeps its field values and that the compose-import
page's Import step accepts the file its own Parse step previewed, the two halves
of the `reset` bug under Conventions above, and (`ui-cli.spec.ts`) the `homerun`
CLI, a Go program compiled from source in `beforeAll`, run against the same
instance, logged in through its real device-code flow approved in the browser,
then every list/get command, the flag/env overrides, 401/404 exits and logout
(`bun run test:e2e tests/e2e/bootstrap.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/ui-cli.spec.ts`
runs it with only the bootstrap and onboarding specs ahead of it; see
`tests/e2e/README.md` for why it strips `FORCE_COLOR` from the CLI's env). Not
covered by the specs above: a real deploy (the screenshot pipeline and the
template deploys below do, on purpose, and are the only things here that touch
Docker). Add browser-level cases here; don't re-prove API shapes
`tests/integration/` already covers directly and faster.

## Screenshots for the docs (`tests/e2e/screenshots/`, `bun run screenshots`)

The images in `docs/images/`, which `docs/showcase.md` and the README's hero
both publish, are **generated, not taken by hand** : `bun run screenshots` runs
`tests/e2e/screenshots/docs-screenshots.spec.ts` through
`playwright.screenshots.config.ts`. It reuses the E2E harness above (same
`globalSetup`, same throwaway Postgres, same fixed port, same `bun run build`
prerequisite) but has its own config so the ordinary `bun run test:e2e` doesn't
shoot screenshots on every run : `playwright.config.ts` carries
`testIgnore: "screenshots/**"` for exactly that reason, and the screenshot
config's `testDir` points at the subfolder.

- **It signs in once.** The bootstrap test saves `storageState` to
  `test-results/screenshots-auth.json` and every later test runs under
  `test.use({ storageState })`. Signing in per test meant ~26 sign-ins inside
  two minutes and produced its own flake (a sign-in that silently didn't
  navigate, failing whichever shot drew it). The sign-in shot itself sits
  outside that describe, so it gets a clean signed-out context.
- **It bootstraps its own world.** A blank instance means signing up, clicking
  through onboarding (with Base domain set to `example.com`, so the hostnames in
  the shots read like a real deployment rather than `127.0.0.1`), then seeding a
  stack and three services through `POST /api/v1/stacks` and
  `POST /api/v1/services` : `page.request` shares the browser context's cookie
  jar, so the session authenticates the API calls with no key to mint.
- **Two of those services are really deployed**, through
  `POST /api/v1/services/:id/deploy`, which is what makes the dashboard, the
  status pills, the deployment history and the live log viewer show real state
  instead of empty states. That works because the default harness spawns the app
  as a **local process** sharing the host's Docker daemon. It would not work
  under `E2E_IMAGE`, where the app runs in a container with no socket mounted :
  don't set that variable for this pipeline.
- **The Monitoring shot has real traffic behind it.** `beforeAll` starts the
  templates suite's throwaway Traefik (`tests/e2e/templates/traefik.ts`'s
  `startTraefikWith`, with the Prometheus metrics flags), which the app finds by
  image like a real install's. After the deploys, a timer sends HTTPS requests
  (a few of them 404s) through it to the marketing site, and the Monitoring shot
  runs last, reloading until the sampler has recorded requests and a resource
  sample (`waitForMonitoring`, up to 150s). The timer and Traefik are stopped in
  `afterAll`.
- **Nothing that shows the host running the pipeline.** Docker Cleanup was tried
  and dropped: it lists every image, container and volume on the machine, which
  on a developer's box is their own unrelated projects.
- **It cleans up after itself in `afterAll`, not in a final test.** Playwright's
  serial mode skips the rest of the file after a failure, so a teardown written
  as the last `test()` leaks the containers _and_ the stack's Docker network the
  moment any single shot fails — which is the exact leak behind "Reclaim stack
  networks whose stack row is gone" in `TODO.md`. `afterAll` runs either way.
  (The stack is deleted by POSTing its `?/delete` form action with an
  `x-sveltekit-action` header, since stacks have no REST DELETE.)
- **Dark mode is `page.emulateMedia({ colorScheme })`**, which works only
  because the account's theme preference defaults to `system` and the browser
  context is fresh, so `mode-watcher` has no `localStorage` override to prefer.
  If a shot ever needs a signed-in account with an explicit theme, set that
  entry instead.
- **Don't wait on `networkidle`** anywhere in these specs. The dashboard polls
  stats every 5s and the log viewer holds an SSE connection open, so it never
  settles; the spec waits on `domcontentloaded` plus a fixed beat.
- Each shot asserts its own URL and a page-specific string before the shutter,
  so a redirected, blank or broken screen fails the run rather than being
  published as marketing. Adding a shot means adding one entry to `SHOTS` and a
  section to `docs/showcase.md`; `docs/images/README.md` is written by the run
  itself.

**In CI it runs two ways, and only one of them commits.** `screenshots.yaml` is
a `workflow_call` job wired into `pull_request.yaml` (off `code_quality`, in
parallel with the image builds): it builds from source, pre-pulls the two images
the seed deploys, captures everything and uploads `docs/images` as an artefact.
It proves the generator still works and is, with the template deploys below, the
only job in CI that performs a **real deploy** — `e2e.yaml` can't, because it
runs the app as a container with no Docker socket. It does **not** commit
anything. The capture step is a plain `run:` with a step-level
`timeout-minutes`, like `e2e.yaml`'s and `code_quality.yaml`'s: all four steps
used to be wrapped in `nick-fields/retry` (one run in six against a shared
Postgres failed at the seeding step and passed on re-run), and the wrapper was
removed because it buried the first attempt's output behind two more, which is
exactly what you need to read when the failure turns out not to be flake. Re-run
the job by hand instead. `screenshots-refresh.yaml` (`workflow_dispatch`,
`contents: write`) calls that same workflow, downloads the artefact over
`docs/images/`, and commits the result with `[skip ci]`, then pings the docs
site the way `docs-update.yaml` does — `[skip ci]` stops the push from
re-running the whole publish pipeline, and a `GITHUB_TOKEN` push wouldn't
trigger `docs-update.yaml` anyway.

**The gallery refreshes once per stable release, not per merge.**
`publish.yaml`'s `stable-screenshots` job calls `screenshots-refresh.yaml` (also
`workflow_call`) after `stable-release`, so the published images track what
users actually run. Not per merge because the images can't be diffed for drift:
the pages carrying live data (the dashboard, a service's overview, the log
viewer) come out byte-different on every run — live CPU%, "just now", the
container's random name suffix — so ~8 of the 26 files change even when nothing
in the app did, and image blobs don't delta-compress. The commit step rebases
onto the branch tip before pushing, since main can move during the ~20 minute
capture. Run the refresh workflow by hand to update between releases.

`docs/images/README.md` is written by the run itself and must come out already
prettier-formatted (the spec hard-wraps its one prose line exactly where
prettier would): a generated file that the pre-commit hook then reformats fights
the next regeneration forever.

**A spec file that signs in as the bootstrap admin must sort after
`onboarding.spec.ts`**, hence the `ui-` prefix on the ones that do: Playwright
runs files in discovery order with one shared app, so a spec landing before
onboarding finishes is bounced to `/onboarding` by the layout's own gate.
Anything Docker-touching is still out : importing a compose file into a _stack_
creates a Docker network, so `ui-form-state.spec.ts` imports ungrouped on
purpose.

**An error toast can deadlock a click, and it took a CI failure to find out.**
The toaster is `bottom-right` (`+layout.svelte`) and so is the wizard's step
nav, so after a failed submit the toast sits on top of "Next". Playwright moves
the mouse to click, the pointer lands on the toast, hovering **pauses sonner's
own dismiss timer**, and the click retries until the 30s test timeout — every
attempt, deterministically, which is why `service-wizard.spec.ts` now dismisses
the toast (`getByRole("button", { name: "Close toast" })`, the toaster has
`closeButton`) before driving the wizard forward. Two things to carry: a toast
overlapping a control isn't flake, and `role="alert"` inline banners (the
`Alert` component) are _not_ toasts and stay put, so don't assert them hidden.

**Don't assert on what the Docker daemon said.** This suite runs against a real
daemon locally and against a socket-less container in CI, so the same remote
query succeeds in one and fails in the other : an assertion on either outcome
only passes in one place. `remote-functions.spec.ts`'s Docker-backed cases
assert the _page's own chrome_ renders — which is exactly what a blocking `load`
used to withhold — and the failed branch of `AsyncBlock` is covered
deterministically in `tests/unit/app/async-block.test.ts` instead. A first pass
that asserted the failure alert passed in CI and failed on a dev machine.

## Template deploys (`tests/e2e/templates/`, `playwright.templates.config.ts`)

Deploys every built-in template, one Playwright test each, on a real Docker
daemon and checks it comes up healthy. Same harness as the screenshots (the
shared `globalSetup`, local-process app and worker, no `E2E_IMAGE`), its own
config because it's slow (an hour-plus for the whole catalog) and needs a
socket. `playwright.config.ts` ignores `templates/**`.

```sh
bun run build
TEMPLATES_E2E_ONLY=redis,umami bunx playwright test --config playwright.templates.config.ts
```

- **A `setup` project signs up and finishes onboarding once**, saving
  `test-results/templates-auth.json`; the `templates` project depends on it and
  runs `fullyParallel` with `TEMPLATES_E2E_WORKERS` workers (3 by default: the
  job queue has 3 slots) and `retries: 1`.
- **A second `globalSetup`, `templates/traefik.ts`, runs a throwaway
  `traefik:v3`** (`homerun-e2e-traefik`, removed first if a crashed run left it)
  on the `homerun` network with the docker provider, publishing its `websecure`
  entrypoint on `E2E_TRAEFIK_PORT` (4443), not 443, so it doesn't collide with a
  dev Traefik.
- **Each test**: pre-pulls the template's and companions' images with the
  `docker` CLI (3 attempts with backoff, and the CLI uses the runner's
  `docker login`, which the worker's own Engine API pull doesn't), then POSTs
  the gallery's `?/quickDeploy` form action, the real Quick Deploy path (stack,
  companions, `{{secret}}`, default data volumes); there's no REST route for
  deploying a template. It waits on `GET /deployments?limit=1` for each service,
  companions first; a failed one is redeployed up to twice through
  `POST /deploy` after `PATCH pullPolicy: missing`, and once a companion was
  redeployed the primary is redeployed directly, since its queued job was
  cancelled with the chain. Then every service's current revision must reach
  `healthy` from the app's own health watch (`GET /revisions`), and every
  container with Traefik router labels must answer `https://<host>/` through the
  e2e Traefik (SNI + Host header, self-signed cert accepted) with anything but a
  5xx or Traefik's own "404 page not found".
- **Cleanup in `afterEach`** (with 10 more minutes on the clock, so a timed-out
  test still cleans up): deletes the stack (`?/delete` form action with `force`)
  or the lone service (`DELETE ?force=true`), `docker rm -f`s any container
  left, removes every volume the containers mounted, and under `CI` removes the
  images the test pulled, so a runner's disk survives the catalog. Storage
  volume rows stay in the throwaway database.
- **`SKIP` in `deploy.spec.ts`** is the explicit list of templates that can't
  run headless, each with its reason; they're reported as skipped, never
  silently dropped.
- **`templates/report.ts`** prints one line per template at the end (outcome of
  its last attempt, duration, the route answers or the first error line) and
  appends the same table to `$GITHUB_STEP_SUMMARY`. A failure also attaches the
  last 150 log lines of each container.

In CI it's `templates-e2e.yaml` (`workflow_call`, optional `ref` input and
`templates` slug list, every template when empty), called from
`pull_request.yaml`, `publish.yaml` and `template-versions.yaml`; see
`packages-and-release.md`. It's a matrix, one job per template: `plan` builds
the app once, uploads it as a tarball (an artifact loses the binaries' exec bit)
and lists the slugs; each `deploy` job downloads it and runs the suite with
`TEMPLATES_E2E_ONLY` set to its one slug and one worker, so every template gets
its own log, its own trace artifact on failure and its own pass/fail in the
run's UI; `summary` adds the jobs' Playwright JSON results back into the
`summary` output the callers read, counting only the `templates` project (each
job's `setup` test isn't a template). `max-parallel: 20` is the free plan's
concurrency cap; public repositories don't pay for standard runners. A job pulls
one template's images, so the "free 30GB" step the single job needed is gone. A
job logs in to Docker Hub when the registry secret is there.
