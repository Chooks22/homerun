# Test every pull request in its own environment with GitHub Actions

A cookbook: every pull request gets a real deployment of its own (a
[pull request preview](pull-request-previews.md)), GitHub Actions runs your
end-to-end suite against it, and shipping the pull request deploys **the exact
image that passed** to production instead of rebuilding it. Three workflows:

1. **Preview E2E**, on every push to a pull request: Homerun's webhook builds
   the preview, the workflow waits until the preview runs that push's commit and
   is healthy, then runs Playwright against its URL. This is the required check.
2. **Ship**, when you add the `ship` label: checks the pull request can merge,
   promotes its preview's image to the service (`homerun previews promote`),
   then merges it.
3. **Preview cleanup**, when a pull request closes: deletes the preview if it's
   still there.

## Why ship promotes before it merges

Homerun deletes a preview the moment the pull request's close (or merge) webhook
arrives, and the preview's revisions go with it. That happens seconds after the
merge, well before a runner picks up a workflow triggered by the merge. A
"promote on merge to main" workflow therefore finds nothing left to promote.
Ship therefore promotes first and merges right after, in one job, and rolls
production back if the merge fails.

What makes the promoted image _be_ main: branch protection requires the pull
request to be **up to date with main** before merging, so the tree of its head
commit is exactly the tree main gets. The image built from that head is main's
image.

## Homerun settings

- The service builds from git, and **Enable pull request previews** is ticked
  under its **Environments & Deployments → Previews**.
- **Deploy on push is off** under its **Environments & Deployments → Source**.
  With it on, the push to main from the merge would rebuild and redeploy the
  service right after ship promoted the tested image, replacing it with a fresh
  build of the same commit: a second deploy, and not the artifact you tested.
  Previews don't need it: turning previews on registers the webhook for pull
  request events by itself.
- The webhook has to reach Homerun: the **Dashboard URL** under Settings →
  General is reachable from GitHub. Polling doesn't cover pull requests.
- Anything your suite needs from the preview (env vars, a login wall) is set on
  the service: previews copy its build settings, env vars, resources,
  healthcheck and login wall. A login wall in front of the preview stops your
  tests too: see
  [Previews behind the login wall](#previews-behind-the-login-wall).
- An API key with write access to **Services** from your profile's
  [API keys](your-profile.md#api-keys). Promote and delete write; a key that
  only reads gets a `403`. Mind its expiry, or the workflow starts failing the
  day it lapses.

## GitHub settings

- **Secret** `HOMERUN_API_KEY`: the API key. **Variables** `HOMERUN_BASE_URL`
  (your instance, e.g. `https://homerun.example.com`) and `HOMERUN_SERVICE_ID`
  (the service's id, the last part of its dashboard URL, or
  `homerun services list`).
- **Branch protection** (or a ruleset) on `main`:
  - **Require status checks to pass**, with the `e2e` check from Preview E2E.
  - **Require branches to be up to date before merging**. Without it, a pull
    request that's behind main ships an image missing main's newer commits.
  - Required reviews, if you want them: ship refuses to merge until they're in.
- A **`ship`** label in the repository.
- **Settings → Actions → General → Workflow permissions** lets workflows ask for
  write access (ship asks for `contents: write` and `pull-requests: write` to
  merge). The merge goes through the same branch protection as a person's.

Pull requests from forks are never previewed, and their workflows don't get your
secrets anyway, so all three workflows skip them.

The workflows use Homerun's [GitHub Actions](ci-cd.md#github-actions), pinned to
a release tag: use the same version as your instance. The preview action's pull
request number and commit default to the pull request that triggered the run.

## Preview E2E

The preview action's `wait` (`homerun previews wait`) blocks until the preview
exists, runs the pull request's head commit and its health check passed, then
hands back the preview's URL as its `url` output. It exits non-zero when the
deploy fails, the revision is judged unhealthy, or the timeout passes. A new
push cancels the run for the older one.

```yaml
name: Preview E2E

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: preview-e2e-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  e2e:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@v7.0.0
        with:
          node-version: 24
          cache: npm
      - name: Wait for the preview of this commit
        id: preview
        uses: orochibraru/homerun/actions/preview@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          command: wait
          service: ${{ vars.HOMERUN_SERVICE_ID }}
          timeout: 20m
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Run the E2E suite against the preview
        run: npx playwright test
        env:
          BASE_URL: ${{ steps.preview.outputs.url }}
      - uses: actions/upload-artifact@v7.0.1
        if: failure()
        with:
          name: playwright-report
          path: playwright-report/
```

The Playwright side only has to read the URL:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  retries: 1,
  use: { baseURL: process.env.BASE_URL, trace: "retain-on-failure" },
});
```

## Previews behind the login wall

Keep the previews' login wall on and let the suite through with a
[service account](login-wall.md): create one under Administration → Service
accounts, mint it a key, store the key as the secret `HOMERUN_E2E_KEY`, and tick
the account under **Users** in the service's preview access policy. Then add a
step between waiting for the preview and running the suite:

```yaml
- name: Sign the suite in through the login wall
  uses: orochibraru/homerun/actions/gate-session@v1.0.59
  with:
    base-url: ${{ vars.HOMERUN_BASE_URL }}
    api-key: ${{ secrets.HOMERUN_E2E_KEY }}
    url: ${{ steps.preview.outputs.url }}
    playwright-file: playwright/.auth/state.json
