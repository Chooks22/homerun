# REST API, OpenAPI, CLI

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## REST API (`src/routes/api/v1/`)

Lives outside `(protected)/`, that group's guard is a page-`load` redirect,
wrong for a JSON API that should 401 instead. Every handler starts with its own
`if (!locals.user) return Response.json({error:"Unauthorized"}, {status:401})`;
`locals.user` is populated for both cookie sessions and `x-api-key`/`Bearer`
requests by `hooks.server.ts` (see Auth below), so the same handlers serve the
dashboard's own `fetch` calls and external API-key clients alike.

Handlers don't check write permission themselves: `hooks.server.ts` refuses any
non-GET request from a read-only caller (the `viewer` role or a read-scoped API
key) with a JSON `403` before the route runs, see `auth.md`'s Read-only role
section. `src/lib/openapi/build.ts` adds that `403` to every non-GET operation
automatically, so a new write route documents it without a registry entry.

- `services/`, `GET` list, `POST` create (zod-validated body, not the
  FormData-shaped schema `src/lib/server/validation/service.ts`, that one's
  checkbox/`envKey[]`/`envValue[]` preprocessing is form-specific).
- `services/[serviceId]/`, `GET`, `PATCH` (partial update; `registryPassword` in
  the body re-encrypts, omitted means unchanged; changing the git source fields
  re-syncs the push webhook, see below), `DELETE` (`?force=true`,
  `ServiceLifecycleService.deleteService`, same contract as the Settings
  danger-zone action: a workload removal failure 409s with `{error}` and deletes
  nothing unless `force`).
- `services/[serviceId]/webhook/`, `GET`, the push-to-deploy webhook's URL,
  secret and registration status (`GitWebhookService.describe`); 404 when
  `autoDeployOnPush` is off. See Push-to-deploy in `services-and-templates.md`.
- `services/[serviceId]/{deploy,start,stop,restart}/`, `POST`. `deploy` awaits
  the full pull→create→start pipeline via `deployService()` (see below) and
  returns once it's done, no separate polling endpoint for API clients (the
  dashboard's own progress-polling UI is unrelated, cookie-session only).
