# Homerun CLI

A small Go client for Homerun's REST API (`/api/v1`, see the main app's
`$lib/openapi/`). Go, not Bun, for one reason: `bun build --compile` embeds the
whole Bun runtime, so the old TypeScript CLI compiled to ~81MB per platform (a
hello-world compiles to the same size, and neither `strip` nor `--bytecode`
moves it), against ~6MB for this one. It shells out to nothing and depends on
nothing outside Go's standard library.

It isn't generated from the OpenAPI document: the commands that format output
declare a struct for the handful of fields they print, and everything else is
passed through as raw JSON, so a new field in an API response needs no CLI
change at all. `tests/integration/support/openapi-types.ts` is what still keeps
the _integration suite_ typed against the spec.

## Installing it

```bash
curl -fsSL https://raw.githubusercontent.com/orochibraru/homerun/main/cmd/cli/install.sh | bash
```

`install.sh` (Linux or macOS) detects your OS and arch, downloads the matching
`homerun-cli-<arch>` release binary (`amd64`/`arm64` on Linux,
`darwin-amd64`/`darwin-arm64` on macOS, a GitHub release asset on this repo),
and installs it as `/usr/local/bin/homerun`, `sudo`'d automatically if that
directory isn't writable by your user. From there:

```bash
homerun login
```

Prompts for your instance URL, then walks you through a machine-to-machine
login: it prints a short code and a URL, you open that URL in any
already-signed-in browser tab and enter the code to approve, and the CLI picks
up a freshly issued API key once you do. No API key to copy/paste by hand. The
URL and key are saved to `~/.config/homerun/config.json` (mode `0600`) so you
don't need to log in again; `homerun logout` clears it.

```bash
homerun services list
```

`--base-url`/`--api-key` flags or the `HOMERUN_BASE_URL`/`HOMERUN_API_KEY` env
vars override the saved login for a single call, and take precedence over it.
They can go before or after the subcommand
(`homerun --base-url <url> services list` or
`homerun services list --base-url <url>`, both work). Running any command with
none of the three configured (no flags, no env vars, no saved login) prints "Not
logged in" and points you at `homerun login` instead of a raw error.

A read-only API key (created with **Access: Read-only** under Profile → API
Keys, or any key belonging to a read-only account) works with every read command
and gets a `403` from anything that deploys, starts, stops, restarts, deletes or
scans.

`--version=vX.Y.Z` (on `install.sh`) pins a specific release instead of the
latest one.

`homerun --help` (or `-h`, or no arguments at all) prints the full usage for
every command. `--help` after a command prints just that command's usage and its
flags (`homerun services deploy --help`), after a group every command in it
(`homerun services --help`).

To work on the CLI itself instead of just using it: it's `package main` in the
repo root's single Go module (`go.mod`), so there's nothing to install beyond Go
itself.

```bash
go run ./cmd/cli services list             # from source
go test ./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...   # its unit tests, part of `bun run test`
go vet ./cmd/cli/... ./internal/cli/... ./tests/unit/go/internal/cli/...    # part of `bun run check`
gofmt -w ./cmd/cli                         # CI fails on anything gofmt would rewrite
bun scripts/build-packages.ts amd64 darwin-arm64
                                                # any of amd64, arm64, darwin-amd64,
                                                # darwin-arm64, outputs dist/homerun-cli-<arch>
```

Every target cross-compiles exactly (`GOOS`/`GOARCH`), so one runner builds all
four, and the release version is stamped in at build time with
`-ldflags "-X main.version=..."` from the root `package.json`.

## Commands