```

and point Playwright at the file:

```ts
use: {
  baseURL: process.env.BASE_URL,
  storageState: "playwright/.auth/state.json",
},
```

The service account's key only gets through walls that list it, nothing else,
and it's only ever sent to your Homerun instance, never to the preview. Its
cookie lasts eight hours, longer than any suite.

## Ship

Add the `ship` label to a green pull request. The job checks GitHub considers it
mergeable at the tested commit (required checks passed, up to date, reviews in),
promotes the preview's image to the service, pinned to that commit, waits for
the deploy, and merges with `--match-head-commit`, so a push that landed in
between stops it instead of shipping untested code. If the merge fails after the
promote, production is rolled back to its previous revision.

```yaml
name: Ship

on:
  pull_request:
    types: [labeled]

concurrency:
  group: ship
  cancel-in-progress: false

permissions:
  contents: write
  pull-requests: write

jobs:
  ship:
    if: >-
      github.event.label.name == 'ship' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 45
    env:
      GH_TOKEN: ${{ github.token }}
      GH_REPO: ${{ github.repository }}
      PR: ${{ github.event.pull_request.number }}
      SHA: ${{ github.event.pull_request.head.sha }}
    steps:
      - name: Check the pull request can merge at the tested commit
        run: |
          for _ in 1 2 3 4 5; do
            state=$(gh pr view "$PR" --json mergeStateStatus,headRefOid \
              --jq '.mergeStateStatus + " " + .headRefOid')
            case "$state" in
              "CLEAN $SHA" | "UNSTABLE $SHA" | "HAS_HOOKS $SHA") exit 0 ;;
              UNKNOWN*) sleep 5 ;;
              *) break ;;
            esac
          done
          echo "::error::#$PR can't merge at $SHA ($state)."
          exit 1
      - name: Promote the tested preview
        id: promote
        uses: orochibraru/homerun/actions/preview@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          command: promote
          service: ${{ vars.HOMERUN_SERVICE_ID }}
      - name: Merge
        run: gh pr merge "$PR" --squash --match-head-commit "$SHA"
      - name: Roll production back when the merge failed
        if: failure() && steps.promote.outcome == 'success'
        uses: orochibraru/homerun/actions/rollback@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          service: ${{ vars.HOMERUN_SERVICE_ID }}
      - name: Delete the preview, unless Homerun already did
        if: success()
        continue-on-error: true
        uses: orochibraru/homerun/actions/preview@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          command: delete
          service: ${{ vars.HOMERUN_SERVICE_ID }}
```

`UNSTABLE` is accepted because ship itself is a running, non-required check on
the pull request; `BLOCKED` (a required check or review missing) and `BEHIND`
(not up to date) are refused before anything is deployed.

The last step is there because a merge made with the workflow's own token
doesn't start other workflows: Preview cleanup below doesn't run for a pull
request ship merged.

## Preview cleanup

Homerun already deletes a preview when its pull request closes or merges, on the
close webhook. This is the belt-and-braces half, for a webhook that never
arrived:

```yaml
name: Preview cleanup

on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - name:
          Delete the preview, unless Homerun already did on the close webhook
        continue-on-error: true
        uses: orochibraru/homerun/actions/preview@v1.0.59
        with:
          base-url: ${{ vars.HOMERUN_BASE_URL }}
          api-key: ${{ secrets.HOMERUN_API_KEY }}
          command: delete
          service: ${{ vars.HOMERUN_SERVICE_ID }}
```

## How promote picks the image

`homerun previews promote` deploys the image of the revision the preview runs
now, the way a [rollback](revisions-and-rollback.md) redeploys one: nothing is
built, pulled from upstream or scanned: the image the preview built is looked up
on the host, or pulled back by digest when the build pushed it to a build cache
registry. The service keeps its own env vars, domains, volumes and resources:
only the image comes from the preview. The deployment's log opens with
`Promoted from the preview of #<n> (<preview>, revision <id>, commit <sha>)`,
and the deployment history lists it under the **Promote** trigger. It's a new
revision of the service like any deploy, so its health is watched and
auto-rollback applies to it. `--commit` refuses (`409`) when the preview runs
anything else, and promote also refuses a preview whose health check is still
running or failed.

## When it goes wrong

- **Wait times out.** The build took longer than `--timeout`, or the webhook
  never reached Homerun: check the preview shows up in the service's Previews
  section, and the recent deliveries of the webhook in the repository settings.
  A service with previews off fails straight away instead of waiting.
- **Wait fails with the deploy's error.** The preview's build or deploy failed;
  the preview's own **Environments & Deployments → Revisions** has the full log.
- **Wait fails with "unhealthy".** The preview started but its health check or
  readiness probe failed, with the reason. Previews run with the service's env
  vars: a database URL pointing at production is a bug here, not in Homerun.
- **E2E fails.** The required check is red, so ship's mergeability check refuses
  and nothing is deployed. Push a fix: the preview redeploys and E2E reruns.
- **A push lands between the tests and ship.** `--commit` makes promote refuse,
  and `--match-head-commit` makes the merge refuse; the new push runs E2E again.
- **Promote fails.** Production keeps running what it ran. The usual cause is
  the preview's image being gone from the host (pruned by
  [Docker Cleanup](docker-cleanup.md)): push to the pull request to rebuild it.
- **Production is unhealthy after ship.** With
  [auto-rollback](revisions-and-rollback.md) on, Homerun rolls the service back
  to its previous revision by itself; without it,
  `homerun services rollback <id>` does.
- **The pull request closed before ship.** The preview is gone and promote
  answers `404`: reopen the pull request to rebuild it, or deploy the service
  from main.
