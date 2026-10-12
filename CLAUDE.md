# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## How to work here (read this first)

**Don't think like enterprise.** No phased rollouts, no "Phase 1 / Phase 2", no
priority tiers, no migration plans, no risk matrices, no asking whether we
should ship it. This is a one-person hobby PaaS, not a bank. Just do the work
and ship the software. If it breaks, we open an issue and fix it. Nobody dies.

Concretely:

- Do the whole change in one go. Don't split it into stages and hand back a plan
  for the rest.
- Don't ask permission to proceed on something already asked for. Do it.
- Don't rank findings by severity or write a rollout strategy. Fix what's
  broken, mention what you skipped in one line.
- No feature flags, no backwards-compat shims, no deprecation windows. There's
  one instance and one user. Change the thing.
- Breaking a migration, losing dev data, or needing a manual step is fine. Say
  so, move on.
- The conventions below (types, DTOs, toasts, no comments, `bun run check`
  clean) still apply. Being fast isn't licence to leave the repo broken.
- **End every turn that edited files with a suggested one-line commit message**,
  in a code block, conventional-commit style (`feat: ...`, `fix: ...`). One
  line, even for a large batch of unrelated changes: summarise, don't list. Only
  suggest it, never commit.
- **When a commit is made anyway** (a hook or an explicit ask), it's authored
  and committed as `Oro <orochibraru@gmail.com>`, set with
  `git config user.name`/`user.email` first. No `Co-Authored-By`, no session
  link, no mention of Claude anywhere in the message.
- **A PR title is always a conventional commit** (`feat(scope): ...`,
  `fix: ...`, types
  `feat|fix|perf|refactor|docs|chore|ci|build|test|style|revert`), since the
  squash merge uses it as the commit message and
  `.github/workflows/pr-title.yaml` fails the PR otherwise. Same rule for the PR
  body as for commits: no Claude mention, no session link.

**Work out of `TODO.md`.** It's the backlog, and it's the only one. Don't write
a plan in chat, don't keep a task list somewhere else, don't hand back a
"proposed roadmap".

- Picking up work with no specific ask : take something from `TODO.md` and do
  it.
- **Keep `TODO.md` current as you go, not at the end.** Before starting an item,
  mark it `- [ ] **[WIP]** …`; the moment it's actually done, tick it and move
  it under `## Done`. If you stop half-way, leave it `[WIP]` with a line saying
  what landed and what didn't. The file is the shared view of what's in flight :
  it's how anyone else knows which files are safe to touch while you're working.
- Finished an item : tick it off and move it under `## Done` in the same change,
  not in a follow-up.
- Found something out of scope mid-task : add a line to `TODO.md` and carry on.
  Don't stop, don't ask, don't do it anyway.
- The `Small`/`Medium`/`Large` headings are rough size, not priority. There is
  no priority ordering, don't add one.