```bash
homerun login [--base-url <url>]
homerun logout
homerun update [--channel stable|canary|nightly]
homerun --version
homerun services list [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun services get <id>
homerun services create [--set <key=value>]... [--file <body.json>|-] [--json]
homerun services update <id> [--set <key=value>]... [--file <body.json>|-] [--json]
homerun services config <id>
homerun services deploy <id> [--tag <tag>] [--environment canary|stable]
homerun services start <id>
homerun services stop <id>
homerun services restart <id>
homerun services delete <id> [--force] [--volumes]
homerun services webhook <id>
homerun services channels enable <id> [--branch <branch>] [--tags <glob>] [--canary-domain <domain>]
homerun services channels disable <id>
homerun services channels status <id>
homerun services environment <id> [name]
homerun services dependencies <id> [--json]
homerun services dependencies set <id> [<dependsOnId>...]
homerun services errors <id> [--status unresolved|resolved|ignored|all] [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun services errors get <id> <issueId> [--event <eventId>]
homerun services errors resolve <id> <issueId> [--status resolved|ignored|unresolved]
homerun services deployments <id> [--limit <n>] [--json]
homerun services scans <id> [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun services scans get <id> [scanId] [--json]
homerun services sourcemaps upload <id> <dir> --release <release>
homerun services sourcemaps list <id> [--json]
homerun services sourcemaps delete <id> <release>
homerun services scan <id> [--wait] [--fail-on critical|high|medium|low] [--timeout <seconds>] [--json]
homerun services logs <id> [--tail <lines>] [--follow]
homerun services revisions <id> [--json]
homerun services rollback <id> [revisionId] [--restore-config]
homerun services version <id>
homerun services version tags <id>
homerun services version pin <id> <tag> [--local]
homerun services version unpin <id>
homerun services version watch <id> [--check[=false]] [--trial[=false]]
homerun services version check <id>
homerun services version update <id>
homerun previews list <id> [--json]
homerun previews get <id> <pr>
homerun previews wait <id> <pr> [--commit <sha>] [--timeout 20m] [--json]
homerun previews deploy <id> <pr> --tag <tag> [--commit <sha>] [--branch <b>] [--title <t>] [--timeout 20m]
homerun previews delete <id> <pr>
homerun previews promote <id> <pr> [--commit <sha>] [--wait] [--timeout 30m]
homerun stacks list [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun stacks get|create|update|delete ...
homerun templates list [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun templates get <id> [--json]
homerun backups list [--volume <id|name>] [--outcome running|success|failed] [--json]
homerun backups volumes [--json]
homerun backups run <id|name> [--wait] [--timeout <seconds>]
homerun volumes backup <id|name> [--wait] [--timeout <seconds>]
homerun <resource> list [<store>] [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun <resource> get [<store>] <id> [--json]
homerun <resource> create [<store>] [--set <key=value>]... [--file <body.json>|-] [--json]
homerun <resource> update [<store>] <id> [--set <key=value>]... [--file <body.json>|-] [--json]
homerun <resource> delete [<store>] <id> [--yes]
homerun workstations list|get|create|update ...
homerun workstations start|stop|recreate <id|slug> [--json]
homerun workstations delete <id|slug> [--volume] [--yes]
homerun workstation-presets list|get|create|update|delete ...
homerun iac generate (--stack <id|slug> | --service <id|slug>) [--state-project <id>] [--out <dir> | --zip <file> | --stdout] [--force]
homerun iac projects list|get|create|delete ...
homerun iac state pull <project>
homerun iac unlock <project> --force [--yes]
homerun system stats [--json]
homerun redirects list [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun redirects get <id>
homerun redirects create <source> <destination> [--enabled=false] [--keep-path=false] [--permanent=false]
homerun redirects update <id> [--source <host[/path]>] [--destination <url>] [--enabled=<bool>] [--keep-path=<bool>] [--permanent=<bool>]
homerun redirects enable|disable <id>
homerun redirects delete <id>
homerun registry repositories [--json] [--page <n>] [--per-page <n>] [--search <term>]
homerun registry tags <repository> [--json]
homerun service-accounts list [--json]
homerun service-accounts create <name> [--permissions <area>=<level>,...]
homerun service-accounts update <id> [--name <name>] [--permissions <area>=<level>,...]
homerun service-accounts disable|enable <id>
homerun service-accounts delete <id>
homerun service-accounts keys list <accountId> [--json]
homerun service-accounts keys create <accountId> [--name <label>] [--expires-in-days <n> | --never-expires]
homerun service-accounts keys revoke <accountId> <keyId>
homerun gate session <url> [--playwright <file>]
homerun manifest apply <id|slug> [--file <path>] [--deploy]
homerun manifest validate [--file <path>]
homerun jobs list [--status queued,running,succeeded,failed,cancelled] [--json]
homerun jobs get <id> [--json]
homerun instance status [--json]
homerun instance update [--wait=false] [--timeout <seconds>] [--force]
homerun instance channel stable|canary|nightly
```

