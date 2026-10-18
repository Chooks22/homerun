# Unit tests

`bun:test`, run directly by Bun (`bun test --timeout 120000` — see the root
`CLAUDE.md`'s note on why `--timeout` is passed explicitly), covering
`tests/unit/app/`, the SvelteKit app itself — a Svelte-compiling Bun plugin +
happy-dom setup, `@testing-library/svelte`, see its own README. Tests live here,
under `tests/unit/<package>/`, mirroring the source tree. `cmd/worker/`,
`cmd/cli/` and `cmd/installer/` are all Go packages in the repo-root `go.mod`
and aren't part of `bun:test` at all, but every `*_test.go` in the repo follows
the same not-next-to-source rule: it lives under
`tests/unit/go/<same path as the package it covers>` (e.g.
`internal/httpapi/token.go` is covered by
`tests/unit/go/internal/httpapi/token_test.go`) as an external test package
(e.g. `package worker_test`/`package agent_test`), run by scoping `go test` to
that path, e.g.:

```sh
go test ./cmd/worker/... ./internal/worker/... ./internal/agent/... ./tests/unit/go/internal/worker/... ./tests/unit/go/internal/agent/...
```

for the worker (including its agent mode), the `cli`/`installer` equivalents
narrowed to those paths, or all of it at once with
`go test ./cmd/... ./internal/... ./tests/unit/go/...` (part of `bun run test`).

Run everything: `bun run test` (a bare `bun test` also works for the `bun:test`
half — no wrapper script, `bunfig.toml`'s `[test].preload` handles the rest —
but `bun run test` also runs
`go test ./cmd/... ./internal/... ./tests/unit/go/...` first, covering
`cmd/worker/`, `cmd/cli/` and `cmd/installer/`, then
`bun --config=bunfig.unit.toml test tests/unit` for the app; unit only, no
Postgres/Docker needed). See `tests/integration/README.md` for the separate
`tests/integration/` suite, and `tests/e2e/README.md` for the real-browser
Playwright suite (its own runner, `bun run test:e2e`, not part of
`bun run test`'s `bun test` invocation).

## Mocks are process-global

`mock.module(specifier, factory)` mutates one module registry for the whole
`bun test` process — two files mocking the same specifier differently would
collide regardless of run order. Every `tests/unit/app/*.test.ts` that calls
`mock.module` has to coexist with the rest of the suite in one process without
colliding, restoring spies with `mock.restore()` where it matters. This used to
also cover the Bun-based agent's own suite (`tests/unit/agent/docker.test.ts`
mocked `"dockerode"` wholesale, `tests/unit/agent/http.test.ts` spied on
individual `DockerService` methods); that suite is gone along with the Bun
agent, replaced by `internal/agent/`'s own Go tests (imported by `cmd/worker`'s
agent mode, no standalone `cmd/agent/` any more), which fake the Docker client
via a real interface instead
(`tests/unit/go/internal/agent/fake_docker_test.go`).

## `cmd/cli/`'s tests set `$HOME` directly, no preload needed

`internal/homerun/config.go`'s `ConfigDir`/`ConfigPath` resolve the config file
path (`~/.config/homerun/config.json`) from `os.UserHomeDir()`, which reads
`$HOME` fresh on every call (unlike the old TypeScript CLI's `os.homedir()`,
fixed for the life of the process, which is why that version needed a
`bunfig.toml` preload mocking it). `tests/unit/go/internal/cli/cli_test.go` just
calls `t.Setenv("HOME", t.TempDir())` per test, which Go's own test runner
resets automatically, so there's no shared scratch-directory setup and no
`tests/unit/support/` involvement at all for `go test`.

## Coverage

`bunfig.toml`'s `[test].coverage = true` turns coverage on for every run, scoped
away from `tests/**` (`cmd/cli/generated/**` was in this exclusion list too,
back when that directory existed for the TypeScript CLI). No threshold enforced
yet.

## Fakes over mocking libraries

`internal/installer/exec.go`'s `Runner` is a real Go interface, so its own Go
tests (`tests/unit/go/internal/installer/steps_test.go`, `fullstack_test.go`,
`migrate_test.go`, `flow_test.go`, `main_test.go`, `support_test.go`, all in
that same directory) pass a fake implementation instead of the real
`StepRunner`, no mocking library involved — the same "fake over mock" posture
the old `bun:test` suite used to take with plain object literals for this same
collaborator, before the installer's Go rewrite moved these tests out of
`tests/unit/installer/` entirely.

## Real bugs this suite caught

- `Bun.write(path, data, { mode: 0o600 })`'s `mode` option is silently a no-op
  on Bun 1.4.0 — the file lands with whatever the umask produces (0644 under the
  common 022 umask) regardless of what's passed. The old Bun-based agent's
  persisted token — a full-access API credential — was affected by exactly this,
  fixed at the time by calling `node:fs/promises`'s `chmod()` explicitly after
  `Bun.write` (`node:fs`'s own `mode` option is honored, verified). The agent's
  Go rewrite sidesteps the whole bug class: `internal/httpapi/token.go`'s
  `ResolveToken` calls `os.WriteFile(tokenFile, token, 0o600)` then an explicit
  `os.Chmod`, both of which Go actually honors.
- `bunfig.toml`'s `[test].timeout` key is silently not honored by Bun 1.4.0 for
  `test()` bodies — every `test/test:*` script passes `--timeout 120000` on the
  CLI instead.

## Vitest was tried and reverted

This suite briefly ran on Vitest. It fixed the timeout bug above and gave each
test file its own module registry. But `coverage.provider: "v8"` crashes under
Bun once coverage from more than one test file needs merging
(`@bcoe/v8-coverage`'s recursive merge throws
`RangeError: Maximum call stack size exceeded`, reproduced directly, confirmed
independent of provider — `istanbul` avoided it, `v8` didn't). The suite moved
back to `bun:test` rather than keep the extra dependency around for that.

`tsconfig.json` type-checks `tests/` as part of `svelte-check` (part of
`bun run type-check`), same as `src/`; it used to exclude `tests/` entirely,
since `bun:test`'s `mock()` return type hit real overload-resolution errors
under svelte-check's TS resolution that don't happen under `tsc`/`bun test`
directly, but re-including it surfaced real bugs worth catching (see
`.agents/notes/testing.md`). `cmd/worker/`'s (including its agent mode),
`cmd/cli/`'s and `cmd/installer/`'s own tests aren't under `tests/unit/app` at
all and aren't TypeScript: they're checked with `go vet`, not `tsc`, scoped to
each sub-project's own path.
