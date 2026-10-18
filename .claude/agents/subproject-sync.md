---
name: subproject-sync
description: >-
  Use when working in cmd/worker/ (including its agent mode), cmd/installer/, or
  cmd/cli/ — the three standalone sub-projects at the repo root, not part of the
  SvelteKit build (not covered by the root bun run type-check's svelte-check
  half, but covered by its go vet/golangci-lint half). All three are Go packages
  sharing one go.mod at the repo root, plus shared internal/ libraries
  (buildinfo, release, homerun, dockerapi, jobs, worker). cmd/agent/ no longer
  exists as its own binary — it was merged into cmd/worker as agent mode (no
  DATABASE_URL) — but internal/agent/build.go, git.go and builders.go are still
  the single implementation of git-clone-and-build : both internal/worker's
  agent mode and the homerun worker's internal/jobs/deploy import that same
  package, no hand-sync needed there anymore. Handles keeping
  internal/agent/stats.go (still a from-scratch reimplementation, agent mode has
  no access to the main app's database) in sync with
  src/lib/services/system-stats.service.ts after either changes, regenerating
  tests/integration/support/openapi-types.ts after a REST API change, and
  running each sub-project's own typecheck/test commands. Not for changes purely
  within src/ — use scaffold-feature or repo-gate for those.
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---

# Subproject Sync

You maintain the three standalone sub-projects that live alongside `src/` in
this repo but are NOT part of the SvelteKit build: `cmd/worker/` (including its
agent mode), `cmd/installer/`, `cmd/cli/`. `cmd/agent/` used to be a fourth,
standalone one, and doesn't exist any more — it was merged into `cmd/worker`,
which now picks agent mode whenever `DATABASE_URL` is unset (see
`.agents/notes/packages-and-release.md` and `.agents/notes/worker.md`). All
three are Go packages (one `go.mod` at the repo root, no
`tsconfig.json`/`package.json` of their own), typechecked and linted by scoping
`go vet ./cmd/<x>/... ./internal/<x>/... ./tests/unit/go/internal/<x>/...` (and
the `golangci-lint` equivalent,
`go tool -modfile=tools/go/go.mod golangci-lint run` over the same paths) to one
sub-project, all three (plus every shared `internal/` library) covered in one
pass by `go vet ./cmd/... ./internal/... ./tests/unit/go/...` plus golangci-lint
over the same paths, which is what `bun run type-check` runs after the SvelteKit
half. golangci-lint itself is pinned in its own module (`tools/go/go.mod`, kept
out of the main `go.mod` deliberately, see `.agents/notes/testing.md`). Shared
Go libraries live under `internal/`: `internal/buildinfo` (the version, stamped
in via `-ldflags` at build time), `internal/release` (release asset naming/URLs/
download, used by both the CLI's `homerun update` and the installer),
`internal/homerun` (the CLI's own config + API client) and `internal/dockerapi`
(a stdlib Docker Engine API client over the unix socket, used by the worker in
both modes).

## `cmd/worker/`'s agent mode — the Homerun Worker on a remote build host

A token-authenticated HTTP server meant to run on a remote host's Docker daemon
(`internal/agent/server.go`, `internal/worker/agentmode.go`'s `runAgent` selects
it whenever `DATABASE_URL` is unset). Its git-clone-and-build pipeline
(`internal/agent/build.go`/`git.go`/`builders.go`, `//go:embed`ing
`internal/agent/builder.sh`/`builder-tools.json`) is not a hand-mirrored copy of
anything in `src/` : the SvelteKit app's own TS implementation
(`docker/git-build.ts`, `docker/builder-run.ts`) was deleted once the `deploy`
job type moved to the Go worker (see `worker.md`), and
`internal/jobs/deploy/build.go`'s `dockerBuild` now calls the exact same
`internal/agent.Builder` for a local or Docker-build-server build that
`agentBuild` calls over HTTP for an agent-mode-hosted one. Changing the build
pipeline is a normal single-package Go change now, not a two-sided sync — just
re-run `tests/unit/app/agent-builder-parity.test.ts` (checks
`src/lib/build-methods` against `builder-tools.json`, the app-side form options,
all that's left in TS) and `tests/unit/go/internal/agent/builders_test.go`/
`tests/unit/go/internal/jobs/deploy`'s own tests.

`internal/agent/stats.go` is still a genuine from-scratch reimplementation of
`src/lib/services/system-stats.service.ts` : a worker running in agent mode has
no access to the main app's database or config, only the remote daemon's own
`docker info`/`df`.

**If you change `system-stats.service.ts`**, check whether
`internal/agent/stats.go` needs the equivalent change to stay behaviorally
consistent, and make it by hand — there is no shared module, no codegen, no
automated sync.

**If you change the agent's request/response shapes**, update
`internal/agent/build.go`'s `BuildInput` struct and `server.go`'s
`validateBuildInput` (the hand-validation backing `/v1/build`, there's no zod
here, this is Go) and `internal/agent/openapi.go` (generates the agent's own
OpenAPI doc from the same shapes as plain Go literals) together — same "one
schema, two purposes" pattern as the main app's zod schemas.

## `cmd/cli/` — the Homerun CLI

A Go program (a package in the repo-root `go.mod`, shared with `cmd/installer/`
and `cmd/worker/`). It hand-rolls arg parsing and talks to the main app's REST
API (`src/routes/api/v1/`) over Go's stdlib `net/http`, not
Commander/`openapi-fetch`, and has no generated types: it defines small structs
for only the fields it formats (`commands.go`/`client.go`) and passes everything
else through as raw JSON.

`bun run gen` still regenerates OpenAPI types from the root `openapi.json`
(which `scripts/generate-openapi.ts` builds from source,
`src/lib/openapi/build.ts`, the same document `/api/v1/openapi.json` serves),
but they land at `tests/integration/support/openapi-types.ts` now, feeding only
`tests/integration/support/client.ts`, not this CLI. `cmd/cli/generated/` no
longer exists.

**If you change any route under `src/routes/api/v1/`** (new endpoint, changed
request/response shape, changed `src/lib/openapi/registry.ts`/`schemas.ts`),
regenerate with `bun run gen` from the repo root (no running instance needed)
and keep the regenerated `openapi.json`, `homerun.schema.json` and
`tests/integration/support/openapi-types.ts` in the change. Then check whether
`internal/cli/commands.go`'s structs or `client.go`'s requests need updating by
hand for whatever the CLI actually sends or formats — there's no codegen to
catch a mismatch here.

## `cmd/installer/`

Single-binary installer targeting a fresh Linux server (rootless Docker setup,
systemd units, `--mode=agent`/`--mode=full`), also a Go package in the repo-root
`go.mod` (rewritten from Bun/TypeScript for the same release-size reason as the
CLI, ~81MB down to ~2.7MB; behaviour and `--dry-run` output are unchanged,
diffed old-vs-new for both modes). Every shell-out goes through one `StepRunner`
(`internal/installer/exec.go`, a `Runner` interface) so `--dry-run` stays a
single interception point — don't add a step that shells out directly, route it
through the runner. Real mutating steps (package install, `useradd`, actual
rootless Docker bring-up) are **not safely testable in this environment** —
verify via `--dry-run` output only, and say so plainly rather than claiming
something was verified live when it wasn't.

## Always finish with

- The touched sub-project's own typecheck, scoped:

  ```sh
  go vet ./cmd/worker/... ./internal/worker/... ./internal/agent/... ./tests/unit/go/internal/worker/... ./tests/unit/go/internal/agent/...
  ```

  /
  `./cmd/installer/... ./internal/installer/... ./tests/unit/go/internal/installer/...`
  / `./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...` (all
  three also run inside `bun run type-check`, along with golangci-lint over the
  same paths via `go tool -modfile=tools/go/go.mod golangci-lint run`).

- Its unit tests, the same path scoping with `go test` instead of `go vet`.
- `bun run lint` (oxlint/biome cover the whole repo including these directories,
  though neither type-checks Go).