`list` without `--json` prints a plain text table; every other command prints
the raw JSON response. Listings are paginated: `--per-page` defaults to 100 (its
maximum), `--page` selects a page, and `--search <term>` filters server-side.
When a listing is only part of the total, a trailing line says so
(`Showing 10 of 60 (page 1 of 6). Use --page/--per-page for the rest.`); nothing
is printed when everything fit on one page.

Every `services` command, and `previews`, takes the service's slug as well as
its id, and so does every `stacks` command: an argument that isn't a UUID is
looked up through the list's search and replaced by the id of the item with
exactly that slug. One that matches no slug is passed through as it is, so the
API answers for it (a `404` for a typo).

`homerun service-accounts keys create` prints the new key's JSON, the only time
its `key` secret is returned (a reminder goes to stderr, so stdout stays
machine-readable). Keys expire after 90 days unless `--expires-in-days` or
`--never-expires` says otherwise. `--permissions` takes comma-separated
`area=read` or `area=write` pairs (`services=write,stacks=read`) and, on
`update`, replaces the account's whole set (`--permissions ""` removes them
all); the API cuts them down to what your own key holds. `disable` refuses the
account's keys without deleting it, `enable` lets them work again.

`homerun manifest apply` applies a Homerun Manifest (`.homerun.json`,
`.homerun.yaml` or `.homerun.yml` in the current directory unless `--file` names
another) to a service and prints the keys applied and left out; `--deploy`
queues a deploy afterwards. `homerun manifest validate` checks one against the
instance's schema and exits non-zero with every problem found. See
[docs/manifest.md](../../docs/manifest.md).

`homerun gate session <url>` signs in through an app's
[login wall](login-wall.md) without a browser, for CI and end-to-end tests. It
requests the app's URL, follows the wall's redirect to your Homerun server
(aborting before sending anything if that redirect points anywhere else),
presents your saved API key there, and exchanges the result at the app for its
session cookie. The key only ever goes to your Homerun server, never to the app.
It prints `homerun_app_session=<value>`, ready for a `Cookie` header, or with
`--playwright <file>` writes a Playwright `storageState` file (mode `0600`)
instead. It fails when the app has no login wall, when the key is invalid or
disabled, or when the key's owner isn't allowed on the app.

### Resource commands