- **No personal data in `TODO.md`, ever.** It gets committed and pushed. No real
  Homerun instance (its domain, URL, IP, hostname), no service/stack names,
  slugs or ids from a live instance, no emails, usernames, tokens or log
  excerpts carrying any of those. Describe the bug generically ("a swarm service
  with two replicas"), not by pointing at the instance it was seen on.

## What this is

Homerun, a self-hosted, single-user PaaS for deploying Docker containers with a
click-config form (a minimal Dokploy/Cloud-Run alternative). Point at an image
(or a git repo, see `.agents/notes/services-and-templates.md`), fill in env
vars/port/resources, deploy, Traefik auto-routes it to `<slug>.<baseDomain>`
with TLS. Single host, local Docker socket only; no multi-node orchestration. A
service is either "bring-your-own-image" (the original/default) or "build from a
git repo" (clones + builds a Dockerfile locally, no registry involved), see
Git-based builds below.

Stack: SvelteKit 3 (Svelte 5 runes, `@sveltejs/adapter-bun`) + Bun runtime,
better-auth, Drizzle ORM over Postgres (via Bun's built-in `SQL` client,
`drizzle-orm/bun-sql`, no `pg` dependency needed), Tailwind v4 + shadcn-svelte
("vega" style). The app holds no Docker socket itself: every Docker call goes
over HTTP to the Go worker (`cmd/worker`), which is the only process that opens
one, see `.agents/notes/docker.md` and `.agents/notes/worker.md`. `dockerode` is
a devDependency now, used only by an integration-test fixture, not by the app.

## Commands

`mise install` installs the pinned Bun, Go and prek from `mise.toml` and runs
`mise run docker` (daemon + compose check, creates the `homerun` network);
bumping one means updating its other pins too, see `CONTRIBUTING.md`'s Toolchain
section. golangci-lint is pinned separately, in its own module
(`tools/go/go.mod`, kept out of the root `go.mod` so its ~210 indirect deps
don't feed minimum-version-selection into the binaries this repo ships), run via
`go tool -modfile=tools/go/go.mod golangci-lint run ./cmd/... ./internal/... ./tests/unit/go/...`;
bump it with
`cd tools/go && go get -tool github.com/golangci/golangci-lint/v2/cmd/golangci-lint@vX`.

```bash
bun run dev              # scripts/dev.ts: vite plus the Go job worker (cmd/worker), rebuilt and restarted on every .go change; `--only=app`/`--only=worker` runs one half alone
bun run build            # bun run gen && vite build
bun run start            # ./build/server (the standalone binary adapter-bun compiles, serve the built app)
bun run gen              # svelte-kit sync + regenerate openapi.json, tests/integration/support/openapi-types.ts, homerun.schema.json, the Terraform provider's spec.json and its registry docs from source, CI fails if the result isn't committed
bun run check            # svelte-check --fail-on-warnings (no `--tsgo`: tsgo can't resolve `.svelte` files through `#lib` subpath imports), tsc over scripts/, go vet, and golangci-lint (`go tool -modfile=tools/go/go.mod`), the same two over the Terraform provider's own module (`go -C terraform/provider`), the whole gate in one command, see `.agents/notes/testing.md`
bun run lint             # markdownlint-cli2, scripts/lint-tailwind.ts (Tailwind class sorting) and oxlint --type-aware --deny-warnings (`.oxlintrc.json`; Biome's linter is off, suppress an oxlint rule with `// oxlint-disable-next-line <rule> -- <reason>`)
bun run lint:fix         # the --fix half of all three
bun run lint:ai          # agnix --strict over CLAUDE.md, AGENTS.md, .agents/ and .claude/ (`.agnix.toml` disables its prose heuristics), also a prek hook; agnix is a trusted dependency because its postinstall downloads the binary
bun run format           # prettier --write over **/*.md, then biome format --write (formatting only, doesn't gate `bun run lint`; import sorting/formatting is enforced at commit time by the pre-commit hooks instead)
bun run db:generate      # drizzle-kit generate, regenerate migrations from src/lib/server/db/schema.ts, the app applies them itself at boot
docker compose up -d     # bootstraps Traefik + Postgres for local dev (compose.yaml, needs `docker network create homerun` once), required, the app has no fallback DB, see .agents/notes/docker.md
```

`preinstall` (`only-allow bun`) and `prepare` (`prek install`, wires the git
hooks from `.pre-commit-config.yaml`) run on `bun install`.

```bash
bun run test              # svelte-kit sync && go test ./cmd/... ./internal/... ./tests/unit/go/..., go -C terraform/provider test ./..., then bun --config=bunfig.unit.toml test tests/unit; unit only, no Postgres/Docker needed
bun run test:integration  # tests/integration/ only, real Postgres/Docker/worker, see that suite's own README
bun run test:e2e          # playwright test, tests/e2e/, real Chromium against a real built app, needs bun run build first, see .agents/notes/testing.md
bun run screenshots       # regenerate docs/images/ through playwright.screenshots.config.ts, same prerequisites as test:e2e plus a Docker daemon (it really deploys); CI reruns it and commits the result after every stable release
```

Package.json's script list is deliberately short (16 entries): there's no
`bun run release` (releases run entirely in CI, driven by
`orochibraru/releaser`, see `.agents/notes/packages-and-release.md`), and a
handful of scripts that used to exist are now just the raw command, run directly
instead of through a name: `bun run build:app` → `bun run build`;
`bun run build:packages` → `bun scripts/build-packages.ts`;
`check:app`/`check:go`/`check:scripts`/`check:packages`/`check:agent`/
`check:cli`/`check:installer` → `bun run check` (or the scoped raw command, e.g.
`go test ./internal/cli/...`, for one slice of it);
`lint:md`/`lint:ts`/`lint:tailwind`/every `lint:fix:*`/`format:*` →
`bun run lint`/`lint:fix`/`format`; `test:unit`/`test:unit:app`/
`test:unit:agent`/`test:unit:cli`/`test:unit:installer`/`test:go` →
`bun run test` (scope with `go test ./internal/cli/...` or
`bun --config=bunfig.unit.toml test tests/unit/app` etc.); `test:e2e:cli` →
`bun run test:e2e tests/e2e/bootstrap.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/ui-cli.spec.ts`;
`e2e:multipass`/`e2e:multipass:release` → `bun scripts/e2e-multipass.ts` /
`bun scripts/e2e-multipass-release.ts`; `dev:app`/`dev:worker` →
`bun run dev --only=app`/`--only=worker`; `dev:agent` → gone, there's no
standalone agent to run any more, `go run ./cmd/worker` with no `DATABASE_URL`
is agent mode (see `.agents/notes/packages-and-release.md`); `component:add` →
`bunx shadcn-svelte add`; `auth:db:generate` → `bunx auth generate`; `preview` →
gone, use `bun run build && bun run start`.

`cmd/cli/` and `cmd/installer/` are standalone Go programs (a single Go module
at the repo root, `go.mod`, no `tsconfig.json`/`package.json` of their own), not
part of the SvelteKit app above and not covered by `svelte-check`; so is
`cmd/worker/`, which builds the same `homerun-worker` binary that runs both next
to the app and as the standalone agent-mode binary on a remote build host (see
`.agents/notes/packages-and-release.md` and `.agents/notes/worker.md`;
`cmd/agent/` doesn't exist any more, it was merged into `cmd/worker`). Shared Go
libraries live under `internal/` (`internal/buildinfo`, the version stamped via
`-ldflags` at build time; `internal/release`, release asset naming/URLs/
download; `internal/homerun`, the CLI's config and API client;
`internal/dockerapi`, a stdlib Docker Engine API client over the unix socket the
worker drives). `go vet ./cmd/... ./internal/... ./tests/unit/go/...` plus
`golangci-lint` over the same paths (part of `bun run check`) cover all of it in
one pass; scope either to one sub-project by narrowing the path
(`./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...`, etc.). All
three still compile via `scripts/build-packages.ts`
(`bun scripts/build-packages.ts`), and because Go's `GOOS`/`GOARCH`
cross-compilation is exact, every target builds from any one runner: the CLI's
macOS binaries are cross-compiled from a Linux runner too, with no macOS runner
in CI at all — the installer and the worker get no macOS build at all, they only
ever run on the Linux box they're installed on (see
`.agents/notes/packages-and-release.md`). See that note and
`.agents/notes/api-and-cli.md` for what each sub-project is.

Test suites, the Postgres/CI wiring and the gotchas behind these scripts:
`.agents/notes/testing.md`.

## AI-assisted development (`.claude/agents/`, `.claude/skills/` → `.agents/skills/`)

This repo has Claude Code skills and subagents encoding the workflows below in
executable detail, not just prose, use them instead of re-deriving the steps by
hand:

- Skills (invoke directly, or they trigger on a matching request): `check-repo`
  (the `bun run check`/`bun run lint`/unit-test/codegen gate above, as a
  runnable checklist), `new-dto-route` (schema → DTO → route, with the
  no-manual-typing/no-raw-Drizzle/toJSON rules below baked in),
  `new-docker-mixin` (adding a concern to `DockerService`'s mixin chain, with
  the load-bearing ordering rule), `migration-workflow` (`schema.ts` →
  `db:generate` → apply, with the NOT-NULL-on-existing-rows gotcha),
  `new-api-route` (a route under `src/routes/api/v1/`, its zod body schema, the
  OpenAPI registry and `bun run gen`), `new-tab-route` (one route per tab under
  a shared `TabNav` layout), `new-remote-function` (a query/command under
  `src/lib/remote/`), `shadcn-svelte` (adding or composing a UI primitive). A
  skill or agent whose frontmatter isn't valid YAML silently loses its
  description (and an agent disappears entirely): write `description: >-` with
  the text indented below it, since a plain multi-line value breaks on the first
  `:` inside it.
- Subagents (`.claude/agents/*.md`): `repo-gate` (final review gate before
  calling a change done, scans for this file's own hard rules),
  `scaffold-feature` (adds a new table+DTO+route end to end), `subproject-sync`
  (keeps `cmd/worker/`'s agent mode's hand-reimplemented Docker/stats logic in
  sync with the main app, regenerates
  `tests/integration/support/openapi-types.ts` after a REST API change),
  `ui-consistency` (flags route markup that reimplements an existing shared
  component/primitive instead of using it, and visual drift between equivalent
  pages), `docs-sync` (use PROACTIVELY after a code change that
  adds/removes/changes a feature, checks this file itself, and
  `TODO.md`/sub-project READMEs, for exactly the kind of staleness this bullet
  list itself just had two live examples of: `ui-consistency` missing from here,
  and three shipped features still marked unbuilt under planned features, both
  fixed in the same session `docs-sync` was added), `docs-audit` (the full sweep
  `docs-sync` isn't: starts from the code, not a diff, and checks every `docs/`
  page, root `README.md` and sub-project README against routes, settings, env
  vars, API, CLI and installer, both directions), `doc-comments` (finds every
  class method and exported function outside route files, generated code, tests
  and `ui/` primitives with no JSDoc block, writes it, and fixes blocks that no
  longer match their signature), `devex` (walks the contributor path, fresh
  clone → setup → dev → test → gates → CI, and fixes the friction: undocumented
  or broken scripts, `.env.example` drift, local gates that don't match CI,
  tooling overlap, stale `.agents/notes` paths, slow or flaky tests),
  `docs-consistency` (reads the operator docs as one set: the same fact stated
  differently on two pages, a UI label or term spelled two ways, broken menu
  paths, links and anchors, an index that misses or misdescribes a page, pages
  that stopped making sense, verifying what it touches against the code;
  `docs-audit` owns exhaustive code-to-docs coverage).

Skill content lives under `.agents/skills/<name>/SKILL.md` with a symlink from
`.claude/skills/`, matching the existing `shadcn-svelte` skill's layout, keep
that pattern for any new skill.

## Conventions (strict, apply to every change)

- **SvelteKit 3 idioms, not the 2.x ones.** There is no `$lib` alias: imports
  are `#lib/...` Node subpath imports (`package.json` `imports`) written _with_
  the file extension, `.ts` module → `#lib/foo.js`, `.svelte.ts` →
  `#lib/foo.svelte.js`, component → `#lib/components/x.svelte`, directory index
  → `#lib/components/ui/button/index.js`; tests' `mock.module(...)` specifiers
  use the same form. `$app/environment` is `$app/env`. `resolve()` takes
  pathnames with no leading slash (`resolve("services")`, home is
  `resolve("")`); only route ids start with `/`
  (`resolve("/(protected)/services/[serviceId]", { serviceId })`).
  `invalidateAll()` is `refreshAll()`, and `goto`'s `keepFocus`/`noScroll` are
  `reset: false`, `replaceState` is `replace`, `invalidateAll: true` is
  `refreshAll: true`. `json()`/`text()` from `@sveltejs/kit` aren't used:
  `Response.json(...)` / `new Response(...)`. An off-origin `redirect` needs
  `redirect(status, url, { external: true })` (kit 3 throws a 500 otherwise).
  `handleError` in `hooks.server.ts` and `hooks.client.ts` receives every error
  with a `kind` (`"app" | "framework" | "validation" | "unknown"`); both only
  log/transform `kind === "unknown"` and return nothing otherwise.
- **Never manually type anything in a route file**, `+page.svelte`,
  `+layout.svelte`, `+page.server.ts`, `+layout.server.ts`, `+server.ts`. This
  covers `$props()` (`data`/`form`/`children`/`params`) in the `.svelte` files
  _and_ `load`/`actions`/`GET`/`POST` in `.server.ts`/`+server.ts` files. All of
  it is inferred by SvelteKit's tooling from the route's generated `./$types`,
  based on file location, that's the framework working as designed, don't fight
  it. Concretely:
  - `.svelte`: `const { data } = $props();`, never `: { data: PageData }`, never
    `: PageProps`. No
    `PageData`/`LayoutData`/`ActionData`/`PageProps`/`LayoutProps` type name
    appears in a route component at all.
  - `.server.ts` / `+server.ts`:
    `export const load = async ({ locals, parent }) => {...}`, never
    `: PageServerLoad`/`: LayoutServerLoad`. `export const actions = {...}`,
    never `: Actions`. `export const GET = async ({ params, locals }) => {...}`,
    never `: RequestHandler`. No `import type {...} from "./$types"` for any of
    these at all.
  - This rule is specific to route files. Non-route components
    (`src/lib/components/**`) and shared server modules (`src/lib/services/**`,
    `src/lib/server/db/**`, `src/lib/server/validation/**`, `src/lib/dto/**`)
    are normal TypeScript/Svelte code and should still be typed explicitly as
    usual, there's no route-based inference for those.
- **Nested `load` functions under `(protected)/` must not re-check
  `!locals.user`.** The parent `+layout.server.ts` already redirects
  unauthenticated users before any child `load` runs, so re-checking is dead
  code. Use `const { user } = await parent();` instead. **This does not apply to
  `actions`**, form action submissions don't go through the parent layout's
  `load` at all, so every action keeps its own explicit
  `if (!locals.user) throw redirect(...)` guard.
- **A page made of tabs gets one real route (and one `+page.svelte` /
  `+page.server.ts`) per tab, not one big file with a client-side `activeTab`
  switch.** `services/[serviceId]/` is the reference shape: a `+layout.svelte`
  owns the tab bar (`TabNav` with `href`-based tabs, see
  `src/lib/components/tab-nav.svelte`) and renders `{@render children()}`
  _inside_ it (`<TabNav ...>{@render children()}</TabNav>`, so the account's
  "tabs beside the page" preference can move them into a second sidebar); a
  `+layout.server.ts` holds the shared guard/load every tab needs (a child
  route's own `load`, if it needs one at all, calls `parent()` rather than
  re-fetching); the first/default tab is the bare `+page.svelte` at that route's
  root, every other tab gets its own subfolder. `settings/` (General = bare
  `+page.svelte`, `docker/`, `networking/`, `email/`) is the second real
  example, split from a single 1400-line file for exactly this reason: a
  client-state tab switch means every tab's fields, `load` data, and actions all
  live in one file/one request, which stops scaling once a page has more than a
  couple of tabs. Keep each tab's own `load`/`actions` scoped to what that tab
  actually needs, don't let a new tab's server logic leak into a file it doesn't
  belong to.
- **No raw Drizzle queries in route files.** Every table has a corresponding DTO
  class in `src/lib/dto/` (see `.agents/notes/data-and-config.md`), routes call
  DTO methods, never `db.select()/.insert()/.update()/.delete()` directly.
- No unused variables or imports. No lint errors, anywhere in the repo,
  `bun run lint` must be clean before considering a change done.
- **No type errors and no type-check warnings left after any change, anywhere in
  the repo, not just the files touched, `bun run check` must exit clean (0
  errors, 0 warnings, it fails on warnings too, see the note above) before
  considering a change done.** This isn't optional or best-effort: run it for
  real after every change and read what it reports, rather than assuming an
  untouched file's error is pre-existing and therefore not your problem, confirm
  that by actually looking, and fix it either way if it's cheap and unambiguous.
- **Every async user action is reported with `toast.promise`, never a bare
  `toast.success`/`toast.error`.** A promise toast is the only shape that
  narrates the whole operation (`loading` → `success`/`error`) instead of only
  its outcome, and it forces the failure path to be written, which is what was
  actually broken before: the sign-in form's inputs stayed disabled after a
  wrong password and the password field was never cleared, because the `catch`
  branch toasted and returned without restoring state. The two shapes:
  - **A client-side async handler** (a `fetch`, a better-auth client call) gets
    split in two: an inner `async <name>Callback()` that does the work, throws
    an `Error` on failure, and resets its own UI state (`loading = false`,
    clearing a password field) in a `catch` before rethrowing; and a thin outer
    `handle<Name>()` that returns
    `toast.promise(<name>Callback(...), { error, loading, success })`, with
    `error` a function mapping the thrown error to a message via
    `toastError(error, "<fallback>")`. `src/routes/auth/sign-in/+page.svelte`
    and `src/lib/components/profile-menu.svelte` are the reference
    implementations. Validate inside the callback and `throw` there too, rather
    than toasting early and returning, so there's one path in and one path out.
  - **A `use:enhance` form** uses `enhanceToast({...})` from `src/lib/toast.ts`,
    which bridges enhance's callback shape onto a real promise. It takes
    `loading`/`success`/`error` (where `success` may be a `(data) => string`
    reading the action's returned data), optional sonner `action`/`description`,
    `reset` (forwarded to `update()`, which is always called with
    `navigate: false`: kit 3's `enhance` otherwise navigates to another route's
    page when a form posts to that route's action, and every form here stays on
    its page), and the lifecycle hooks `onStart`/`onSubmit` (pre-submit,
    receives the `FormData`, for things like stamping a client-generated
    deployment id) /`onSettled`/`onSuccess`/`onFailure` (both receive the
    action's data) /`onComplete` (runs _after_ `update()`, for a trailing
    `refreshAll()`). `saveToast("<Section> settings")` is the shorthand for the
    settings-style "save this section" form. Put pending-state resets in
    `onSettled`, not in a hand-written callback. `enhanceToast` already extracts
    a failure's message from either `data.error` or the first entry of this
    repo's zod-shaped `data.errors` field map, so a route never needs to dig
    that out itself. `tests/unit/app/toast.test.ts` covers that extraction and
    the hook order.

    **`reset` defaults to `false`, deliberately inverting SvelteKit's own
    default, and it must stay that way.** Real bug, two visible symptoms from
    one cause: Svelte strips an input's `value` attribute during hydration (see
    `svelte/src/internal/client/dom/elements/attributes.js`'s
    `remove_input_defaults`, whose own comment says it's there "to avoid a bug
    when someone resets the form value"), so an input's `defaultValue` is `""`
    no matter what the server rendered. `update()`'s default `reset: true` then
    calls `form.reset()`, and (a) every `value={data.settings.x}` field on
    `/settings` blanked out, with Svelte declining to repaint them since its own
    cached value never changed, so the next save persisted the blanks; and (b)
    `bind:value` state is actively overwritten with `defaultValue` by Svelte's
    own form-reset listener (`listen_to_event_and_reset_event` in
    `bindings/input.js`), which emptied the compose-import page's `text` state
    and therefore the mirrored hidden `compose` field, so the Import step
    rejected the exact file its own Parse step had just previewed ("That doesn't
    look like a compose file", which is `parseYaml("")` returning `null`). Every
    form in this app renders from server or `$state` values, so a DOM reset is
    always wrong here. Pass `reset: true` only for a form that genuinely wants
    clearing.
- **The exceptions are narrow and all of them are non-mutating or instant**: a
  synchronous result with nothing to await (`env-paste-button.svelte`'s parse, a
  clipboard copy), and a background _load_ that already renders its own inline
  spinner or skeleton rather than blocking on user intent, which today means
  every remote query (see `.agents/notes/services-and-templates.md`): the repo
  picker, the image-exists check, the dashboard's Host Resources panel, the job
  queue and the notification feed all report failure inline. A long-lived stream
  is a third: the Terminal tab reports failures through its own `errored`
  banner, since a promise that only settles when the connection ends can't drive
  a toast. Anything that mutates state on the server gets a promise toast.
- **A list page lists; creating happens on its own page.** A page that lists
  things (API keys, state backends, credentials…) shows the list with a "New …"
  button in its header that links to a dedicated `<list>/new` route holding the
  form (and its `create` action), never a create form stacked above or below the
  list. Once created, the new page either shows the one-time result (a key's
  secret) with a way back, or redirects to the new item. An item's own page
  splits into subtabs (`SectionNav`) when it has distinct concerns, with
  destructive actions in a **Settings** subtab's danger zone, not at the bottom
  of an overview.
- **Never cap the width of a dashboard page.** A page under `(protected)/` fills
  the viewport : its root wrapper is `<div class="p-5 md:p-6">`, with **no
  `mx-auto` and no `max-w-*`**. This app is used on ultrawide monitors, and a
  centred `max-w-4xl` column leaves most of the screen as empty gutter while the
  content it was "protecting" (tables, lists, key/value grids, side-by-side
  cards) is exactly the content that wants the room. If a genuinely long block
  of running prose needs a reading measure, cap **that one text node** (the
  precedent is `templates/[templateId]`'s description at `max-w-2xl`) — but
  don't reach for it reflexively: no other dashboard page caps its helper text,
  and sprinkling `max-w-prose` over some paragraphs and not others reads as an
  accident rather than a decision. The only other exception is a **centred
  single-purpose card** on an otherwise-empty page: every signed-out page
  (`auth/sign-in`, `auth/sign-up`, `auth/sign-up/confirm`, `auth/accept-invite`,
  `auth/error`) goes through `AuthShell`
  (`src/lib/components/auth-shell.svelte`), whose form column is `max-w-md`;
  `app-auth` and `cli-auth` are their own `max-w-md` cards, and `/onboarding` is
  a `max-w-3xl` wizard column. Neither exception is a licence to wrap a real
  page in a column.
- **No comments. Anywhere. In any code file.** No explanatory line comments, no
  header banners, no prose in YAML/compose/shell files either. A change's
  rationale belongs in the git commit message, a feature's explanation belongs
  in `docs/` or this file, and code that needs a comment to be understood needs
  a better name instead. Existing comments in files you aren't otherwise
  touching stay put, don't do sweeping comment-deletion passes, just never add
  one. **The one exception is a JSDoc block (`/** ... */`) directly above a
  class method or exported function**, which is required, not just allowed: it's
  what a contributor sees on hover. It says what the function does, its
  non-obvious side effects and throws, never restates the TS types. The
  `doc-comments` agent enforces it.
- **Prefer real OOP over a static-only class that just re-exports imported
  functions (or is `static` throughout for no reason beyond habit).** A
  `class Foo { static bar = importedBar; }` barrel (the shape
  `docker.service.ts` and `database.service.ts` used to have, the latter was
  pure dead code duplicating `db/lib.ts` and was deleted outright rather than
  "fixed") isn't real OOP, it's a namespace with extra syntax, and neither is
  `class Foo { static bar() {...} }` once there's no actual reason for `bar` to
  be static. Three reference shapes now exist, pick whichever fits the module:
  - **Plain instance singleton**, the default, and the most common case: a class
    was `static`-only for no real reason (`AdminService`, `ApiService`,
    `DeploymentService`, `GitProviderService`, `SystemStatsService`,
    `UserService`, `S3BackupService`, all under `src/lib/services/`). Drop every
    `static`, instantiate once, export the instance under the _same_ name the
    class used to export
    (`class AdminServiceClass {...}; export const AdminService = new AdminServiceClass();`).
    `SystemStatsService` is the clearest win from this: its CPU% delta sample
    (`#lastCpuSample`) used to be an awkward module-scope `let` purely because
    the class had no instance to hang it off, it's now a real private instance
    field. `BaseDockerService`/`BaseScheduler`-style abstract bases stay
    exported as classes, not instances (they're meant to be extended, e.g.
    `DueScheduler`, not instantiated directly).
  - **Mixin-merge**, when several concerns need to call into each other and
    external code should keep addressing one flat symbol,
    `src/lib/services/docker.service.ts`: each concern (containers, networks,
    terminal, reconcile, custom-ssl, core-services,
    `src/lib/services/docker/*.ts`) is a real class extending
    `BaseDockerService` (`docker/base.ts`), merged into one `DockerService` via
    the TS mixin pattern (each file exports a `SomethingMixin(Base)` function;
    `docker.service.ts` chains them and instantiates once,
    `export const DockerService = new DockerServiceClass()`), and one concern
    calling another's method uses real inheritance (`this.inspectStatus(...)`),
    not a cross-module import.
  - **Composition**, when the pieces are independent and don't call each other,
    `src/lib/services/cron.service.ts`: `CronService` composes three instances
    of one generic `DueScheduler<T>` (`src/lib/services/cron/due-scheduler.ts`),
    extending `BaseScheduler` for its shared tick/HMR-guard boilerplate, and a
    `CronService` method just calls `.start()` on the instance it owns rather
    than being `static start = importedStart`.

    Across all three, a genuinely pure/stateless transform (`docker/labels.ts`,
    `cron/cron-expression.ts`, `api.service.ts`'s
    `parseImageRef`/`parseWwwAuthenticate`, `git-provider.service.ts`'s
    `endpoints`/`authHeader`) is fine left as a plain module-scope function,
    it's the _stateful, side-effecting, or genuinely-multi-concern_ modules this
    convention targets, not every last helper. Every one of these examples keeps
    external call sites unchanged
    (`DockerService.pullImage(...)`/`CronService.startCronScheduler()`/`AdminService.hasAnyUser()`
    all read identically whether the symbol is a class-with-statics or a
    singleton/facade instance), so refactoring a module to this shape doesn't
    have to ripple into routes/DTOs that already call through it. Apply this
    opportunistically when you're already touching a static-barrel module, not
    as a blanket rewrite mandate, same posture as the shared-UI-components note
    above. DTOs (`src/lib/dto/*`) are a deliberate exception, not an oversight:
    their `static get()`/`.list()`/`.create()` finders returning per-row
    instances with instance methods (`svc.update()`) is already a correct,
    intentional Repository/Active-Record split, see
    `.agents/notes/data-and-config.md`, don't "fix" it.

## Reference notes (`.agents/notes/`)

The architecture detail that used to live in this file is split into per-topic
notes, so a session pays for only what the task actually touches. **Read the
relevant note before working in that area** — each one carries the design
decisions and the "real, tested finding" war stories that explain why the code
looks the way it does, and re-deriving them by hand wastes a session and tends
to reintroduce a fixed bug.

| Note                        | Read it when you're touching                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data-and-config.md`        | `schema.ts`, a table/column, a DTO under `src/lib/dto/`, list pagination, `config.ts`, instance settings, `/settings`                                                 |
| `routing.md`                | Any route under `src/routes/`, the sidebar nav, the services/stacks/templates pages, tab layouts                                                                      |
| `ui.md`                     | `layout.css`, theming/tokens, `src/lib/components/`, list-page toolkit, page width, the `$derived` push/splice bug, appearance prefs                                  |
| `docker.md`                 | `DockerService` and its mixins, containers/networks/volumes, swarm mode, network mode, web terminal, build servers, custom SSL, Docker Cleanup, the built-in registry |
| `auth.md`                   | better-auth, sign-in/sign-up, OAuth providers, Homerun as an OIDC provider, `/authentication`, the per-app login wall, user roles/invites, onboarding                 |
| `api-and-cli.md`            | `src/routes/api/v1/`, the OpenAPI document, `cmd/cli/`, long-running requests and Bun's idle timeout, the Terraform provider and `/iac`                               |
| `services-and-templates.md` | The deploy pipeline, compose import, service links, templates and template links, git-based builds, git providers, SSE deploy progress, remote functions              |
| `jobs-and-queue.md`         | The `job` table and worker, cron schedulers, user cron jobs, S3 backups                                                                                               |
| `worker.md`                 | The Go worker (`cmd/worker`, `internal/worker`, `internal/jobs`), the job stage protocol, porting a job type to Go, the Docker control API (`internal/workerapi`)     |
| `testing.md`                | `tests/` (unit, integration, e2e), `bunfig.toml`, Playwright, the CI Postgres wiring                                                                                  |
| `packages-and-release.md`   | `cmd/installer/`, `cmd/worker/`'s agent mode, `orochibraru/releaser`, CI/Docker publishing, `docs/`                                                                   |
| `dns.md`                    | Cloudflare or Pangolin DNS automation                                                                                                                                 |
| `observability.md`          | `Logger`, `app_log`, in-app notifications, system stats, setup diagnostics                                                                                            |
| `planned-features.md`       | Proposing or building something that might be a deliberate gap — check here before designing it                                                                       |

`TODO.md` is the backlog and the only one. `docs/` is operator-facing and is a
separate audience from these notes (see `packages-and-release.md`).
