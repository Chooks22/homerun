# Contributing to Homerun

This is the "I want to run this from source and change code" guide. If you just
want to _run_ Homerun, you don't need any of this: use the installer one-liner
or `compose.prod.yaml` instead, see
[docs/getting-started.md](docs/getting-started.md). Nothing here (git, Bun, a
dev server) is needed for either of those paths.

## Prerequisites

- [mise](https://mise.jdx.dev), then `mise install` in the repo: it installs the
  Bun, Go and prek versions pinned in `mise.toml`. Without mise, install those
  three yourself at the same versions (Go is only needed for `cmd/` and
  `internal/`, the worker, its agent mode, the CLI and the installer).
  golangci-lint is pinned separately, see below, mise doesn't install it.
- Docker (for Traefik + Postgres, and for the containers the app itself will
  manage once it's running)

## Toolchain (mise)

`mise.toml` pins the tools a checkout needs outside `node_modules`: Bun, Go and
prek. `mise install` installs them, and mise's shell activation
(`eval "$(mise activate zsh)"`, see
[mise's docs](https://mise.jdx.dev/getting-started.html)) puts those versions on
`PATH` inside the repo. `mise ls` shows what's active.

**golangci-lint is pinned separately**, in its own Go module (`tools/go/go.mod`,
kept out of the root `go.mod` deliberately, so its ~210 indirect dependencies
don't feed minimum-version-selection into the binaries this repo ships), and run
via `go tool`, not installed as a standalone binary:
`go tool -modfile=tools/go/go.mod golangci-lint run ./cmd/... ./internal/... ./tests/unit/go/...`
(part of `bun run type-check` and a pre-commit hook, below). Bump it with
`cd tools/go && go get -tool github.com/golangci/golangci-lint/v2/cmd/golangci-lint@vX`.

mise can't install Docker itself, only check it: `mise run docker` (also run
after every `mise install`) fails if no daemon is reachable or `docker compose`
v2 is missing, and creates the `homerun` network if it doesn't exist yet.

CI doesn't use mise, so the same versions are also pinned elsewhere, and a bump
has to touch every copy: Bun in `package.json`'s `packageManager` and the
`Dockerfile`'s `oven/bun` tags, Go in `go.mod` and the `Dockerfile`'s `golang`
tag, prek via `j178/prek-action` in `code_quality.yaml`. Renovate updates
`mise.toml` along with the rest.

**Every better-auth package runs one version: `better-auth`'s own.** Its plugins
declare each other with ranges (`@better-auth/mcp` asks for
`@better-auth/oauth-provider@^1.7.1`), so with only the direct dependencies
pinned a plugin can resolve a newer sibling than the pinned `@better-auth/core`,
and the build dies on an export that core doesn't have yet. `package.json`'s
`overrides` therefore sets every `@better-auth/*` package to `$better-auth`,
including the ones only pulled in transitively. To upgrade, bump `better-auth`
and the `@better-auth/*` entries in `dependencies` to the same version in one
change (Renovate groups them) and run `bun install`. A new `@better-auth/*`
package gets an override too. `@better-auth/utils` is versioned on its own and
stays out of it. `tests/unit/app/better-auth-versions.test.ts` fails on any of
these being out of line, in `package.json` or in `bun.lock`.

## Setup

```sh
git clone https://github.com/orochibraru/homerun.git && cd homerun
mise install
bun install
docker network create homerun # already done by mise install
docker compose up -d          # Traefik + Postgres, see compose.yaml
cp .env.example .env          # set AUTH_SECRET, and ORIGIN=http://localhost:5173 for bun run dev
bun run dev
```

Open `http://localhost:5173`. `docker compose up -d` publishes ports 80, 443 and
5432; Traefik also gets the request-metrics flags Monitoring reads and a bind
mount of `./traefik-dynamic` (ignored by git, where the app writes the instance
and per-service TLS config, via `TRAEFIK_DYNAMIC_CONFIG_DIR` in `.env.example`).
A Traefik container created before those flags existed needs
`docker compose up -d --force-recreate traefik`. The app itself creates the
image mirror (`homerun-mirror`, `127.0.0.1:5055`) on first deploy, so that port
has to be free; compose doesn't run it. Migrations in `drizzle/` apply
themselves at boot; `bun run db:generate` is only for when you change
`src/lib/server/db/schema.ts`. The app runs directly on the host (not in a
container) so it can reach the Docker socket without any socket-forwarding;
[`compose.yaml`](compose.yaml) only runs Traefik and Postgres. The first account
you create becomes admin automatically; signing in for the first time drops you
into the onboarding wizard (base domain / Docker / Traefik / email / DNS).

`bun run dev` also runs the job worker (`cmd/worker`, Go), with its output
prefixed `[worker]`. Deploys, builds, scans, backups, cron jobs and Docker
cleanups only run while it's up. It rebuilds and restarts on every change under
`cmd/` or `internal/`; a change that doesn't compile prints the error and leaves
the previous worker running. `bun run dev --only=app` is vite alone,
`bun run dev --only=worker` the worker alone. Without Go installed, run the
worker in Docker instead: `docker compose --profile worker up -d --build worker`
(rebuild it after a Go change).

`bun run build && bun run start` runs the built app instead of the Vite dev
server, closer to how the production Docker image runs it, still directly on the
host, still against the same `compose.yaml` Postgres/Traefik.

`cmd/cli/` and `cmd/installer/` are both Go programs (one `go.mod` at the repo
root, no `bun install` needed for either of them):
`go run ./cmd/cli services list`, `go run ./cmd/installer --dry-run`, etc.
`cmd/worker` is the third: `go run ./cmd/worker` next to a running Postgres runs
the local job worker (what `bun run dev` already starts for you); with no
`DATABASE_URL` set, the same command instead runs it in **agent mode**, the
standalone build-server binary that used to be `cmd/agent/` before it was merged
into the worker, see [`cmd/worker/README.md`](cmd/worker/README.md).

## Before every change: the hard gates

These are enforced by git hooks, not just CI. The hooks are run by
[prek](https://github.com/j178/prek) from `.pre-commit-config.yaml`; prek comes
from `mise install`, then `bun install` wires them up for you (`prepare` runs
`prek install`, which installs the pre-commit, commit-msg and pre-push hooks). A
commit only runs the fast, per-file hooks (oxlint, Biome format and import
sorting, Prettier and markdownlint, gofmt, Tailwind, typos, Vale, secret
scanning), a few seconds. A push runs the whole-repo gates: the type check, unit
tests (80% coverage gate), golangci-lint and the Go tests. Hooks autofix in
place, so a commit that gets rejected for "files were modified by this hook"
just needs `git add` and a re-commit. After pulling this change, run
`prek install` once so the pre-push hook exists.

Vale checks the prose of `docs/`, the READMEs and this file against the Google,
proselint and write-good styles. Only its errors block a commit; warnings are
advice. A product or tool name it flags as a misspelling goes in
`.vale/styles/config/vocabularies/Homerun/accept.txt`. Run it on everything with
`prek run vale --all-files`.

```sh
bun run type-check   # svelte-check --fail-on-warnings over src/ and tests/, bun check over scripts/, go vet and golangci-lint over every package under cmd/ and internal/, zero errors AND zero warnings
bun run lint    # markdownlint-cli2, lint-tailwind.ts and oxlint --type-aware --deny-warnings, whole repo
```

Run both after _every_ change, not just once at the end. `bun run type-check`'s
scope is already the whole repo regardless of which files you touched, so a red
result elsewhere is still your problem to look at, not something to wave off as
unrelated without actually checking. `bun run type-check` includes `go vet` and
`golangci-lint` (the same pair CI's Go job runs, golangci-lint via
`go tool -modfile=tools/go/go.mod`, see Toolchain above) over `cmd/cli/`,
`cmd/installer/`, `cmd/worker/` and every shared `internal/` library; scope
either one to a single sub-project by narrowing the path yourself (e.g.
`go vet ./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...`). If
you changed a REST API route or `config.ts`, also run `bun run gen` and commit
the regenerated `openapi.json`, `homerun.schema.json` and
`tests/integration/support/openapi-types.ts`: CI fails when they're stale.

`bun run test` is the fast suite (seconds, no Postgres or Docker needed): Go
tests plus the `bun:test` unit suite. `bun run test:integration` needs a real
Postgres and Docker daemon, see `CLAUDE.md`'s "Commands" section for the full
breakdown of `test`/`test:*` scripts and `.agents/notes/testing.md` for what
integration and E2E need (the S3 backup test skips unless the
`HOMERUN_TEST_S3_*` variables from `.env.example` are set).

Two real-infrastructure suites live outside that (Multipass + Docker locally,
never in CI): `bun scripts/e2e-multipass.ts` drives the installer/worker/CLI
built from your working tree, and `bun scripts/e2e-multipass-release.ts` drives
the published release using the commands the docs themselves print. If you
touched an install instruction,
`bun scripts/e2e-multipass-release.ts --only=docs` is the seconds-long, VM-free
half of the latter.

## Adding a built-in template

Built-in templates are plain JSON, one file per template:
`templates/<category>/<slug>.json`. No TypeScript, no migration, the app picks
new files up on its next build and seeds them at boot.

- **The folder is the category**, one of the values in
  `src/lib/template-categories.ts` (a new category goes there, plus an icon and
  a colour in `TEMPLATE_CATEGORY_ICONS`/`TEMPLATE_CATEGORY_COLORS` in
  `src/lib/constants.ts`). **The file name is the slug**: it becomes the
  template's id (`builtin-<slug>`), has to be unique across every folder, and
  can't be renamed once released.
- Start the file with `"$schema": "../schema.json"`; your editor then completes
  and checks every field. The schema is generated from the validation code by
  `bun run gen`, never edit it by hand.
- `image` and `tag` must exist: check with
  `docker manifest inspect <image>:<tag>` rather than trusting a README. A tag
  pinned to a version (`18-alpine`, `8`, `1.2.3`) is bumped weekly by
  `scripts/bump-template-versions.ts`, keeping its shape; a floating one
  (`latest`, `stable`) is left alone.
- Every template must deploy and turn healthy with its defaults: the Templates
  E2E job deploys the ones your pull request adds or changes on a real Docker
  daemon, and every one of them on `main`. Run it locally on yours with
  `bun run build && TEMPLATES_E2E_ONLY=<slug> bunx playwright test --config playwright.templates.config.ts`.
  One that genuinely can't run headless (needs hardware, host networking or an
  external account) goes in that spec's skip list with the reason.
- `containerPort` is the port the app listens on inside the container, the one
  Traefik routes to.
- `envVars` holds what the app needs to boot. Secrets get an obvious placeholder
  (`change-me-to-a-random-string`), and `description` says what to change before
  deploying (a public URL, a key format) in one or two sentences.
- `tags` (1 to 12, lowercase) are what the gallery search matches besides the
  name.
- `icon` is `di:<name>` for a [Dashboard Icons](https://dashboardicons.com) logo
  whenever it has the app. Only when it doesn't, add a file under
  `static/template-icons/` (SVG preferred, PNG at 128px max) taken from the
  project's own repo, and use its file name. `""` is the category's generic
  icon.
- A template needing a database or cache links to another built-in instead of
  bundling it: `"links": [{ "alias": "db", "template": "postgres" }]`. Its env
  vars then reference the linked service as `{{db}}` (its hostname) and
  `{{db.VAR}}` (one of its env vars), e.g.
  `"postgres://{{db.POSTGRES_USER}}:{{db.POSTGRES_PASSWORD}}@{{db}}:5432/{{db.POSTGRES_DB}}"`.
  Only templates without links of their own can be linked. `{{secret}}` in a
  template's env vars or command is a random value generated per service,
  identical everywhere it appears in that template: use it for a password the
  env and the command have to agree on, as the cache templates do.

`bun --config=bunfig.unit.toml test tests/unit/app/builtin-templates.test.ts`
validates every file, resolves every link and checks every icon exists; it runs
as part of `bun run test`.

## Conventions

The full, detailed set of architectural and style conventions this codebase
holds itself to lives in [`CLAUDE.md`](CLAUDE.md): route-file typing rules, the
DTO layer, the OOP-vs-static-class conventions, and a long list of "real,
tested" findings from past work worth not re-discovering the hard way. Read it
before a non-trivial change; it's written for exactly this purpose (it's also
what Claude Code reads when working in this repo).

For the runtime picture (which process talks to which, over what, and why), see
[docs/architecture.md](docs/architecture.md). Its diagram is generated by
`scripts/generate-architecture.ts` during `bun run gen`: change the model in
that script, not the page.

## Commits

Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`chore:`, etc.). `orochibraru/releaser` drives version bumps and changelog
generation from them on every push to `main` (`.github/workflows/publish.yaml`),
so a misformatted subject line isn't just a style nit, it changes what actually
ships.

PRs are squash-merged with the PR title as the commit message, so the **PR
title** is what counts, and CI fails a PR whose title isn't a conventional
commit. Only `feat`, `fix`, `perf`, `refactor`, `docs` and breaking changes
(`feat!:`) cut a release. Changes that only touch `docs/`, markdown files,
`.agents/` or `.claude/` don't trigger a release or image build on their own.

## Releases

There's no local release command; releasing is CI-only, triggered on push to
`main` by `orochibraru/releaser`. See the "Release automation" section of
[`.agents/notes/packages-and-release.md`](.agents/notes/packages-and-release.md)
for what it does (binaries for `cmd/cli`/`cmd/installer`/`cmd/worker`, the
Docker image, the GitHub release).