`<resource>` above is any of `service-environments`, `service-dependencies`,
`volumes`, `volume-mounts`, `cron-jobs`, `notification-channels`,
`backup-destinations`, `build-cache-registries`, `dns-connections`,
`git-providers`, `object-stores`, `buckets` and `status-pages`. Each maps one to
one onto the REST collection of the same name (`/api/v1/<resource>`, `buckets`
onto `/object-stores/{storeId}/buckets`, which is why it takes the store as its
first argument and the bucket's name as its id). `service-dependencies` has no
`update`, since the API has none. `stacks get|create|update|delete`,
`services create|update`, `templates get` and
`iac projects list|get|create|delete` are the same commands over their
collections.

- `list` prints a table of the fields that identify a row, `--json` the raw
  list. `--page`/`--per-page`/`--search` exist where the endpoint is paginated
  (`volumes`, `cron-jobs`, `backup-destinations`, `build-cache-registries`,
  `services`, `stacks`, `templates`); the others always return everything.
- `get`, `create` and `update` print the item as a field/value table, sorted by
  field, arrays and objects as compact JSON; `--json` prints the API's answer as
  it is.
- `create` and `update` build the JSON body from `--file <body.json>` (`-` reads
  stdin), then every `--set key=value` on top of it, so `--set` wins over the
  file. The value is decoded as JSON when it parses as JSON (`3`, `true`,
  `null`, `["a","b"]`, `{"k":"v"}`, `"2024"` for a string that looks like a
  number) and taken as a plain string otherwise. A dotted key sets a nested
  field: `--set envVars.MODE=prod` is `{"envVars":{"MODE":"prod"}}`. The API
  replaces an object field whole, so on `update` a dotted key into an object the
  body doesn't already carry starts from that object's current value (one extra
  `GET` first): `homerun services update web --set envVars.MODE=prod` adds or
  changes one variable and keeps the others. `update` with neither `--set` nor
  `--file` fails without calling the API. The field names are the API's, see the
  OpenAPI document or `get --json`.
- `delete` asks `Delete <noun> <id>? [y/N]` on stderr and deletes only on `y` or
  `yes`; `--yes` skips the question, for scripts. No answer (stdin closed)
  counts as no. `stacks delete --force` adds `?force=true`, like
  `services delete --force`. It prints `{"deleted": true, "id": ...}`.

```bash
homerun stacks create --set name=Web --set slug=web
homerun services create --file api.json --set stackId=<stack id>
homerun services update api --set tag=1.4.1 --set replicas=2
homerun buckets create <storeId> --set name=logs --set expirationDays=30
homerun volumes delete <id> --yes
```

`workstations list|get|create|update` and
`workstation-presets list|get|create|update|delete` are resource commands too,
over the caller's own workstations and presets (`workstations` is paginated and
takes a slug). `workstations start|stop <id|slug>` send
`PATCH /workstations/{id}` with `desiredState` `running` or `stopped` and print
the workstation. `workstations recreate <id|slug>` sends
`POST /workstations/{id}/recreate`, which recreates the container from the
current settings like the dashboard's Recreate, and prints the workstation.
`workstations delete` asks first unless `--yes` and keeps the home volume unless
`--volume` (`?volume=true`). The login wall is the `authRequired` and `auth*`
fields, on a workstation or a preset:
`homerun workstations update box --set authRequired=true --set 'authProviders=["password"]'`.

`homerun volumes backup <id|name>` is `homerun backups run` under the volumes
group. `homerun services deployments <id>` calls
`GET /services/{serviceId}/deployments` and prints the latest deploy attempts,
newest first: status, trigger, environment, image, commit, start and finish
times, and a failed one's error (`--limit`, 1 to 50, default 10).
`homerun services errors get <id> <issueId>` prints one error issue with its
latest event and stack trace as JSON (`--event <eventId>` for another retained
event), and `homerun services errors resolve <id> <issueId>` marks it resolved
(`PATCH /services/{serviceId}/errors/{issueId}`; `--status ignored` or
`--status unresolved` instead). `homerun system stats` prints the host's CPU,
memory, disk and GPU usage. `homerun registry repositories` lists the built-in
registry's repositories with their tag count and the services using them
(`GET /registry/repositories`), and `homerun registry tags <repository>` one
repository's tags and digests (`GET /registry/repositories/{repository}/tags`,
slashes in the name kept).

### Infrastructure as code

`homerun iac generate` calls `GET /iac/generate?scope=stack:<ref>` (or
`service:<ref>`, an id or a slug, exactly one of `--stack`/`--service`), with
`&project=<id>` for `--state-project`, which adds an `http` backend pointing at
that Terraform state project. By default it writes the files into
`./<slug>-terraform/` (`--out <dir>` picks another directory) and refuses to
write anything when any of them already exists, unless `--force`.
`terraform.tfvars`, which holds the secret env var values, is written with mode
`0600`, everything else `0644`. It then lists the files and the next steps
(`export HOMERUN_API_KEY=...`, `TF_HTTP_PASSWORD` too with a state project, then
`cd <dir> && terraform init && terraform plan`). `--zip <file>` saves the
dashboard's zip instead (`&format=zip`, mode `0600`, same overwrite rule), and
`--stdout` prints every file after a `# ==> <path> <==` header. All three are
mutually exclusive.

