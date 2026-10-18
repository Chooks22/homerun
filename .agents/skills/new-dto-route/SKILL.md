---
name: new-dto-route
description:
  Step-by-step workflow for adding a new table + DTO + route to this
  SvelteKit/Drizzle app, enforcing this repo's strict conventions, no raw
  Drizzle queries in route files, no manual typing in route files
  ($props()/load/actions all inferred from ./$types), toJSON() before returning
  a DTO from load, nested (protected) loads must not re-check !locals.user. Use
  when adding a new database table, a new DTO class under src/lib/dto/, or a new
  route that reads/writes one.
---

# new-dto-route

Follow this order; each step depends on the previous one being right.

## 1. Schema (`src/lib/server/db/schema.ts`)

Add the table. Then see the `migration-workflow` skill for generating and
applying the migration — do that before writing the DTO so the columns you
reference actually exist.

## 2. DTO class (`src/lib/dto/`)

Every table is wrapped by a DTO class extending `BaseDTO<TRow>` (see
`base-dto.ts` for the shape). This is a deliberate Repository/Active-Record
split: static finders return per-row instances, instance methods mutate that
row.

- Static finders: `get(id)`, `list()`, and whatever listing/filtering shapes the
  route actually needs (look at `service-dto.ts`/`stack-dto.ts` for the pattern
  of a `listWithX` join helper vs a plain `list`).
- **Resources are shared across every account.** A shared resource's finders
  (services, stacks, volumes, templates, cron jobs and the like) never filter by
  `userId`, which only records who created the row. Only personal data
  (sessions, API keys, preferences, git connections, terminal sessions, the bell
  feed, notification channels) is scoped by `userId`. A new table with a
  `userId` foreign key also needs a line in `UserService.cleanupUserResources`,
  which hands shared rows over to another account before a user is deleted.
- Instance methods: `update(fields)`, `delete()`, whatever mutations the entity
  needs. Don't add a static method that takes an id and does the same thing an
  instance method could — if you already have the row (via `get`), operate on
  the instance.
- Add a `toJSON()` (or inherit `BaseDTO`'s if it's sufficient) returning a plain
  object shape — this is what makes the DTO safe to return from a `load`
  function (see step 4).

## 3. Route files: **never manually type anything**

This applies to `+page.svelte`, `+layout.svelte`, `+page.server.ts`,
`+layout.server.ts`, `+server.ts`, covering `$props()`
(`data`/`form`/`children`/`params`) and `load`/`actions`/`GET`/`POST` alike.
Everything is inferred by SvelteKit's tooling from `./$types`, based on file
location.

- `.svelte`: `const { data } = $props();` — never `: { data: PageData }`, never
  `: PageProps`. No `PageData` / `LayoutData` / `ActionData` / `PageProps` /
  `LayoutProps` type name anywhere in the file.
- `.server.ts` / `+server.ts`:
  `export const load = async ({ locals, parent }) => {...}` — never
  `: PageServerLoad`/`: LayoutServerLoad`. `export const actions = {...}` —
  never `: Actions`. `export const GET = async ({ params, locals }) => {...}` —
  never `: RequestHandler`. No `import type {...} from "./$types"` for any of
  these.
- **No raw Drizzle in route files.** Every DB read/write in a route goes through
  the DTO from step 2 — `db.select()/.insert()/.update()/.delete()` never appear
  directly in a route file.

## 4. `load` under `(protected)/`

- If this is a **nested** load (not the top-level
  `(protected)/+layout.server.ts`), **don't re-check `!locals.user`** — the
  parent layout already redirected unauthenticated users before any child `load`
  runs. Use `const { user } = await parent();` instead.
- This does **not** apply to `actions` — form submissions don't go through the
  parent layout's `load`, so every action still needs its own explicit
  `if (!locals.user) redirectToSignIn();` guard
  (`#lib/server/sign-in-redirect.js`), never an inline
  `redirect(302, resolve("auth/sign-in"))`: every typed `resolve()` call costs
  the type checker about 100 ms, and 275 copies of that one made
  `bun run type-check` twice as slow.
- Before returning a DTO instance (or array of them) from `load`, map it through
  `.toJSON()` — devalue (SvelteKit's serializer) can't serialize a class
  instance, and DTOs are server-only.

## 5. Validation

If the route accepts a form submission, add/extend a zod schema under
`src/lib/server/validation/`. If it's also exposed on the REST API
(`src/routes/api/v1/`), the JSON-body shape is a **separate** schema under
`src/lib/server/validation/api.ts` (form-specific preprocessing like
`envKey[]`/`envValue[]` checkbox handling doesn't belong there) — see the
OpenAPI section of CLAUDE.md if this route needs to show up in the generated
spec (`src/lib/openapi/registry.ts` + `schemas.ts`, both hand-maintained, keep
in sync by hand).

## 6. Finish

Run the `check-repo` skill before considering this done — DTO/route additions
are exactly the kind of change svelte-check and biome catch mistakes in.
