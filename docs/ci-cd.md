# Deploying from CI

[Deploy on push](deploy-on-push.md) covers a service Homerun builds from git.
When your CI builds and pushes the image itself (tests first, a registry of your
own, a monorepo that builds several images), let the pipeline tell Homerun when
to deploy instead: a GitHub Action, a Docker image for GitLab or any other CI,
or one API call.

Every option does the same thing: it deploys the service and **waits for the
deploy to finish**, exiting non-zero when it fails, so a broken deploy fails the
pipeline. Pass a **tag** to switch the service to the image you just pushed
(`ghcr.io/you/app:3f9c2e1`) before deploying. The tag is saved on the service,
so later deploys and restarts keep it; leave it out to redeploy the current tag.
A tag only applies to image-based services: a service Homerun builds from git
answers 400.

## What you need

- **An API key** with write access to **Services**, from your profile's
  [API keys](your-profile.md#api-keys). A key with only read access can't
  deploy, and deploying needs the owning account to hold write on Services too.
  Pick an expiry you can live with and rotate the secret before it. Store it as
  a CI secret, never in the repository.
- **The service's id**: `homerun services list`, or the last part of the
  service's URL in the dashboard (`/services/<id>`).
- **Your instance's URL**, e.g. `https://homerun.example.com`, reachable from
  the CI runner. A dashboard only on your LAN needs a self-hosted runner there.

The deploy request stays open until the deploy finishes, which for a large image
can take minutes; a proxy in front of Homerun needs a timeout long enough for
that.

## GitHub Actions

Homerun's repository is a set of actions, all pinned to the same release tag as
your CLI and instance: one that runs any `homerun` command, and dedicated ones
for the common jobs. Each installs the CLI release matching its own tag (or
`cli-version`), runs on Linux and macOS runners, not Windows, and fails the step
when the command fails. Pin a release tag rather than `main`, so an upgrade of
your instance and of your pipelines happen when you choose.

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      # ...build and push ghcr.io/you/app:${{ github.sha }} first...
      - uses: orochibraru/homerun/actions/deploy@v1.0.59
        with:
          base-url: https://homerun.example.com
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          service: my-app
          tag: ${{ github.sha }}
```

| Action                                     | What it does                                                                                                          | Outputs                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `orochibraru/homerun`                      | Installs the CLI and puts it on the `PATH`; runs `args` (e.g. `manifest apply my-app --deploy`) when given.           | `stdout`, `cli-path`      |
| `orochibraru/homerun/actions/deploy`       | `homerun services deploy`: switches to `tag` first when given, or deploys the `environment` canary or stable channel. | `deployment-id`, `result` |
| `orochibraru/homerun/actions/rollback`     | `homerun services rollback`: the previous revision, or `revision`; `restore-config: true` restores its settings too.  | `deployment-id`, `result` |
| `orochibraru/homerun/actions/preview`      | `homerun previews` with `command` `deploy`, `wait`, `promote` or `delete`, for the pull request that triggered it.    | `url` (deploy, wait)      |
| `orochibraru/homerun/actions/gate-session` | `homerun gate session`: signs a [service account](login-wall.md) through an app's login wall for end-to-end tests.    | `cookie` (masked)         |

Every action takes `base-url`, `api-key` (a CI secret, never exported to later
steps) and `cli-version`. `service` is an id or a slug. The root action's `args`
is split on whitespace; for an argument containing spaces, call it with no
`args` and run `homerun` in the next step, with `HOMERUN_BASE_URL` and
`HOMERUN_API_KEY` in that step's `env:`. The preview action's `pr`, `commit`,
`branch` and `title` default to the triggering pull request's, and
`gate-session`'s `playwright-file` also writes a Playwright `storageState` file.
A rollback for a deploy step that failed:

```yaml
- uses: orochibraru/homerun/actions/deploy@v1.0.59
  id: deploy
  with:
    base-url: ${{ vars.HOMERUN_BASE_URL }}
    api-key: ${{ secrets.HOMERUN_API_KEY }}
    service: my-app
    tag: ${{ github.sha }}
- run: ./smoke-test.sh https://app.example.com
- if: failure() && steps.deploy.outcome == 'success'
  uses: orochibraru/homerun/actions/rollback@v1.0.59
  with:
    base-url: ${{ vars.HOMERUN_BASE_URL }}
    api-key: ${{ secrets.HOMERUN_API_KEY }}
    service: my-app
```

## GitLab CI and other CIs: the Docker image

`orochibraru/homerun-cli` is the CLI on Alpine, with a shell and nothing else.
It reads its instance and key from `HOMERUN_BASE_URL` and `HOMERUN_API_KEY`, so
there's no login step:

```yaml
deploy:
  stage: deploy
  image: orochibraru/homerun-cli:v1.0.49
  variables:
    HOMERUN_BASE_URL: https://homerun.example.com
    # HOMERUN_API_KEY: a masked CI/CD variable set in the project settings
  script:
    - homerun services deploy 7b1e0c2a-4f7d-4c1e-9a55-2f0d3c8e6b41 --tag
      "$CI_COMMIT_SHORT_SHA"
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

The image has no entrypoint, so GitLab's `script:` runs as written. The same
image works in Woodpecker, Drone, Forgejo Actions or anything else that runs a
container: `homerun services deploy <id> [--tag <tag>]` is the whole command,
and it prints the deploy's result as JSON.

## Without the CLI

The CLI is a thin wrapper around one request:

```bash
curl -fsS -X POST "https://homerun.example.com/api/v1/services/<id>/deploy" \
  -H "Authorization: Bearer $HOMERUN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tag": "3f9c2e1"}'
```

It answers `200` with
`{"success": true, "deploymentId": ..., "containerId": ...}` once the service is
up, `500` with `{"deploymentId": ..., "error": ...}` when the deploy failed,
`400` for a malformed tag or a tag on a git-built service. The body is optional:
an empty POST redeploys the current tag. See [API & CLI](api-and-cli.md) for the
rest of the API.

## Previews from CI

An image-based service can have
[pull request previews](pull-request-previews.md) too: tick **Enable pull
request previews** in its **Environments & Deployments → Previews**, then have
the pipeline push an image for the pull request and run
`homerun previews deploy`. The first run creates `<slug>-pr-<number>` with the
service's preview settings, every later one switches it to the new tag and
redeploys it, and the command waits until the preview is healthy, prints its
URL, and exits non-zero when the deploy fails. Homerun can't delete the preview
when the pull request closes, so the workflow does that too.

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

concurrency:
  group: preview-${{ github.event.pull_request.number }}

jobs:
  deploy:
    if: >-
      github.event.action != 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    env:
      IMAGE: ghcr.io/you/app
      PR: ${{ github.event.pull_request.number }}
      SHA: ${{ github.event.pull_request.head.sha }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.pull_request.head.sha }}
      - name: Build and push the pull request's image
        env:
          REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          echo "$REGISTRY_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
          docker build -t "$IMAGE:pr-$PR-$SHA" .
          docker push "$IMAGE:pr-$PR-$SHA"
      - name: Deploy the preview and wait for it
        uses: orochibraru/homerun/actions/preview@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          command: deploy
          service: ${{ vars.HOMERUN_SERVICE_ID }}
          tag:
            pr-${{ github.event.pull_request.number }}-${{
            github.event.pull_request.head.sha }}
          timeout: 20m

  delete:
    if: >-
      github.event.action == 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name: Delete the preview
        uses: orochibraru/homerun/actions/preview@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          command: delete
          service: ${{ vars.HOMERUN_SERVICE_ID }}