`homerun iac projects list|get|create|delete` manage the Terraform state
projects (`/iac/projects`;
`create --set name=... --set storeId=... --set bucket=...`).
`homerun iac state pull <project>` writes a project's latest state to stdout
exactly as stored (`GET /iac/projects/{id}/state`, the API key in `x-api-key`
like every call), and says on stderr that there's none yet when the API answers
`204`. `homerun iac unlock <project> --force` breaks the project's lock, whoever
holds it (`DELETE /iac/projects/{id}/lock?force=true`): `--force` is required
and it asks first unless `--yes`. All of them are admin-only.

`homerun services delete <id>` calls `DELETE /services/{serviceId}`, the same
danger-zone action as the Settings tab's Delete button; `--force` adds
`?force=true`, which cancels the service's queued or running jobs and deletes
Homerun's record even when the container or swarm service itself couldn't be
removed (without it, either case answers a 409 and deletes nothing); `--volumes`
adds `?deleteVolumes=true`, which also deletes the volumes no other service
mounts. `homerun services webhook <id>` calls
`GET /services/{serviceId}/webhook` and prints the push-to-deploy URL and secret
for that service (a 404 when neither Deploy on push nor pull request previews
are turned on).

`homerun services scans <id>` is an alias for `homerun services scans list <id>`
(`list` is the group's default subcommand): a table of the service's image
scans, newest first, with per-severity counts. `homerun services scans get <id>`
prints the latest scan (`GET /services/{serviceId}/scans/latest`), or the one
named by a second `scanId` argument, as a header plus a findings table; `--json`
prints the raw scan instead. `homerun services scan <id>` calls
`POST /services/{serviceId}/scans` and prints `{jobId, status}`. With `--wait`
it polls `GET /jobs/{jobId}` every 2s until the job finishes, then prints the
latest scan; a `409` (a scan already in flight) is followed rather than treated
as an error when waiting. `--fail-on <level>` implies `--wait` and exits 1 when
the scan's counts at or above that severity are non-zero (`FindingsAtOrAbove()`
in `internal/cli/commands.go`); a failed or cancelled job, or a wait past
`--timeout <seconds>` (default 1800), exits 1 too.

`homerun services version <id>` calls `GET /services/{serviceId}/version`;
`tags` reads `GET /version/pin`, `pin <id> <tag>` sends
`POST /version/pin {"tag", "local"}` (`--local` sets it), `unpin` is
`DELETE /version/pin`, `watch` sends `PATCH /version` with only the switches
whose flag was passed (`--check` for `updateCheckEnabled`, `--trial` for
`updateTrialEnabled`, `=false` to turn one off; neither fails before calling),
and `check` and `update` `POST /version/check` and `/version/update`. Each
prints the JSON answer.

`homerun services logs <id>` calls `GET /services/{serviceId}/logs` and writes
the plain-text body to stdout as it arrives: the last 200 lines by default,
`--tail <lines>` adds `?tail=`, and `-f`/`--follow` adds `?follow=true`, which
keeps streaming until the connection ends or you interrupt it.

`homerun services revisions <id>` calls `GET /services/{serviceId}/revisions`
and prints a table of the service's revisions, one row per revision with
rollbacks folded into the revision they redeployed (id, first deployed, last
deployed, a `current`/`previous` marker, health, image, commit, digest, and the
reason an unhealthy revision was judged so), `--json` for the raw list.
`homerun services rollback <id> [revisionId]` calls
`POST /services/{serviceId}/revisions/{revisionId}/deploy` with `previous` when
no revision id is given, which deploys the default rollback target (the newest
older healthy revision with a different image), and prints the deploy result
once it's finished, same contract as `homerun services deploy`.
`--restore-config` adds `?restoreConfig=true`, which also restores the env vars,
resources and networking that revision ran with.

