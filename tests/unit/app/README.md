# App testing

Component tests for `src/lib/components/`, using `@testing-library/svelte`
against `svelte-loader.ts`'s Bun plugin (a real Svelte-compiler + happy-dom
loader, not a mock) : compiles `.svelte` files with `compile()`, Svelte 5's
rune-only-module convention (`*.svelte.js`/`*.svelte.ts`, which
`@testing-library/svelte`'s own internals are shipped as) with
`compileModule()`, and `mock.module`-remaps the bare `"svelte"` import to its
DOM/client build, Bun's test runner otherwise resolves it to the SSR build (no
"browser" export condition set), which throws `lifecycle_function_unavailable`
the moment a component tries to actually mount, see that file's own comments for
how each of those was diagnosed.

Run with `bun --config=bunfig.unit.toml test tests/unit/app` (or as part of
`bun run test`, same as every other `tests/unit/<package>/` suite). type-checked
by `bun run type-check`'s `svelte-check` pass along with the rest of `tests/`,
see the root `tests/README.md`.

See `status-badge.test.ts`/`empty-state.test.ts` for the reference shape:
`render(Component, props)` from `@testing-library/svelte`, assert against the
real DOM `container`/`getByText` happy-dom hands back, `unmount()` between cases
in the same test rather than relying on implicit cleanup.
