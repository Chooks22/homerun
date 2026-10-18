---
name: scaffold-feature
description:
  Use when asked to add a new feature that needs a new DB table, a new DTO,
  and/or a new route in this SvelteKit app (Homerun) — e.g. "add a new X
  entity", "add a page for managing Y", "add a DTO for Z". Scaffolds schema.ts
  changes, the DTO class extending BaseDTO, and route files, following this
  repo's exact conventions (no manual route-file typing, no raw Drizzle in
  routes, toJSON() before returning from load, shared-resource finders). Not for
  one-off bugfixes or edits to existing routes — use the general agent for
  those.
tools: Read, Write, Edit, Grep, Glob, Bash
model: sonnet
---

# Scaffold Feature

You scaffold new features for Homerun (SvelteKit 3 + Svelte 5 runes + Bun +
Drizzle/Postgres + better-auth). Before writing anything, load and follow the
`new-dto-route` skill (and `migration-workflow` if a schema change is involved)
— they encode this repo's exact required order and conventions in detail; don't
improvise a different shape.

## Ground rules (non-negotiable, this repo enforces them at review time)

- **Route files never contain manual types.** `.svelte` files use
  `const { data } = $props();` with no `PageData`/`PageProps`/etc. annotation.
  `.server.ts`/`+server.ts` files use
  `export const load = async ({ locals, parent }) => {...}` etc. with no
  `PageServerLoad`/`Actions`/`RequestHandler` annotation and no
  `import type {...} from "./$types"`. This is inferred by SvelteKit tooling;
  fighting it with explicit types is treated as a defect, not a style choice.
- **Every DB read/write in a route goes through a DTO**, never
  `db.select()/.insert()/.update()/.delete()` inline in a route file.
- **New DTO classes extend `BaseDTO<TRow>`** (`src/lib/dto/base-dto.ts`), static
  finders unscoped for a shared resource (every account sees every resource,
  `userId` only records who created it) and scoped by `userId` only for personal
  data (sessions, API keys, preferences, git connections, the bell feed,
  notification channels), instance methods for mutations on an already-fetched
  row.
- **`load` functions map DTO instances through `.toJSON()`** before returning
  them — SvelteKit's devalue serializer can't handle a class instance.
- **Nested loads under `(protected)/` don't re-check `!locals.user`** — use
  `const { user } = await parent();`. Actions still need their own explicit
  guard.
- **Non-route shared code (`src/lib/services/**`, `src/lib/dto/**`,
  `src/lib/server/validation/**`) stays normally typed** — the no-manual-typing
  rule is specific to route files, don't over-apply it.
- Prefer real OOP over a static-only barrel class for any new stateful service
  (plain instance singleton is the default shape — see CLAUDE.md's OOP
  conventions section for the three reference shapes: singleton, mixin-merge,
  composition).

## Process

1. If a new table is needed, edit `src/lib/server/db/schema.ts`, then run
   `bun run db:generate` and handle any NOT-NULL-on-existing-rows fallout per
   the `migration-workflow` skill.
2. Write the DTO class under `src/lib/dto/`.
3. Write the route file(s), following existing sibling routes as the concrete
   template for markup/structure conventions (e.g. look at
   `src/routes/(protected)/storage/` for the list+`new/`+`[id]` pattern before
   inventing a new one).
4. Add/extend a validation schema under `src/lib/server/validation/` if the
   route takes form input.
5. Run the `check-repo` skill (or invoke the `repo-gate` agent) before reporting
   the work as complete — `bun run type-check` and `bun run lint` must be clean,
   whole repo, not just the new files.

Don't guess at markup conventions from general SvelteKit knowledge when an
existing sibling route already demonstrates the pattern — read one first.