`homerun previews list|get|delete <id> [pr]` call
`GET|DELETE /services/{serviceId}/previews[/{prNumber}]`.
`homerun previews wait` first reads the service (failing fast when
`previewsEnabled` is off), then polls
`GET /services/{serviceId}/previews/{prNumber}` every 5s, treating a `404` as
not created yet, until `PreviewVerdict` says ready (the current revision is
`--commit` and `healthy`, or has no health and the preview is running) or failed
(the deploy of that commit failed, or its revision is
`unhealthy`/`rolled_back`), and prints only the URL on stdout, progress on
stderr. `homerun previews deploy` (image-based services) sends
`PUT /services/{serviceId}/previews/{prNumber}` with
`{tag, commit, branch, title}`, which creates or updates the preview at that
tag, then polls exactly like `previews wait` (on `--commit` when given) and
prints the URL; a refusal (a git service, previews off, a filtered-out branch)
exits non-zero at once. `homerun previews promote` posts `{commit}` to
`.../promote` (a `202` with the deploy's `jobId`), and with `--wait` polls
`GET /jobs/{jobId}` like `services scan --wait`.

`homerun instance status` calls `GET /instance/update` and prints the running
version, the release channel, its latest release and whether an update can start
now (with the reason when it can't, and one line per job in the way: `STUCK`
first when no worker has sent a heartbeat for it in two minutes, its title,
service, status/stage, start and last heartbeat, and job id), `--json` for the
raw body. `homerun instance update` calls `POST /instance/update`, which starts
the same self-update as the dashboard's **Update now** and answers `202` with
the target version, or `409` with why it can't. `--force` sends
`{"force": true}`, the dashboard's **Update anyway**: it updates over queued
deploys and running jobs, which run again or resume on the new version, but
still refuses when there's no newer release or the instance can't update itself.
It then follows the update, polling every 3s: it prints the update helper's
output from `GET /instance/update/progress` as it arrives, ignores failed
requests while the container is recreated, and stops once `GET /instance/update`
reports the new version as `current`. It exits 1 when the helper fails or after
`--timeout <seconds>` (default 600). `--wait=false` returns as soon as the
update has started. `homerun instance channel stable|canary|nightly` calls
`PATCH /instance/update/channel`, the same setting as Settings → General →
Release channel. All three are admin-only. `homerun update` is unrelated: it
updates the CLI binary itself.

`homerun update` self-updates the installed binary in place: it checks the
newest release on `--channel` (`stable`, the default, reads `releases/latest`;
`canary` and `nightly` read the newest `v<version>-<channel>.<n>` prerelease),
updates only when that version is strictly newer, so a canary CLI running
`homerun update` stays put until stable overtakes it rather than downgrading,
downloads the `homerun-cli-<arch>` asset for your architecture (same one
`install.sh` installs), and replaces the running binary (`sudo`'d automatically
if the install directory isn't writable by your user, same as `install.sh`).
Release assets are gzipped, so it unpacks the download before replacing the
binary. Linux and macOS, same as installation itself. `homerun --version` (or
`-v`) just prints the current version, no network call.

## After a REST API change

```bash
bun run gen
```

From the repo root: rebuilds `openapi.json` from source
(`scripts/generate-openapi.ts`) and regenerates
`tests/integration/support/openapi-types.ts` from it, no running instance
needed. CI's "Codegen is current" step fails on a stale one. The CLI itself
needs a change only when a command's _printed_ fields move, since everything
else is passed through as raw JSON. A new REST collection gets its commands from
one entry in the CLI's resource table (group, API path, id argument, list
columns, verbs), not from new code.