```

- `IMAGE` is the service's own image: the preview runs it at the tag the job
  pushed, with the service's registry credentials.
- The job builds the pull request's head commit (`head.sha`, not the merge
  commit GitHub checks out by default), which the preview action records as the
  preview's commit, so a later `wait` or `promote` (which default to the same
  commit) matches it.
- Pull requests from forks are skipped: Homerun can't tell where an image came
  from, and a fork's code would run with the service's env vars. GitHub doesn't
  hand a fork's workflow the secrets anyway.
- The preview action reads the branch and title from the event itself and passes
  them through its own `env:`, never into a shell line, since both are typed by
  whoever opened the pull request.
- A branch the service's preview branch filter leaves out fails the deploy step
  with the reason, and `previews delete` fails when the pull request never had a
  preview. Leave such branches out in both jobs' `if:` to skip them instead.
- The action's tag picks the CLI release: keep it matching your instance.
  `previews deploy` needs a release that has it, on both the CLI and the
  instance.

Without the CLI, the deploy is `PUT /api/v1/services/<id>/previews/<pr>` with
`{"tag": ..., "commit": ..., "branch": ..., "title": ...}`, answered `202` with
the preview and its `deploymentId` once the deploy is queued; poll
`GET /api/v1/services/<id>/previews/<pr>` for the rest, see
[API & CLI](api-and-cli.md#previews).
