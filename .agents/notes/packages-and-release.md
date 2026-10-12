# Agent, installer, release automation

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## The agent's git builds (`internal/agent/build.go`, `internal/agent/git.go`)

`Builder.Build`/`BuildWithProgress` is now the **single** implementation of
"clone a git repo into a container volume, then build it": the SvelteKit app has
none of its own anymore (`docker/git-build.ts` and `docker/builder-run.ts` were
deleted once the `deploy` job type moved to the Go worker, see `worker.md`). The
homerun worker's own local and Docker-build-server builds
(`internal/jobs/deploy/build.go`'s `dockerBuild`) call this exact same
`agent.NewBuilder(docker, socket).BuildWithProgress` against whichever daemon
they're building on; only a registered Homerun Agent build server calls it over
HTTP instead, through its own `POST /v1/build`
(`internal/jobs/deploy/build.go`'s `agentBuild`). **Including its
clone-in-a-container shape**: the agent image has no git binary of its own, so
cloning can't shell out directly. It pulls `alpine/git`, clones into a named
volume, tars the context back out, and removes the volume in a deferred cleanup.

**A private repo works too**: `BuildInput` (`POST /v1/build`'s body, and the
homerun worker's own in-process struct for the other two build kinds) carries an
optional `Credential` (`{username, token}`) that `deploy/helpers.ts`'s
`resolveGitCredential` fills, since the agent has no access to the git-provider
tables. `authenticatedCloneURL` and `redactCloneURL` (`internal/agent/git.go`)
are the only implementation left of what `src/lib/git-clone-url.ts` used to also
carry (`authenticatedCloneUrl`/`redactCloneUrl`, deleted from the app once
nothing there called them anymore), and every log line and error message goes
through the redaction so a token can't reach the deployment log.

## Release automation (`orochibraru/releaser`, `scripts/upload-release-assets.ts`, `scripts/build-packages.ts`)

**The CI pipeline builds each image once and reuses it.** Both
`pull_request.yaml` and `publish.yaml` run the same shape: `code_quality` →
`docker.yaml` (per image) → `e2e.yaml` → `docker-manifest.yaml` (per image) →
gate/release. `pull_request.yaml` additionally runs `screenshots.yaml` and
`templates-e2e.yaml` (the latter only when the PR touches a template, the suite
or the deploy pipeline, since a batch of Renovate PRs each pulling ~80 images
blew through Docker Hub's pull limit) off `code_quality`, in parallel with the
image builds rather than after them, because both are the exception to "build
the image once" : they must run the app and worker as local processes to reach
the Docker socket (see Screenshots and Template deploys in `testing.md`), so
each does its own `bun run build` and never touches the image under test. Both
feed the CI Gate. **Detect Changes decides how much of it runs**: a change to
the suite, its workflows or what a template deploy goes through (the
deploy/docker/ template services, seeding, the templates routes,
`internal/jobs/deploy`, `dockerapi`, `agent`) sets `templates=true` with an
empty `template_slugs`, so every template deploys; a PR that only adds or
changes template files sets `template_slugs` to their comma-separated slugs
(every non-removed `templates/<category>/<slug>.json`), passed as the workflow's
`templates` input and on to `TEMPLATES_E2E_ONLY`, so only those deploy; anything
else skips the job (the gate treats skipped as passing). `publish.yaml` runs
`templates-e2e.yaml` on every non-release push to `main`, promoted or not (a
promoted PR may have skipped it or run a subset), with no `templates`, so every
one deploys there, but nothing waits on it : an hour-plus job in front of every
canary isn't worth it when the PR gate already ran it. The split between
`docker.yaml` and `docker-manifest.yaml` is the point : `docker.yaml` pushes
**by digest only** (`push-by-digest=true`, no tag), so `e2e.yaml` can
`docker pull` that exact digest and run Playwright against the real artefact,
and `docker-manifest.yaml` only then applies the friendly tag (`pr-<n>`, or
`<sha>` + `canary` on `main`). Nothing anyone can pull by name is ever published
before e2e has passed against it, and the app is built once per platform instead
of once for the image plus again from source for the tests. The per-platform
digests and the `docker-metadata-action` bake file travel between those
workflows as run artefacts, which is why they must stay in one workflow run
(`uses:`, not a separate `workflow_run`). Both arches build natively
(`ubuntu-24.04-arm` for arm64), never under QEMU.

**`template-versions.yaml` bumps the built-in templates' pinned tags weekly**
(Monday 05:17, plus `workflow_dispatch`): `scripts/bump-template-versions.ts`
rewrites the `tag` of every version-pinned `templates/*/*.json` to the newest
stable tag of the same shape (`scripts/template-tags.ts`, unit-tested in
`tests/unit/scripts/`), and `peter-evans/create-pull-request` opens or updates
one rolling PR from `chore/template-versions`, with the script's table as its
body. A PR opened with the default `GITHUB_TOKEN` starts no workflows, so the
job uses the `TEMPLATE_BUMP_TOKEN` secret when it exists (a fine-grained PAT, or
a GitHub App token, with contents and pull-requests write on this repo): the PR
then runs the normal `pull_request.yaml` chain, templates E2E included. Without
that secret it falls back to `GITHUB_TOKEN` (which needs "Allow GitHub Actions
to create and approve pull requests" in the repo settings) and calls
`templates-e2e.yaml` itself on the PR's head commit, so the bump is still
proven; the PR's own checks stay empty until someone closes and reopens it.

**A merge to `main` is a canary, not a release.** The flow is trunk-based with
promotion, deliberately not a `next`/`canary` branch: squash-merging a branch
into `main` would collapse every PR title `releaser` reads into one commit and
leave the two branches permanently diverged. Instead `publish.yaml` publishes
every push to `main` as the canary : images tagged `<sha>` + `v<version>` +
`canary` (never `latest`), binaries stamped `<next version>-canary.<n>`, where
`n` is `git rev-list --count HEAD` on `main` (a number, not the SHA, so two
canaries order correctly, and the self-update notice ranks a canary below the
release it becomes, see `version.ts`), and a GitHub prerelease tagged
`v<version>` per run, uploaded through
`upload-release-assets.ts v<version> --prerelease` (which publishes it with
`--latest=false`), keeping the newest five. Not one rolling `canary` tag:
immutable releases are on, and a tag an immutable release ever used can never be
recreated, even after deleting it (that's how `canary` got burned). Everything
stable reads `releases/latest` or `:latest`, which a prerelease never is, so
nothing stable moves.

**Every push to `main` also ships as a nightly, from its own workflow.**
`nightly.yaml` runs next to `publish.yaml` rather than inside it, so a nightly
never waits on Code Quality, Go, or e2e: it runs prek (the same hook set Code
Quality runs, minus the heavy gates it skips there) alongside the image and
binary builds, then assembles the per-platform digests into `:nightly` and
`:v<version>` and publishes a `v<version>-nightly.<n>` prerelease with its own
binaries. The app image is built with the nightly version baked in, so there's
no `FROM`+`ENV` restamp. A newer push cancels a nightly still in flight. A build
that fails anything but prek still ships as nightly; that's the point. Canary
and nightly share `n` because both count commits on the same SHA (`run_number`
is per workflow, so it stopped working once nightly got its own), and both
version comparers (`version.ts`, `internal/release/version.go`) order two
`<word>.<n>` prereleases by `n` alone, so switching between the channels works
both ways instead of `nightly` always sorting above `canary` lexically. Every
prerelease lookup filters by its label (`-canary.` / `-nightly.`): the app's
self-update, the CLI's `LatestPrerelease`,
`install.sh --version=canary|nightly`, each channel's keep-five retention, and
the `stable` job's "newest canary" check, which would otherwise try to release a
nightly. `scripts/publish-nightly.sh` does the publishing: it recreates a
`v<version>-nightly.<n>` whose tag points at a different commit (a re-run or a
force-push keeps `n`, so the old tag would otherwise ship new binaries under old
code), and fails the job unless the release ends up published, a prerelease,
with every binary uploaded and its tag on the pushed SHA.

**A stable release is merging the release PR.** The `canary` job's last step
runs `releaser` (v1.5.0+) with `release-pr: true`, which force-pushes a
`chore(release): X.Y.Z` commit (`CHANGELOG.md` + `package.json` version, built
on top of `main`) to `releaser/release` and opens or updates its PR, with
`RELEASE_TOKEN` so the PR's own checks run (a `github.token` PR triggers no
workflows). `pull_request.yaml`'s `changes` job treats that PR as docs-only when
nothing but `CHANGELOG.md` and `package.json`'s version changed, so it doesn't
rebuild anything. When the squash lands, `publish.yaml`'s `resolve` job spots
the `chore(release): X.Y.Z (#N)` subject and runs the `stable*` jobs **instead
of** the canary pipeline: `stable` refuses unless the newest canary prerelease's
commit matches this one apart from docs paths and the release bump, and dry-runs
`releaser` (`release-pr` mode reads the version off the release commit);
`stable-binaries` rebuilds the binaries with that version; `stable-images`
retags the canary `<sha>` images as `vX.Y.Z`, `latest` and `canary` (the app one
through the same `FROM`+`ENV HOMERUN_APP_VERSION` build as `promote`, so a
canary instance lands on the stable version and stops seeing the notice);
`stable-release` runs `releaser` for real, which tags the release commit and
drafts the release, then uploads. Nothing is rebuilt or re-tested at release:
what ships is exactly what ran as canary. The release commit has no `[skip ci]`
(`release-pr` mode needs that push to run), which is why the subject check
exists.

**A merge to `main` doesn't rebuild what the PR already tested.**
`publish.yaml`'s `resolve` job looks up the merged PR and promotes its `pr-<n>`
images straight to `<sha>` + `canary` (`promote`, a
`docker buildx imagetools create`, no build, no e2e, no `code_quality`) when
three things hold: the squash commit's tree matches the PR head's tree apart
from `CHANGELOG.md` and `package.json`'s `version` field (the ruleset doesn't
require up-to-date branches, so this is checked rather than assumed), `CI Gate`
passed on that head, and both `pr-<n>` tags exist. The release-bump exclusion is
load-bearing: every release pushes a `chore(release)` commit touching exactly
those two, so almost every PR is behind `main` by one, and a strict tree
comparison sent PR #17 down the rebuild path, where e2e re-ran against a fresh
image and failed on flake the PR had never hit, blocking the release. The app
image doesn't embed the version, so that diff can't change what ships. Anything
else (a direct push, a stale PR, a fork) falls back to the full build → e2e →
manifest chain. Binaries always rebuild, since the release version is baked into
them. The `canary` job accepts either path. `pr-<n>` tags of a merged PR are
deleted by `publish.yaml`'s `cleanup` once the images are published, not by
`pr-cleanup.yaml` (which now only handles PRs closed unmerged), otherwise the
two would race on merge and delete the tag being promoted. Both call
`delete-pr-images.yaml`.

**Docs-only changes skip the expensive jobs.** `publish.yaml` has a
`paths-ignore` for `docs/**`, `**/*.md`, `.agents/**` and `.claude/**`, so a
docs push neither builds nor releases (its commits ship with the next code
push). `pull_request.yaml` can't do the same at the workflow level, since
`CI Gate` is the ruleset's required check and a workflow that never runs leaves
it pending forever: its `changes` job lists the PR's files against the same
patterns and, when nothing else changed, skips binaries, image builds, e2e,
screenshots and `code_quality`'s `ts-test` (its `tests` input). Lint still runs,
it covers markdown. Keep the two pattern lists in sync.

**PR titles must be conventional commits.** The repo squash-merges with the PR
title as the commit message, so the title is what `orochibraru/releaser` reads
to pick the next version and write the changelog. `pr-title.yaml` rejects a
non-conventional title and leaves a notice saying whether the type cuts a
release (`feat`/`fix`/`perf`/`refactor`/`docs`, or a `!`). A title like "Fix/bug
batch" merged without releasing anything before this existed.

**Every PR gets one comment, edited in place.** `pull_request.yaml`'s `summary`
job runs `if: always()` after everything else and upserts a single comment
carrying the check table (with Playwright's own pass/fail counts), the images
that were published and the tag they got, and a copy-pasteable
`HOMERUN_VERSION=pr-<n> docker compose -f compose.prod.yaml up -d` for trying
that exact build. It finds its previous comment by a hidden
`<!-- homerun-ci-summary -->` marker on the first line and PATCHes it, so a
force-push or a re-run edits one comment instead of adding another. The plumbing
behind the counts is worth knowing before touching it:

- **Reusable workflows only report one aggregate `result` to the caller**, so
  `code_quality.yaml` exposes its two jobs separately through `workflow_call`
  outputs. Those outputs can't be `${{ jobs.<id>.result }}` — actionlint (which
  `code_quality.yaml` itself runs via prek) rejects `result` on the `jobs`
  context there — so each job ends with a `Record result` step writing
  `job.status` to a step output, which the workflow output then reads.
- **The Playwright counts come from its JSON reporter**, enabled per-run rather
  than in the config: CI appends `--reporter=list,json` and sets
  `PLAYWRIGHT_JSON_OUTPUT_NAME`, then a `jq` step turns `.stats` into
  `"25 passed"` / `"23 passed, 2 failed"`. Reading the file in a separate step
  is what makes the counts survive a failing test run : the reporter step has
  `if: always()`, so a red job still comments its real numbers instead of
  nothing.
- **The job is gated on the PR not coming from a fork**, like the publish jobs :
  a fork's `GITHUB_TOKEN` is read-only and couldn't comment anyway. It carries
  its own `pull-requests: write` at job level rather than widening the
  workflow's default token, and it is deliberately **not** in the `gate` job's
  `needs` : a failed comment shouldn't block a merge.

Three consequences worth not re-deriving: **a fork builds but publishes
nothing** — `push: false` makes the build `type=cacheonly`, so no digest
artefact exists, which is why `e2e.yaml` takes a `pulled` input and falls back
to `bun run build`, and why every manifest job is gated on the PR not coming
from a fork. **`pr-cleanup.yaml`** deletes the `pr-<n>` tags when a PR closes
unmerged (see above for merged ones), so the Docker Hub repos don't accumulate
one per pull request; a 404 there is normal (e2e failed, so the tag was never
created). And **`code_quality.yaml` no longer runs e2e at all** — it is `lint` +
`docs-check` + `ts-test` only, with the heavy gates (`lint`, `check`, `test`)
skipped inside prek via `SKIP` and run as their own named steps instead, so a
red run names the gate that broke rather than burying it in one `prek` log. Its
`Codegen is current` step runs `bun run gen` and fails on any resulting diff,
which is what keeps `openapi.json`, `homerun.schema.json` and
`tests/integration/support/openapi-types.ts` from silently going stale after a
REST API change (the CLI itself has no generated types to go stale, see Homerun
CLI in `api-and-cli.md`).

`orochibraru/releaser` (this org's own GitHub Action, replacing the whole
`semantic-release` plugin chain: `@semantic-release/{exec,git,github,npm}` and
`.releaserc.json` are gone, along with `scripts/bump-version.ts`), driven by
conventional-commit messages the same way (this repo's commits already follow
`feat:`/`fix:`/`chore:`, no new discipline required), with
`rules: breaking=patch,feat=patch,docs=patch,refactor=patch` (every releasable
type bumps only the patch digit; there's no automatic minor/major here). It runs
three times: `publish.yaml`'s `version` job dry-runs it (`dry-run: "true"`)
purely to read the next `version` for the canary stamp (falling back to
`package.json`'s version when nothing is releasable); the `canary` job runs it
for real with `release-pr: true` and
`prepare: bunx prettier --write CHANGELOG.md` to keep the release PR current;
the `stable` job dry-runs it for the stable version and tag, and
`stable-release` runs it for real with `draft: "true"`. One version number
covers the whole repo: `releaser` bumps `package.json`'s `version` field and
`CHANGELOG.md` itself (none of the three `cmd/` Go programs carry a
`package.json` of their own to bump, they read the root one's version directly
at build time, stamped in via `-ldflags` into `internal/buildinfo.Version`, see
`scripts/build-packages.ts` below). `scripts/build-packages.ts` builds every
release binary: all three commands (`cli`, `installer`, `worker`) are Go, so
every target cross-compiles from any one machine (`go build` with
`GOOS`/`GOARCH` set, exact, unlike Bun's own cross-compilation — see Homerun CLI
in `api-and-cli.md`): `cli` for all four targets
(`amd64`/`arm64`/`darwin-amd64`/`darwin-arm64`), `installer` and `worker` for
`amd64`/`arm64` Linux only, since both only ever run on the Linux host they
manage (`worker`'s Linux-only build covers its agent mode too, see Homerun
Worker's agent mode below). Eight binaries total, so
`scripts/upload-release-assets.ts` has something to attach.

**`releaser` doesn't upload the binaries itself.** It creates the release as a
draft (`draft: "true"`) and reports whether one actually happened
(`steps.releaser.outputs.released`); when it did, `stable-release`'s next step
runs `scripts/upload-release-assets.ts "$TAG"`: one
`gh release upload --clobber` per binary with retries, all eight concurrently,
skipping any already uploaded at the same size, then
`gh release edit --draft=false --latest`.

**Every binary is published gzipped, as `<name>.gz`.** The rationale predates
the agent's move to Go: back when it was the one `bun build --compile` binary,
it was ~62-82MB of which ~62MB was the embedded Bun runtime (a hello-world
compiled to the same size), so ten of them was ~800MB per release and the
sequential upload step ran 40+ minutes. Every binary is Go now and none embed a
language runtime, but the gzip step, the `.gz`-suffixed asset naming and every
downloader that unpacks one stayed, both for the smaller download and because
nothing forces re-deriving it: `install.sh`/`bootstrap.sh`/`swarm-join.sh` pipe
through `gunzip -c`, `internal/installer/release.go`'s `DownloadReleaseBinary`
curls `<name>.gz` and shells out to `gunzip -f` the same way, and `cmd/cli`'s
own `homerun update` (`downloadRelease`) unpacks in-process via
`internal/release.DownloadGzipped` (`compress/gzip`), the one place this repo
does it without shelling out. Releases up to v1.0.33 carry raw, un-suffixed
assets, so `scripts/e2e-multipass.ts`'s pinned `PREVIOUS_RELEASE` download stays
un-suffixed until that pin moves past v1.0.33. Real failure it replaced: the
plugin uploads all ten ~80MB binaries in one go with no retry, uploads took
minutes each, and a 504 from `uploads.github.com` on the tenth left v1.0.32 a
draft with the tag pushed and no way to resume. Since a draft isn't
`releases/latest`, `install.sh` and `homerun update` never see a release until
every binary is on it. A failed upload step is finished by hand: download the
run's `binaries-*` artifacts into `dist/` and run the script with that tag.

**Terraform provider registries.** Both registries only read a public GitHub
repo named `terraform-provider-<name>`, so the monorepo can't be published
directly: `publish.yaml`'s `stable-terraform-provider` job (stable releases
only, after `stable-release`) copies `terraform/provider` into
`orochibraru/terraform-provider-homerun` as one commit, tags it `vX.Y.Z`, and
creates the release there with what `scripts/package-terraform-provider.sh`
builds from the `stable-binaries` artifact: one
`terraform-provider-homerun_X.Y.Z_<os>_<arch>.zip` per target (holding
`terraform-provider-homerun_vX.Y.Z`), the `_manifest.json` (protocol 6.0), the
`_SHA256SUMS` over both, and its binary detached `.sig`. The registries reject
an ECC key, so the signing key is RSA. Secrets:
`TERRAFORM_PROVIDER_GPG_PRIVATE_KEY` (ASCII-armored export),
`TERRAFORM_PROVIDER_GPG_PASSPHRASE`, and `TERRAFORM_PROVIDER_REPO_TOKEN` (a
fine-grained PAT with Contents: write on the mirror). The release is created
with its assets in one `gh release create`, never published empty, since the
registry ingests a version from the release webhook. A re-run skips the push
when the tag exists and re-uploads with `--clobber`. The package script runs
locally too:
`scripts/package-terraform-provider.sh <version> [binaries dir] [output dir]`,
signing with the default key of the current `GNUPGHOME`.

**Container images go to Docker Hub, not GHCR**, deliberately:
`docker.io/orochibraru/homerun{,-worker}`. That's the one piece of the pipeline
that does _not_ follow the code host, so `docker.yaml`'s login takes a real
Docker Hub credential (`secrets.DOCKER_REGISTRY_PASSWORD`, an access token; the
Docker Hub username is the plain `registry_username` input, since it isn't
secret) rather than the built-in `GITHUB_TOKEN`.

**`publish.yaml`'s `canary` and `stable-release` jobs need
`secrets.RELEASE_TOKEN`, not `GITHUB_TOKEN`**: a fine-grained PAT scoped to this
repo (Contents + Issues + Pull requests: write). Nothing pushes to `main` any
more, but `releaser` still pushes the `releaser/release` branch and the release
tag, and opens the release PR: with the default token that PR would trigger no
workflows, so its required `CI Gate` would never report. It's threaded in twice,
as `actions/checkout`'s `token` (git push auth) and as the action's own `token`
input (its API calls). The dry runs (`version`, `stable`) need no token:
releaser v1.5.0's dry run makes no API call or push, and an empty version fails
the `stable` job loudly rather than shipping a wrong one (a real bug in the
`semantic-release`-era job: a swallowed 403 in its dry run returned an empty
version, and v1.0.22 shipped reporting 1.0.21 with a permanent "update
available" notice).

**Job ids use `-`, never `:`** (`build-app`, not `build:app`). GitHub rejects a
colon in a job id outright and refuses to run the whole workflow file; the
Gitea-era config had `build:app` and got away with it.

**Fork PRs build but never push.** `docker.yaml` takes a `push` input (default
true); `pull_request.yaml` passes
`github.event.pull_request.head.repo.full_name == github.repository`, so a
same-repo PR still publishes its `pr-<n>` tag while a fork's build switches its
bake output to `type=cacheonly` and skips the registry login, the digest upload,
and the whole `merge` job. GitHub withholds secrets from fork PRs, so the login
there could only ever fail; this way the build is still a real gate (and still
warms the layer cache) without needing a credential. `secrets.registry_password`
is `required: false` for the same reason.

**Not verified**: an actual release running end-to-end through
`orochibraru/releaser` on GitHub Actions (creating a real tag/release and
pushing the version bump back to `main`), since it's an external action this
repo doesn't control the internals of. `scripts/build-packages.ts`'s
cross-compilation is verified live regardless, unrelated to which release tool
drives it: all eight release binaries build from one machine (run for real
locally), see Homerun CLI in `api-and-cli.md`.

## Homerun Worker's agent mode + installer (`internal/agent/`, `internal/worker`, `cmd/installer/`)

Two standalone sub-projects under `cmd/`, siblings of `src/` and **not** part of
the SvelteKit build. Both are Go (a Go module at the repo root, `go.mod`, shared
with `cmd/cli/`, no `tsconfig.json`/`package.json` of their own). `cmd/agent/`
**no longer exists as its own binary**: it started as Bun/TypeScript, was
rewritten to Go for the same reason the installer was before it (a
`bun build --compile` binary embeds the whole Bun runtime, ~81MB for a Go-sized
program, a plain Go binary is a few MB), and was then merged into `cmd/worker`
as that binary's agent mode (`internal/worker/agentmode.go`), one binary picked
by whether `DATABASE_URL` is set rather than two separate programs — see
`cmd/worker/README.md` and Homerun Worker in `worker.md` for the mode split
itself. `internal/agent/` (the git-clone/build/OpenAPI logic) stays a real Go
package, just no longer one with its own `main`: `internal/worker`'s agent mode
and the local/Docker-build-server paths in `internal/jobs/deploy/build.go` both
import it directly (see "The agent's git builds" above). The installer's own
earlier TypeScript→Go rewrite was verified behaviour-identical against the old
build (`--mode=agent` and both `--mode=full` variants — the `--mode=full` runs
came back byte-identical, the only `--mode=agent` difference was cosmetic, a
literal `<uid>` placeholder the old code printed in one dry-run step where the
new one prints `1000`). See each folder's own README for the full detail; this
section is the pointer.

Agent mode is a selectable build-server connection kind
(`remote_host.kind: "agent"`, `src/lib/services/agent-client.service.ts`'s
`AgentClientService`, see Build servers above for the wiring) — the field still
says `"agent"`, since that names the _role_ a registered host plays, not which
binary serves it. The installer stays standalone tooling (it's not imported by
`src/` and isn't meant to be, it drives a target machine's shell, not this app's
own runtime).

- **Agent mode** (`internal/worker/agentmode.go`'s `runAgent`), the **Homerun
  Worker with no `DATABASE_URL`**: a small token-authenticated HTTP server meant
  to run on a build server's own Docker daemon (`internal/agent/server.go`'s
  `Server.Handler`, unchanged by the merge). Five routes of its own, plus the
  four workstation routes mounted from `internal/workstation` (see Dev
  workstations in `docker.md`): `GET /v1/health` and `GET /v1/openapi.json`
  unauthenticated (the latter for the same "spec describes shapes, not data"
  reason the main app's is public, health so a monitor can probe liveness
  without holding the token), `POST /v1/build`, `GET /v1/stats` and
  `GET /v1/images/save` behind `Authorization: Bearer <token>`. It is **not** a
  deploy target : the deploy/lifecycle/logs routes it used to carry were removed
  along with remote deploys (see Build servers above), and
  `AgentClientService.verifyToken` probes `/v1/stats` for exactly that reason.
  It deliberately never serves the worker's own Docker control API (exec,
  terminal, arbitrary container creation) even though the two now share a binary
  : agent mode's `runAgent` builds its own narrower `http.Handler` rather than
  reusing `serveControlAPI`, so a leaked agent-mode token still can't reach that
  surface. This is the alternative to registering a build server by raw
  `tcp://`/`ssh://` Docker socket : instead of exposing the daemon itself, the
  build server runs this binary in agent mode and the main app only ever talks
  HTTP-plus-bearer-token to it. **Arch detection is genuinely shared**, not just
  mirrored by hand: `internal/release.Arch` (already `amd64`/`arm64`, no
  remapping needed) and `internal/release.AssetSuffix` (the same, plus a
  `darwin-` prefix for macOS) are the one place this repo maps a Go
  arch/platform onto a release-asset name; `internal/installer/detect.go`'s
  `Arch()` and `internal/cli/update.go`'s `assetSuffix()` both just call through
  to it now, rather than each keeping its own hand-written copy. **Wired into
  the main app**: `remote_host.kind` (`"docker"` | `"agent"`) +
  `agentUrl`/`agentTokenEnc` (schema.ts), `AgentClientService`
  (`src/lib/services/agent-client.service.ts`, a thin HTTP client over
  `build`/`stats`/`health`), and the Remote Hosts "new host" form's
  connection-type toggle; `deploy/worker-spec.ts`'s `buildServerSpec` embeds the
  resolved target's kind in the deploy spec, and `internal/jobs/deploy/build.go`
  branches on it to build through a remote `dockerapi.Client` (a `"docker"`
  host) or over HTTP to the agent-mode worker (`agentBuild`,
  `AgentClientService`'s Go equivalent). `internal/agent/build.go`'s
  `BuildInput` struct is the build body's shape, hand-validated by
  `validateBuildInput` in `internal/agent/server.go` (no schema library, this is
  Go, not zod), and `internal/agent/openapi.go` generates agent mode's own
  OpenAPI 3.1 doc from plain Go literals describing the same shapes, the "one
  schema, two purposes" approach the main app uses with zod (see OpenAPI above)
  without a shared runtime to hang a real schema library off.
  `internal/agent/builders.go` embeds `internal/agent/builder.sh` and
  `internal/agent/builder-tools.json` (`//go:embed`), the generated-and-pinned
  build-tool script and checksums the homerun worker runs in either mode; golden
  files under `tests/unit/go/internal/agent/testdata/*.json` plus
  `tests/unit/app/agent-builder-parity.test.ts` (on the app side, now only
  checking `src/lib/build-methods` against `builder-tools.json`'s method list
  and bake defaults, the form options the app still owns) keep the two from
  drifting on what the UI offers versus what the builder accepts. Env var
  renames from the standalone-agent era, no compat shim: `AGENT_TOKEN` →
  `WORKER_TOKEN`, `AGENT_TOKEN_FILE` → `WORKER_TOKEN_FILE`, `PORT` →
  `WORKER_PORT`, `AGENT_SHUTDOWN_TIMEOUT` gone (agent mode's shutdown grace is
  now the fixed `agentShutdownGrace`, 120s). Any existing remote host running
  the old standalone agent needs reinstalling and re-registering, there's no
  migration path for its token.
- **`cmd/installer/`**, a single-binary installer
  (`internal/installer/installer.go`) meant to be the target of a `curl | bash`
  one-liner (`cmd/installer/bootstrap.sh`) on a fresh Linux server.
  `--mode=full` defaults to the **system (rootful)** daemon (`options.go`'s
  `DockerFlavourOf`): enables it, makes it a swarm manager (`swarm.go`'s
  `EnsureSwarmManager`, `--advertise-addr=` or the default-route address),
  creates the `homerun` bridge and the attachable `homerun-swarm` overlay, and
  writes a compose file whose Traefik runs the swarm provider too, so the app
  boots in swarm mode (see Swarm mode in `docker.md`). The trade-off is a root
  daemon. `--docker=rootless` (and `--mode=agent`, always) installs Docker
  Engine + rootless prerequisites (`uidmap`/`dbus-user-session`), creates a
  dedicated non-root system user, installs **rootless** Docker for it via
  Docker's own documented flow (`get.docker.com/rootless` →
  `dockerd-rootless-setuptool.sh`, `loginctl enable-linger` + a `systemd --user`
  unit so the daemon survives a headless reboot without an active login
  session), creates `homerun` on that daemon, then installs the worker in agent
  mode (`--mode=agent`, default, own `systemd --user` unit,
  `internal/installer/worker.go`'s `InstallWorkerSystemdUnit`, which also
  removes a leftover `homerun-agent` unit/binary from an install predating the
  merge) or the standalone full stack under that account, never as root.
  `--migrate-to-rootful` (`migrate.go`'s `Migrate`) moves a rootless full
  install onto the system daemon in swarm mode, volumes and all, and is
  re-runnable; `--image=` swaps the app image (the e2e suite uses it to run a
  locally built one). **Binaries and Docker images only, nothing built from
  source on the target host** (superseding an earlier draft that cloned the repo
  and ran `bun run build` there): `bootstrap.sh` downloads the
  `homerun-installer-<arch>` release binary itself and `exec`s it (no Bun, no
  git); `--mode=agent` downloads the matching `homerun-worker-<arch>` release
  binary straight to `/usr/local/bin/homerun-worker`; `--mode=full` writes the
  static, generated `compose.yaml` (`internal/installer/compose.yaml`,
  `go:embed` as `ComposeFile`, plus `compose.swarm.yaml` on a swarm install;
  distinct from the root dev `compose.yaml`) and puts everything per-host in
  `.env` (`ComposeEnv`: `HOMERUN_HOST`, `HOMERUN_DOCKER_SOCKET`,
  `HOMERUN_IMAGE`, `HOMERUN_VERSION`, `DASHBOARD_CERT_RESOLVER`, upserted by
  `SetEnvValues` without touching other lines), then
  `docker compose pull && ...up -d`. The file is static so self-update can
  overwrite it wholesale, see Self-update below; the same two files are `COPY`d
  into the app image at `/app/compose/`.

  **`--mode=full` resolves an address for the instance and it is never
  `localhost`** (`main.go`'s `resolveHost`): `--domain=` wins, else an
  interactive prompt (skipped when stdin isn't a TTY, which is every
  `curl | bash` install), else `detect.go`'s `HostAddress()` (the `src` of
  `ip -4 route get 1.1.1.1`, falling back to the first non-loopback
  `hostname -I` address). It becomes `baseDomain` in the generated
  `homerun.yaml` and the `ORIGIN` default in the generated `compose.yaml`, and
  `homerun.yaml` no longer carries its own `auth.origin` so those two can't
  disagree. **Real, reported bug this fixes**: the old `http://localhost:3000`
  default didn't just produce wrong absolute URLs, it made a fresh instance
  impossible to sign up to. With `ORIGIN` set, the adapter pins `event.url` to
  it, so better-auth derives its `baseURL`, and therefore its trusted origins,
  from `localhost` while the browser's `Origin` header is the real address, and
  `POST /api/v1/auth/sign-up/email` 403s with `Invalid origin`.
  `compose.prod.yaml` (the manual Option B path, where nothing can detect an
  address) makes `ORIGIN` required with `${ORIGIN:?...}` instead, the same
  fail-closed shape `AUTH_SECRET` already used.

  `release.go` is the one place both artifact kinds (release binaries vs. the
  Docker image) resolve from: `--version=` (a GitHub release tag, default
  `latest`) picks which release's binaries to fetch, but doesn't pin the app
  image the same way. Every channel's images also carry the release tag itself
  (`:vX.Y.Z`, `:vX.Y.Z-canary.N`, `:vX.Y.Z-nightly.N`), which is what the manual
  agent setup commands pin. Every shell-out goes through one `StepRunner`
  (`exec.go`, a `Runner` interface so tests can fake it) so `--dry-run` (print
  every command instead of running it) is a single interception point, not
  scattered per-step conditionals. **Verified**: the full command sequence via
  `--dry-run` for both modes (including on a non-Linux dev machine, via a
  dry-run-only package-manager-detection fallback, and including the generated
  `compose.yaml` content), and that the compiled binary's dry-run output matches
  running from source.

  **The real, mutating steps are now verified too**, against two real disposable
  Multipass Ubuntu 24.04 VMs (superseding this section's earlier "needs a
  disposable VM/CI runner this environment doesn't have" note): `--mode=agent`
  end to end (real `apt`/Docker Engine install, real rootless Docker setup, real
  `systemd --user` unit, the Agent actually running and reachable over the
  network, health endpoint + OpenAPI both responding from outside the VM), and
  `--mode=full` end to end on a second VM (real rootless Docker, real
  `docker compose pull && ...up -d` bringing up Traefik, Postgres, and the real
  published `docker.io/orochibraru/homerun` app image, all healthy, dashboard
  reachable from outside the VM). See `cmd/installer/README.md` for the full
  verification notes and the real bugs this run found and fixed
  (AppArmor-restricted unprivileged user namespaces on Ubuntu 24.04, an
  RootlessKit privileged-port restriction blocking Traefik's 80/443, an unquoted
  YAML scalar in the generated compose file, a postgres-18 volume-mount-path
  mismatch, and a missing `ORIGIN` env var), all now fixed in `docker.go` and
  `fullstack.go` (these findings predate the Go rewrite, carried forward from
  the old TypeScript steps of the same name). `cmd/installer/swarm-join.sh` has
  since had its own real two-VM run (see Swarm mode in `docker.md`), replayable
  with `bun scripts/e2e-multipass.ts --swarm`. `--fresh-swarm` checks a default
  install boots in swarm mode and routes a 2-replica service, `--migrate`
  installs the previous release rootless, deploys a service with a named volume
  holding a marker, runs `--migrate-to-rootful` and checks users, mode, the
  redeploy, the marker's ownership and routing. `--dokploy` installs Dokploy
  (driven through its own REST API: sign-up, API key, an nginx app on a named
  volume with a domain, a Postgres), installs Homerun next to it with
  `--dashboard-port=4500 --http-port=8080 --https-port=8443`, checks Dokploy
  still serves on 80, imports both through Settings → Migrate, stops each on
  Dokploy, deploys the Homerun copy and checks both markers survived on the
  shared volumes, then stops `dokploy-traefik` and re-runs the installer with
  80/443. `--local-image` builds the app image from the checkout and loads it
  into each VM, which app-side changes need since the installer otherwise pulls
  the published image.

  This whole run is reproducible, not a one-off: `bun scripts/e2e-multipass.ts`
  automates exactly this, builds the installer/worker/CLI binaries from local
  source (not a published release, so it catches a regression before it ships),
  launches two disposable Multipass VMs, runs the real installer binary on each
  (`--mode=agent` / `--mode=full`), signs up + onboards the bootstrap admin over
  the real HTTP API, registers the agent VM as a build server and
  deploys/stops/starts a real service, then drives a real `homerun login`
  device-code round trip plus every documented CLI command from a throwaway
  Docker container, tearing everything down after (`--keep` to leave it running,
  `--skip-build` to reuse a previous build). Deliberately **not** wired into any
  GitHub Actions workflow, this repo's CI runners have no nested virtualization
  for Multipass, it's a local-only tool to run by hand before cutting a release
  or after touching installer/worker/CLI code.

  `bun scripts/e2e-multipass-release.ts` is its mirror image, and the two share
  `scripts/e2e/` (`multipass.ts`, the VM/HTTP machinery both drive; `docs.ts`,
  the docs command extractor; `release.ts`, the GitHub-release resolver). Where
  the suite above builds from local source and runs the binaries directly, this
  one runs **only what's already published, using the commands the docs
  themselves print**: the one-liners are extracted from
  `docs/getting-started.md`, `cmd/worker/README.md` and `docs/api-and-cli.md` at
  run time and executed verbatim (`Vm.runScript` writes a documented block to a
  file and runs it rather than re-typing it), so a renamed flag or a moved
  `raw.githubusercontent.com` path fails the run. Phases are `--only=`/`--skip=`
  selectable: `docs` (cross-checks every place the same command is documented,
  asserts each documented URL exists in this checkout _and_ is live, and asserts
  the GitHub release under test really published all eight binaries, no VM
  needed, seconds to run), `full`, `agent`, `remote`, `cli`, `compose`
  (`docs/getting-started.md`'s Option B, on rootful Docker). Because it tests
  what's published, a fix in the working tree isn't reflected until it ships,
  that's the point, not a gap, `--ref=<branch>` points the documented URLs at a
  pushed branch when verifying a docs/installer change before merging, and
  `--version=vX.Y.Z` pins a release instead of `latest`.

## Documentation (`docs/`, `README.md`, `CONTRIBUTING.md`)

Three audiences, three places, keep them apart:

- **`CLAUDE.md`** (this file): everything a future session needs that isn't
  derivable from the code, including the "real, tested finding" notes. Not
  user-facing.
- **`docs/*.md`**: the operator-facing guides, one flat page per feature
  (`getting-started`, `configuration`, `services` as the hub for the per-feature
  service pages, `stacks`, `templates`, `storage-volumes`, `backups`,
  `users-and-roles`, `authentication-providers`, `login-wall`, `dashboard`,
  `docker-cleanup`, `api-and-cli`, `faq-and-limitations` and the rest, every one
  listed by area in `docs/README.md`, which a new page must be added to), plus
  the root `README.md`; `CONTRIBUTING.md` covers the dev-workflow half. These
  are the source of truth, plain Markdown, readable straight from the repo. The
  commands they print are **executed verbatim** by
  `bun scripts/e2e-multipass-release.ts` (see above), so a stale install
  one-liner is a test failure, not just a doc nit. **Configuration docs are
  UI-first on purpose**: an operator is expected to configure Homerun from
  `/settings` and the onboarding wizard, never from a file.
  `docs/configuration.md` leads with the dashboard, treats
  `DATABASE_URL`/`AUTH_SECRET`/`ORIGIN` as the three unavoidable boot-time
  values, and demotes `homerun.yaml` to an optional config-as-code path. Don't
  reintroduce an env-var table as the opening section.

- **The website** (<https://homerun.orochibraru.com>): built from a **separate
  repository** that renders this repo's `docs/*.md` itself. It used to live here
  as `packages/docs/` (a static SvelteKit site published as
  `docker.io/orochibraru/homerun-docs`, from back when `agent`/`cli`/`installer`
  still lived under `packages/` too); that sub-project, its `scripts/docs.ts`
  wrapper, the `dev:docs`/`build:docs`/`check:docs` scripts, the `docs`
  Dockerfile stage and bake target, and every CI job building or publishing it
  are all gone. Don't reintroduce a docs site under `cmd/` or elsewhere in this
  repo.

## The app's build and server (`vite.config.ts`, `@sveltejs/adapter-bun`)

- **No `svelte.config.js`.** SvelteKit's config lives in `vite.config.ts`'s
  `sveltekit({...})`. `tsconfig.json` extends `$app/tsconfig` with
  `"include": ["src", "tests", "*"]`, so tests and root config files are
  type-checked by `bun run check`. There is no `experimental.instrumentation`
  option any more: kit 3 loads `src/instrumentation.server.ts` on its own.
- **Adapter.** `@sveltejs/adapter-bun` with
  `buildOptions: { compile: true, sourcemap: "none" }` still compiles one
  standalone `build/server` (`bun run start` runs it).
  `serverOptions: { idleTimeout: 0 }` is covered in `api-and-cli.md`.
  `App.Platform` comes from the adapter's ambient types.
- **Patched adapter.** adapter-bun has no runtime `ORIGIN` (kit 3 made it
  build-time `paths.origin`), so `patches/@sveltejs%2Fadapter-bun@1.0.0.patch`
  (bun `patchedDependencies`) makes it read `ORIGIN` at runtime and keep a
  remote-function call's own origin when its `Origin` header names the request's
  host, see "Remote functions" in `services-and-templates.md`.
- **Chunks.** The `manualChunks` vendor split lives under
  `environments.client.build` in `vite.config.ts`, client-only: an SSR-wide
  split broke adapter-bun's chunk layout.
- **Shutdown.** adapter-bun doesn't exit the process after its SIGTERM drain, so
  `init` in `hooks.server.ts` does
  `process.once("sveltekit:shutdown", () => process.exit(0))`. The drain itself
  is `SHUTDOWN_TIMEOUT` (30s default); the integration suite sets it to 2.
- **Image healthcheck.** adapter-bun ships no healthcheck binary and no
  `/_health` endpoint. `/app/build/healthcheck` in the image is
  `tools/docker/healthcheck.sh` (busybox `wget`, honours `HOST`, `PORT` and
  `HEALTHCHECK_PATH`, default `/api/health`), kept at that path because
  self-update's updater `docker exec`s it with `HEALTHCHECK_PATH=/api/v1/ready`
  (see below).
- **Migration gotcha.** `sv migrate sveltekit-3` has a parser bug: a `</script>`
  inside a TS string literal in a file it rewrites fails with "Unterminated
  string constant".

## Self-update from the sidebar (`src/lib/services/self-update.service.ts`, `src/lib/remote/self-update.remote.ts`, `app-version.svelte`)

The sidebar prints the running version for everyone; admins also get a "vX is
available" notice that opens the update dialog. All of it loads through remote
queries (`getAppVersion`, `getReleaseStatus`, `getUpdatePreflight`) and one
`startSelfUpdate` command, so the layout never waits on GitHub or Docker.

**The version is `HOMERUN_APP_VERSION`, falling back to `package.json`**
(`src/lib/server/app-version.ts`). Reading `package.json` alone is always one
release behind in a published image: `orochibraru/releaser` bumps it in the
`release` job, after the image was built, and the promote path retags a PR image
that was built before the merge. So `docker.yaml` takes an `app_version` input
(the `version` job's dry-run result) and bakes it as a build arg
(`docker-bake.hcl` → `Dockerfile` `ARG`/`ENV`), and `publish.yaml`'s `promote`
job no longer `imagetools create`s the app image: it builds
`FROM homerun:pr-<n>` + `ENV HOMERUN_APP_VERSION=<version>` for both platforms
(no `RUN`, so no QEMU) and pushes that as `vX.Y.Z` + `latest`. The worker image
is still a plain retag. Without this the notice would never go away after an
update.

**The channel** is `instance_settings.update_channel` (`stable` when null), set
on Settings → General. **Latest release** is
`GET /repos/orochibraru/homerun/releases/latest` for stable, and the first
prerelease in `/releases?per_page=30` whose tag parses as a version for canary
(the Go CLI's `release.LatestCanary` does the same). Cached per channel on the
service instance for ten minutes (five minutes after a failure, which returns
`null` rather than an error). Comparison is `self-update/version.ts`'s small
semver compare, a leading `v` is ignored and a non-version never counts as
newer. The sidebar refreshes `getReleaseStatus` on the same ten-minute interval,
so a release shows up without reloading the page or restarting the container.
The same status and start are exposed to admins as
`GET/POST /api/v1/instance/update` (`homerun instance status`/`update`), for
when the dashboard itself is unreachable; a refused start is a `409` carrying
`start()`'s message.

**Finding its own compose project.** The service inspects its own container
(`os.hostname()` first, then the 64-hex id out of `/proc/self/mountinfo`) and
reads `com.docker.compose.project`/`.service`/`.project.working_dir`/
`.project.config_files` (`self-update/compose-target.ts`). No labels, or no
container at all (dev), means "not supported" and the dialog says so. The host
path of the Docker socket comes from the container's own mount whose destination
is `config.docker.socketPath`, so the rootless installer layout
(`/run/user/<uid>/docker.sock` on both sides) and `compose.prod.yaml`
(`/var/run/docker.sock`) both work.

**Start sequence** (`SelfUpdateService.start`): refuse unless a newer release
exists, `JobWorker.hold()`, re-run the preflight (no `deploy` job queued or
running, no job of any type running, the worker has nothing in flight; the
verdict is `self-update/preflight.ts`'s pure `preflightFrom`/`startRefusal`,
over `JobDTO.listUpdateBlockers()`, which the dialog, `GET /instance/update`'s
`preflight.blockers` and `homerun instance status` all list with a `stale`
flag), pull `docker:cli`, force-remove any stale `homerun-updater`, then create
and start it with the socket at `/var/run/docker.sock` and the working dir plus
every config file's dir bind-mounted at their host paths. Any throw releases the
hold. The helper is a plain container with restart policy `no` and no
auto-remove, independent of the app container, so stopping the app doesn't take
it down and its logs survive a failed run. Its script (`updaterScript`) branches
in shell on the project dir's `compose.yaml`:

- **Generated** (first-line `# homerun:generated`, or the pre-static installer's
  `# Generated by the Homerun installer` header): fills in any `.env` key the
  static file reads that `.env` lacks, recovered off the running app by
  `composeEnvDefaults` (host from the dashboard router rule label, resolver
  label, `ORIGIN` env, socket path; never overriding an existing key), rewrites
  `HOMERUN_VERSION` to the target tag, `docker pull`s the new image and `cat`s
  `/app/compose/compose.yaml` (and `compose.swarm.yaml` when that file exists or
  the old one had `providers.swarm`) out of it over the old files, in place so
  owner and mode survive. Real reason: an old compose file can be incompatible
  with a new image, and the image is the one thing that's guaranteed to match
  its own version, canary and `pr-<n>` included, with no GitHub asset to fetch.
- **Hand-written**: never replaced, only a pinned tag is bumped (`sed` over the
  config files for `<repo>:<oldtag>`, and `HOMERUN_VERSION=<oldtag>` in `.env`,
  keeping the `v` prefix style).

Either way the target tag is `pinnedTagFor`'s: always `canary` on the canary
channel; on stable, `latest` stays `latest` and anything else (a version,
`canary`, `pr-<n>`) is pinned to the release, which is how switching back from
canary lands on a stable tag. Switching back never downgrades because only a
strictly newer version counts as an update, and a release outranks its own
canaries.

Then `docker compose -p <project> "$@" pull`, and the safety net, before
`up -d --no-deps` for the app and its worker companions only. Real finding that
motivated it: a canary whose auth layer threw on every request still passed the
image's old `/_health` (the previous adapter answered it before any hook ran;
adapter-bun has no such endpoint), got swapped in, and took the instance and
every gated site down. The updater backs up every file it may rewrite
(`<file>.homerun-rollback`) before touching them, then starts the new image as
`homerun-update-candidate` through `docker compose run -d --no-deps` (so it gets
the service's own env, volumes and networks, but no published port) with
`HOMERUN_CANDIDATE=1` and `traefik.enable=false`, on the app's own port so the
login wall's `homerun-auth` alias can move to it: once it's ready the updater
reconnects it to the Homerun network with that alias, keeps it through `up -d`,
and removes it only after the new app answers (see the self-update 500s in
`auth.md`). `HOMERUN_CANDIDATE` makes `init()` stop right after auth is built:
no job worker, schedulers, orchestration apply or core-services watch, which
would recreate Traefik next to the live app. `wait_ready` polls `/api/v1/ready`
(settings row + `auth.api.getSession`, the path the bug broke) through the
image's own `/app/build/healthcheck` (`tools/docker/healthcheck.sh`, a busybox
`wget` script honouring `HOST`, `PORT` and `HEALTHCHECK_PATH`, default
`/api/health`, kept at that path for exactly this) with
`HEALTHCHECK_PATH=/api/v1/ready`, via `docker exec`, since the updater isn't on
the app's network. A failed candidate restores the files and exits 1 without
recreating anything. After `up -d`, the same check runs against the new app
container, and a failure there restores the files and runs `up -d` again on the
old tag, which is still pulled locally. The candidate does run the new
migrations on the live database; they're additive, and the old version keeps
working on them. On the app side, `start()` then follows the updater
(`#watchUpdater`): if it exits and this process is still alive, the update
didn't take, so the job hold is lifted and an `update_failed` notification names
the last `==>` line; after 30 minutes it lifts the hold regardless. **Never
Traefik, Postgres or anything outside the project**: Traefik carries flags the
app applies at runtime (swarm provider, ACME email, custom SSL) that a compose
recreate would drop, and the Newt tunnel is a bare container or swarm service
with no compose labels, which `--no-deps` without `--remove-orphans` can't
touch. The script is exercised under a real `sh` against a fake `docker` in
`tests/unit/app/self-update.test.ts` (the hand-written case skips on macOS,
whose BSD `sed -i` differs from the updater's busybox one), and `docker:cli`
does ship the compose plugin. **Not verified**: a real end-to-end update on an
installed instance, and the CI changes above (nothing here can run GitHub
Actions).

**The hold is in memory, not a DB column**, on purpose: it lives exactly as long
as the process that's about to be replaced, so the new container boots with the
worker running and there's no stale flag to clear if an update dies halfway.
It's on `globalThis` so an HMR-reloaded worker module sees the same flag.
`JobWorker.tick()` and `#pump()` both return early while held, jobs that get
enqueued meanwhile (schedulers, the API) just wait in `queued` and run after the
restart, and anything left `running` is requeued by the existing orphan recovery
on boot. Covered by `tests/unit/app/self-update.test.ts`.

**Update anyway** (`start({ force: true })`, the dialog's confirm-gated button,
`POST /instance/update {"force": true}`, `homerun instance update --force`)
skips only the job checks (`startRefusal`): no newer release or not a Compose
service still refuses, and the hold still applies. It logs the overridden jobs.
What happens to each, by stage: queued stays queued; none/`prepare` (app-side,
killed with the old app) is requeued by the new app's boot `requeueOrphaned` and
re-runs, a deploy reusing its `deploymentId` row; `execute` gets the old
worker's 60s shutdown grace (inside its 65-75s `stop_grace_period`), then is
cancelled and released for the new worker to re-run, or, if the worker died
harder than that, re-claimed once the 60s lease lapses; `finalize` (held app
never finalized it) and `finalizing` (reset to `finalize` at boot) are finalized
by the new app. Real case that motivated it: an instance refused with "1 job(s)
are running" and nothing showed which job.