- `services/[serviceId]/scans/`, `GET` (paged `ImageScanDTO.toSummary()`s,
  newest first, no `findings`), `POST` (queues `ImageScanService.enqueueScan`,
  202 `{jobId, status}`; 400 when neither `containerId` nor `swarmServiceId` is
  set, same guard as the Security tab's `scan` action; 409 `{error, jobId}` when
  `JobDTO.findActive("image_scan", "image_scan:<id>")` finds one, where the tab
  itself just coalesces through the queue's dedupe key, since an API client
  wants to know it didn't start a new one). `scans/latest/` and
  `scans/[scanId]/`, `GET`, the full row with `findings`; `latest` 404s with
  "This service hasn't been scanned yet." Every scan query goes through
  `ServiceDTO.get(serviceId)` first, so an unknown service 404s.
- `jobs/[jobId]/`, `GET`, a trimmed job row (no `payload`) for polling a queued
  job, any account's job (resources are shared), 404 for an unknown id. Exists
  for `homerun services scan --wait`, generic on purpose.
- `services/[serviceId]/previews/` (`GET`), `previews/[prNumber]/` (`GET`,
  `PUT`, `DELETE`) and `previews/[prNumber]/promote/` (`POST`, 202
  `{deploymentId, jobId, ...}`), backed by `PreviewApiService`
  (`src/lib/services/preview-api.service.ts`, kept out of `preview.service.ts`),
  their OpenAPI entries and response schemas in `src/lib/openapi/previews.ts`
  (spread into `registry.ts`'s `routes`, which is near the `max-lines` limit).
  Promote is `enqueueDeploy({trigger: "promote", rollbackOfDeploymentId})` with
  the _preview's_ current revision as the pointer: `revisionSourceFor` loads it
  unscoped, so the parent reuses the preview's exact image, and
  `enqueueDeploy`'s `note` opens the deployment log with the provenance (no
  schema column). The `promote` trigger is what keeps it from being a rollback:
  `isRollback` in `src/lib/deploy-trigger.ts` (history label and filter, the
  REST `trigger` field, `#rollbackTarget`'s "itself a rollback" skip) excludes
  it, so auto-rollback watches it, it dedupes on `promote:<id>`, and its
  notification is `deploy.*`, not `build.*`. It has to happen before the merge,
  since the close webhook deletes the preview and cascades its deployment rows;
  `docs/github-actions-preview-testing.md` promotes then merges for that reason.
  `homerun previews wait` is the CI gate (`PreviewVerdict` in
  `internal/cli/previews.go`). `PUT` is how an image-based service gets previews
  (`PreviewApiService.deploy`: 400 unless image-based and not a preview, 409
  when previews are off or `PreviewService.deployImage` ignores it), answering
  202 with the `GET` view plus `deploymentId`; `homerun previews deploy` sends
  it then runs the same wait loop (`waitForPreview`). Promote takes an
  image-based parent too: the worker's `serviceImage` outcome leaves it on the
  preview's image and tag.
- `stacks/`, `templates/`, read/create, same pattern, thinner (no lifecycle
  actions).
- `services/`, `stacks/`, and `templates/`'s `GET`s are paginated
  (`parseApiListQuery`/`jsonPage`, see Server-side list pagination above):
  `page`, `perPage` (default 100, max 100), `q`. The response body is
  deliberately still a plain JSON array, not an envelope, so an existing client
  doesn't break; the total row count, current page, and page size come back in
  `x-total-count`/`x-page`/`x-per-page` response headers instead. `templates/`
  runs the builtin and mine paged queries in parallel and concatenates their
  items, with `total` summed across both.
- `system-stats/`, `GET`, host CPU/RAM/disk/GPU stats
  (`SystemStatsService.getSystemStats()`). Moved here from a bare
  `(protected)/system-stats/+server.ts`, that route lived directly in the pages
  directory even though it's pure JSON with no page, which is what
  `(protected)/` is otherwise exclusively for; the dashboard's own 5s poll
  (`(protected)/+page.svelte`) now fetches `/api/v1/system-stats` instead.
- `openapi.json/`, `GET`, public/unauthenticated (the spec describes shapes, not
  data; every documented route still enforces its own auth independently).
  Serves the OpenAPI 3.1 document built by `src/lib/openapi/build.ts`, see
  below.
- `auth-token/`, `DELETE`, revokes the API key that authenticated the request
  itself (`CliAuthService.revokeApiKey`, deletes the `apikey` row directly since
  better-auth's own `POST /api-key/delete` needs a session an API-key-only
  caller doesn't have), `homerun logout`'s server-side counterpart to clearing
  `~/.config/homerun/config.json`. Deliberately **not** under `/api/v1/auth/`:
  `hooks.server.ts`'s `customAuthPaths` routes everything there to better-auth's
  own catch-all first, which 404s an undeclared path, the same real bug the
  CLI's device-code endpoints hit (see below). `400` when the request wasn't
  API-key-authenticated at all.
- `webhooks/git/[serviceId]/`, `POST`, public/unauthenticated: where a git
  provider delivers push events for push-to-deploy
  (`GitWebhookService.handleDelivery`), signature-verified per service rather
  than session/API-key gated, exempted from `csrfHandler` since some providers
  post form bodies. See Push-to-deploy in `services-and-templates.md`.

- `iac/projects/[projectId]/state` (`GET`/`POST`) and `.../lock` (`POST`/
  `DELETE`): Terraform's `http` backend over `IacStateService`, admin-only.
  Terraform can only send HTTP Basic, so `readApiKey` in `hooks.server.ts` takes
  the Basic password as the API key, on `IAC_API_PREFIX` only. The status codes
  are the ones Terraform's client reads: `204` for no state yet, `423` with the
  holder's lock info for a held lock, `409` for a write under someone else's
  lock. The lock id is Terraform's `ID`, on the lock body and as `?ID=` on a
  state write.

`GET /api/health` sits outside `v1/` entirely, a one-line unauthenticated
`new Response("OK")` used as a readiness probe (the compose healthcheck, and
`tests/e2e/`'s bootstrap waiting for the spawned app), not part of the versioned
API surface or the OpenAPI document.

This is deliberately a thin JSON wrapper over the DTO layer, not a new
abstraction, the `cmd/cli/` sub-project talks to this (see below).

`homerun services scan <id> --wait` polls `GET /jobs/{jobId}` (2s) then reads
`scans/latest`; `--fail-on <critical|high|medium|low>` implies `--wait` and
exits 1 via `Output.fail` when `findingsAtOrAbove(counts, level)` is non-zero,
meant as a CI gate. A 409 is followed (its `jobId`) when waiting, fatal
otherwise. `latest` after the job can in principle be a concurrent deploy's scan
rather than the queued one, accepted, the job result doesn't carry a scan id.

## Long-running requests and Bun's idle timeout (`vite.config.ts`)

`@sveltejs/adapter-bun` is configured with `serverOptions: { idleTimeout: 0 }`,
which turns Bun's per-request idle timeout off server-wide, so no handler needs
to opt out of it and there is no per-request helper (`allowLongRequest()` and
`src/lib/server/long-request.ts` are gone, along with every call site).
`App.Platform` comes from adapter-bun's ambient types (`platform.server` only).
adapter-bun also clears the timeout for `text/event-stream` responses on its
own, and `@orochibraru/svelte-smol`'s `IDLE_TIMEOUT` env var no longer exists.

**Why it's `0`, a real reproduced finding.** Bun's default (10s) applies to a
request that's still being _handled_, not just to an idle socket: a handler that
produces no bytes for longer than the window gets its connection severed and the
caller sees a bare `ECONNRESET`. It bit `POST /api/v1/services/<id>/stop`
(`docker stop`'s own grace period is also 10s) in CI only, since macOS doesn't
enforce it the same way.

## OpenAPI (`src/lib/openapi/`, `src/lib/server/validation/api.ts`)

`GET /api/v1/openapi.json` serves a real OpenAPI 3.1 document, generated (not
hand-written) from `src/lib/openapi/build.ts` + `registry.ts`. Request bodies
are the _actual_ zod schemas that validate each request at runtime
(`src/lib/server/validation/api.ts`,
`createServiceApiBody`/`updateServiceApiBody`/`createStackApiBody`, imported by
both the route files and `registry.ts`), converted to JSON Schema via zod v4's
native `z.toJSONSchema()`, one schema instance drives both validation and docs,
so they can't silently drift apart the way a hand-maintained spec would.
`src/lib/server/validation/api.ts` is deliberately separate from
`src/lib/server/validation/service.ts`, that one's
checkbox/`envKey[]`/`envValue[]` preprocessing is FormData-specific, these are
the JSON-body shapes the REST API actually receives.

Response schemas (`src/lib/openapi/schemas.ts`) are _hand-mirrored_ from
`src/lib/server/db/schema.ts`'s columns, not generated, every route's response
is a DTO's `.toJSON()` (the raw DB row), not something validated by a zod schema
at runtime, so there's no single source of truth to generate from the way there
is for requests (a `drizzle-zod`-generated version was tried first and
abandoned, see below). Keep `schemas.ts` in sync by hand if a table's columns
change. The response schemas are honest about what's actually returned,
including `registryPasswordEnc`/`customSslCertEnc`/`customSslKeyEnc`
(ciphertext, not plaintext, since `.toJSON()` returns the whole row), documented
with a note rather than omitted, since omitting them would make the spec
describe a smaller response than the API actually sends.

`registry.ts` is a hand-maintained array of route definitions
(method/path/tags/summary/params/request/responses), there's no metadata
anywhere else in a SvelteKit route file to generate this from automatically.
Keep it in sync when a route's shape changes. `RouteDef.queryParams` (a
`ParamDef[]`, same shape as `pathParams`) is what the three paginated list
routes above use to document `page`/`perPage`/`q` (`registry.ts`'s shared
`listQueryParams` array); `build.ts` emits both `pathParams` and `queryParams`
as `in: "path"`/`in: "query"` OpenAPI parameters on the same operation.

**`drizzle-zod` was tried and abandoned** for the response side: it depends on
`zod/v4`'s subpath export, which resolves fine standalone, but broke under this
repo's Bun install layout with `Cannot find package 'drizzle-orm'` from inside
`drizzle-zod`'s own resolved location, looks like a peer-dependency resolution
quirk specific to Bun's global-cache-backed install strategy, not investigated
further. Hand-mirroring the response schemas avoided it entirely rather than
fighting the resolution issue.

**Verified live**: the served document is a real, valid OpenAPI 3.1 spec, parsed
successfully by `openapi-typescript` (not just eyeballed), used to generate the
actual types `cmd/cli/` is built against (see below), and driven end-to-end
through a real account/API key against a real Docker daemon (see
`cmd/cli/README.md`'s verification notes).

## Homerun CLI (`cmd/cli/`)

A standalone **Go** program, a package in a single Go module at the repo root
(`go.mod`), shared with `cmd/installer/` and `cmd/worker/` (all three Go; the
CLI and installer were rewritten from Bun/TypeScript, and the standalone
`cmd/agent/` was later merged into `cmd/worker` as its agent mode, see
`packages-and-release.md`):
`go vet ./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...` is
the CLI's slice of `bun run check`,
`go test ./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...` the
equivalent (`tests/unit/go/internal/cli/cli_test.go`), and
`scripts/build-packages.ts` builds it with `go build` rather than
`Bun.build({compile: ...})`. **Rewritten from TypeScript** to cut release size:
a `bun build --compile` binary embeds the whole Bun runtime (~81MB on linux/x64,
same size as a hello-world; `strip`/`--bytecode` changed nothing), the Go binary
is ~6MB. It hand-rolls arg parsing and uses Go's stdlib `net/http` rather than
Commander/`openapi-fetch`, and has no generated types at all: it defines small
structs for only the fields it formats (`commands.go`/`client.go`) and passes
everything else through as raw JSON. `cmd/cli/generated/` is gone; `bun run gen`
still regenerates OpenAPI types (`tests/integration/support/openapi-types.ts`),
but they now feed only `tests/integration/support/client.ts`, not this CLI. Auth
is `x-api-key`/`--api-key`, same header the REST API's own hooks check first for
a non-cookie caller.

Every command is one entry in `Commands` (`internal/cli/registry.go`): its full
name, aliases, positional `Args` synopsis (`<required>`, then `[optional]`, then
one last `[variadic...]`), a one-line summary, and a `Setup` that registers its
flags and returns the runner reading them. Dispatch, the missing/extra argument
checks, `<command> --help`, `<group> --help` and the top-level usage are all
generated from that table, so there's no usage text to keep in sync by hand.
`help_test.go` walks every entry (summary set, synopsis well-formed, every flag
described, `--help` prints them, a missing required argument fails before any
API call). A new command is one entry, nothing else. `services scans <id>` is
`services scans list`'s alias. See `cmd/cli/README.md` for the full command
reference and what's verified.

Plain REST collections don't get hand-written commands: `resources.go` has a
`Resource` table (group, API path with an optional parent `%s` like
`/object-stores/%s/buckets`, id argument name, list columns, paginated or not,
slugs or not, which of list/get/create/update/delete exist), and
`ResourceCommands` turns each entry into ordinary `Commands` entries, so help,
dispatch, arg checks and `help_test.go` cover them like everything else. A new
collection is one table entry. `create`/`update` build the body from `--file`
(`-` is stdin, numbers decoded with `UseNumber` so big ints survive) plus
repeatable `--set key=value` on top (JSON when `json.Valid`, else a string;
dotted keys nest). **Real, live-tested finding:** the API's `PATCH` replaces an
object field whole, so the first cut of
`services update api --set envVars.MODE=prod` silently dropped every other env
var of the service. `update` now GETs the item first whenever a `--set` key is
dotted and seeds that top-level object from it (unless `--file` already carries
it), which is why a dotted update costs one extra request. `delete` confirms on
stderr unless `--yes`. Every `services`/`previews` command and every `stacks`
command resolve a non-UUID argument as a slug through the list's `q` search
(exact slug match, anything else passed through so the API's own 404 still
answers a typo), which is why the dispatch tests use UUID-shaped ids: a non-UUID
costs a list request first.

`iac generate` writes the project to `./<slug>-terraform/` (all-or-nothing: it
refuses before writing anything if any target exists, unless `--force`),
`terraform.tfvars` and the `--zip` file at `0600` with an explicit `chmod` so an
overwritten file doesn't keep its old mode, and rejects a non-local path or slug
from the server. `iac state pull` treats an empty `204` body as "no state yet"
on stderr, stdout stays empty. `system stats` follows the route's real answer
(`diskTotalGb`/`diskUsedGb`, no percent fields), not the OpenAPI schema, which
describes the worker's raw host stats instead.

**Verified live** (the parity session, a throwaway Postgres container and
`bun run dev` on their own ports, a fresh account and API key):
`stacks create/get/update/delete` by slug, `services create --file --set`,
`services update` by slug with flat and dotted `--set` (the env var finding
above), `volumes create/update/list/delete --yes`, `volume-mounts create/list`
and `delete` declined then confirmed, `iac generate --service` (files at
`0644`/`0600`, then the overwrite refusal), `--zip` and `--stdout`,
`iac state pull` on a missing project (404), `templates get`, `system stats`,
`services deployments`/`errors` and every new `list`. Not run live:
`iac projects create`/`state pull` with real state and `iac unlock` (no object
store on that instance), `services errors get/resolve` against a real issue, and
`buckets` (unit-tested against a fake server).

Every `list` command also takes `--page <n>`, `--per-page <n>` (default 100, max
100, same clamp as the API) and `--search <term>`, threaded through as the same
`page`/`perPage`/`q` query params the REST API's `GET` list routes accept (see
REST API and Server-side list pagination above). `commands.go`'s `ListArgs`
struct (`JSON`/`Page`/`PerPage`/`Search`) replaced the old bare `json: boolean`
parameter every `*List` command took; `printPageFooter(header, shown)`
(`output.go`) reads the `x-total-count`/`x-page`/`x-per-page` response headers
and prints `Showing 10 of 60 (page 1 of 6). Use --page/--per-page for the rest.`
whenever a listing was truncated, silent when the whole set fit, so a partial
result can't be mistaken for a complete one. Default behavior is unchanged
(100/page), so a plain `homerun services list` on a normal instance looks
exactly as before.

**Verified live against the Go binary** (the rewrite session):
`services list`/`get`/`revisions`/`scans list`/`scans get`/`logs --tail` (a real
stream from a running container), `templates list`, `instance status`, `--json`,
`--per-page`, and the 404/400/missing-argument/bad-flag error paths, all driven
against the maintainer's real instance; the whole `tests/e2e/ui-cli.spec.ts`
suite (16 specs: login device flow, deploys, scans, logout revocation) against a
real built app; and the static `linux/amd64` binary running on Alpine (musl, no
glibc) with its `-ldflags` version stamp intact. Two real regressions came out
of that e2e run rather than out of review: a missing positional argument
reported "Not logged in" because the client was resolved before the argument was
checked, and Go's `flag` package stops at the first positional, so
`services scans list <id> --json` silently ignored the flag and printed a table
(`parse()` now resumes after each positional, covered by a unit test).

**Verified live, full round trip** (against the previous, TypeScript
implementation, kept here because it covers deploy paths the Go run reached only
through the e2e suite): a throwaway account + real API key (against an isolated
`homerun_test` database, never the maintainer's real one) drove every command
against a real Docker daemon, `services list`/`get`/`deploy` (a real
`nginx:alpine` pull→create→start)/`start`/`stop`/`restart`, plus the
401-on-bad-key path, and the compiled binary behaved identically to running from
source. The pagination flags were verified the same way on a 60-service
database: the compiled CLI printed the truncation footer for `--per-page 10` and
`--per-page 10 --page 3`, and `--search svc-58` returned the single matching
row.

`homerun login`'s device-code flow is now verified live too (previously flagged
as untested, closed in a later session): a real compiled CLI binary, installed
via `cmd/cli/install.sh` inside a Linux Docker container, ran
`homerun login --base-url <real installer-provisioned instance>`, printed a real
user code, was approved via the real `/cli-auth` approval-page form action as
the real signed-in admin, and picked up a real API key, saved to
`~/.config/homerun/config.json` at mode `0600`. This run is also what surfaced
and fixed a real routing bug in `src/hooks.server.ts`:
`POST /api/v1/auth/cli/{device,token}` weren't in `authHandler`'s
`customAuthPaths` allowlist, so both 404'd before ever reaching their real
SvelteKit route files, swallowed by better-auth's own catch-all handler for
anything under its `/api/v1/auth` basePath. Fixed by adding both paths alongside
the pre-existing `/api/v1/auth/providers` entry.

The CLI also has a standing end-to-end suite, `tests/e2e/ui-cli.spec.ts`, which
runs it against the Playwright suite's built app on every E2E run (device login
approved in a real browser, every list/get command, overrides, 401/404 exits,
logout), see `.agents/notes/testing.md`. `homerun logout` now revokes the API
key server-side (`DELETE /auth-token`, best-effort: any error or non-ok response
just means the local logout proceeds anyway) before clearing the local config,
rather than only ever clearing the local file; verified live in that same suite,
which re-uses the revoked key against `GET /services` afterwards and asserts
`401`.

## API Docs page (`(protected)/api-docs/`)

A dashboard page (own nav item, "API Docs", not admin-only) rendering the live
`/api/v1/openapi.json` spec via `swagger-ui-dist` (npm dependency, not a CDN
script, this is a self-hosted app, so the docs UI shouldn't need outbound
internet to render). `swagger-ui-bundle.js` is dynamically imported inside
`onMount()`, not at module scope, it touches `window`/`document` at call time,
which would crash SvelteKit's SSR pass otherwise. "Try it out" requests aren't
authenticated by the dashboard's own cookie session (Swagger UI makes its own
`fetch` calls, doesn't share credentials with the page), the page's own copy
says so; a real request there needs a pasted `x-api-key`. **Verified live**: the
page server-renders 200 (not a crash/error boundary) for a real signed-in user,
with the expected `swagger-ui` CSS/container markup present, client-side widget
initialization itself wasn't verified in a real browser (the Playwright suite
that now exists, see below, doesn't cover this page), just that nothing crashes
and the wiring (dynamic import location, CSS import, container ref) matches
Swagger UI's own documented embed pattern.

## Infrastructure as code (`src/lib/iac/`, `terraform/provider/`, `(protected)/iac/`)

**One mapping, three consumers.** `src/lib/iac/resources.ts` describes every
`homerun_*` resource and data source: its REST paths, each attribute's API field
and Terraform name, kind, and flags (`required`, `readOnly`, `writeOnly` for
secrets, `createOnly` for `template_id`, `forceNew`, `ref`, `default`,
`returnedOnCreate` for a generated secret only the create response carries, like
a registry token's, which every read keeps from the state). A resource flagged
`singleton` (the instance settings in `resources-settings.ts`) is one object at
a fixed `itemPath`: create PATCHes it, delete only forgets it, its id and only
import id is `SINGLETON_ID` (`instance`), the drift check never lists it as
unmanaged and generated projects never include it. Its REST side is a
`GET`/`PATCH` pair through `SettingsApiService`, which fills what a PATCH leaves
out from what's stored and saves through `InstanceSettingsService`, the same
methods the Settings pages' actions call. `scripts/generate-iac-spec.ts` (part
of `bun run gen`, so CI's codegen check catches a stale copy) writes it to
`terraform/provider/internal/provider/spec.json`, which the provider embeds; the
IaC page's generator (`generate.ts`) and drift check (`drift.ts`) import it
directly. Add a field once there and the provider, the generated HCL and the
drift comparison all follow. A Terraform-reserved name (`provider`) gets an
explicit `tf` (`dns_provider`). The same script writes the provider's Terraform
Registry pages to `terraform/provider/docs/` from `provider-docs.ts` (one per
resource and data source, in the registry's own layout), and the release job
copies them to the mirror with the source; a new resource needs an entry in
`RESOURCE_EXAMPLES`, which a unit test enforces.

**Generated projects are per stack or per service, never the whole instance.**
`generateStructure` returns files (`versions.tf`, `providers.tf`, a
`service_<name>.tf` per service holding what hangs off it plus every `import`
block next to its resource, `stacks.tf`, `volumes.tf`, `variables.tf` with a
`terraform.tfvars.example`, `README.md`, `.gitignore`) for a scope parsed by
`parseScope` (`stack:<id>` / `service:<id>`) and cut by `scopeToStack` /
`scopeToService`; `IacInventoryService.structure` is the one entry point the
Generate tab and `iac/[projectId]/download` (the zip, `src/lib/server/zip.ts`,
store-only with its own CRC-32, checked against a real `unzip`) both call.
Terraform, shell and TypeScript snippets render through `highlightCode`
(`src/lib/server/shiki.ts`, server-side only so Shiki never reaches the client,
both themes as `--shiki-light`/`--shiki-dark` variables) and `CodeBlock`, bold
JetBrains Mono.

**The page is a list of projects, like services.** An `iac_project` row is the
unit: its `tool` (`terraform`, `opentofu`, `pulumi`, `src/lib/iac/tools.ts`),
its bucket, and an optional `scope` (`stack:<id>` / `service:<id>`) the Generate
tab starts on. Every tab lives under `iac/[projectId]/` and switches on
`usesHttpBackend(tool)`: Terraform and OpenTofu get the http backend's versions,
lock, generated HCL and drift; Pulumi gets the `pulumi login` command and the
bucket's access keys, and no generation or drift (Pulumi keeps its own
checkpoint in the bucket, which nothing here reads). OpenTofu differs from
Terraform only in the CLI name the pages and the generated README print
(`GenerateOptions.cli`).

**The provider is generic.** `terraform/provider` is its own Go module (module
path `github.com/orochibraru/homerun/terraform/provider`), kept out of the root
`go.mod` like `tools/go`, since terraform-plugin-framework pulls grpc and
friends into the shipped binaries' minimum-version selection otherwise. One
`specResource` and one `specDataSource` serve every type: schema from the spec,
values converted between `tftypes` and JSON (`convert.go`), create sends every
known plan value, update only the changed ones (a cleared one as `null`), state
after apply keeps the planned value where it's known (no "inconsistent result"
from server normalisation) and takes the API's answer for the rest, read
refreshes everything the API returns and keeps write-only/create-only ones.
Optional attributes are Optional+Computed with `UseStateForUnknown`, so leaving
one out never causes a perpetual diff (and never resets it either: documented).
`template_id` replaces the resource only when it changes from a known value, so
adding it to an imported service doesn't destroy it. `deploy_on_change` calls
`POST /services/{id}/deploy` (an environment's id is a service id) and a failed
deploy is a warning, not an error, since an error on create taints the resource
and the next apply would replace the service. Tests live under
`terraform/provider/tests/` (external packages, the module's own tree):
`terraform-plugin-testing`'s `resource.UnitTest` runs real `terraform`
plan/apply/import/refresh against an in-memory fake API, skipped when
`terraform` isn't on PATH. `bun run check`/`bun run test` and `go.yaml` run its
vet, golangci-lint (through `go -C terraform/provider tool`, with
`-modfile=../../tools/go/go.mod` and `--config ../../.golangci.yml`) and tests;
`scripts/build-packages.ts` cross-compiles it as
`dist/homerun-terraform-provider-<target>`, and every stable release publishes
it to registry.terraform.io and registry.opentofu.org as `orochibraru/homerun`
through a mirror repo (see Terraform provider registries in
`packages-and-release.md`), so the Provider tab and a generated project's README
only say to set the key and run `terraform init`.

**The API behind it.** Every service setting goes through
`ServiceSettingsService.apply` (`src/lib/services/service-settings.service.ts`),
shared by `PATCH /services/:id`, `POST /services` (the fields
`ServiceDTO.create` doesn't take, applied right after, the row deleted again on
a refusal) and the dashboard's networking, security, previews and settings
actions (`save()` returns the refusal instead of throwing, for a form action).
It validates only the groups a call touches, so an old row in an odd state
doesn't block an unrelated save. Stacks, volumes, status pages and git providers
have the same kind of shared service (`stack-settings`, `volume-settings`,
`status-page-settings`, `git-provider-config`). Responses never carry
ciphertext: `src/lib/server/api-json.ts` turns rows into their API shape (`*Set`
booleans instead), and `IacInventoryService` builds the page's inventory from
those same functions, which is what keeps the generator and drift in the
provider's shape. New routes use `apiCaller`/`readApiBody`/`apiError` from
`src/lib/server/api-route.ts` and get their OpenAPI entries from `crudRoutes()`
in `src/lib/openapi/resources.ts`.

**Verified live** against a real built app, worker and Postgres: a 16-resource
configuration applied, re-planned clean, a generated `main.tf` from the live API
imported all 18 objects then planned "No changes", an out-of-band PATCH showed
up in `detectDrift` on the real state and `apply` put it back, `destroy` removed
everything, and `deploy_on_change` deployed and redeployed a real container.
That run found four real bugs the unit tests hadn't: `routingPatch` spreading
`slug: undefined` over the row (a 500 on every create with domains), an empty
`svc.update({})` throwing Drizzle's "No values to set", `deploy_on_change`
importing as null (a diff on every imported resource), and generated variables
for a `map(string)` secret typed `string`.
