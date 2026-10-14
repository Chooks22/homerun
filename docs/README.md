# Homerun docs

Homerun is a self-hosted, single-user PaaS: point at a Docker image or a git
repo, fill in a form, deploy: Traefik routes it to `<slug>.yourdomain.com` with
TLS. Single host, local Docker socket, no multi-node orchestration.

This directory is plain Markdown, the source of truth: read it straight from the
repo, or on your GitHub remote's file browser. The
[website](https://homerun.orochibraru.com) renders these same files from its own
separate repository; it's a companion renderer, not a second copy to keep in
sync by hand.

**[Showcase](showcase.md)**: what it looks like, every screen, light and dark.

## Getting started

- **[Getting started](getting-started.md)**: install (the one-liner or Docker
  Compose), first boot, the onboarding wizard, and deploying your first service.
- **[Configuration](configuration.md)**: what you set in the dashboard (almost
  everything), the three values the container needs before it can start, and the
  optional YAML file for config-as-code setups.
- **[Simple and advanced modes](ui-modes.md)**: a short, click-ops dashboard for
  a homelab or the full feature set for engineering work, per instance or per
  account, and exactly what simple mode hides.
- **[FAQ & limitations](faq-and-limitations.md)**: what's genuinely finished,
  what's a known gap, and what's on the roadmap.
- **[Architecture](architecture.md)**: every component (app, worker, Traefik,
  Postgres, Docker, build servers, external services) and who talks to whom,
  over what, and why, as a generated diagram and table.

## Services

- **[Services](services.md)**: creating a service, the services list, bulk
  actions, and the Settings tab (pull policy, healthcheck, save as template).
- **[Deploy source and build methods](deploy-source-and-builds.md)**: image or
  git repo, the six build methods, build servers and the build cache registry.
- **[Homerun Manifest](manifest.md)**: a service's configuration as
  `.homerun.json` (or YAML) in its repository, applied on every deploy, or
  applied to any service with the CLI; its published JSON schema.
- **[Connecting a git provider](git-providers.md)**: GitHub, GitLab, Gitea or
  Bitbucket OAuth apps, and browsing your repos from a service's Environments &
  Deployments → Source section.
- **[Deploy on push](deploy-on-push.md)**: webhooks registered for you, manual
  webhooks, and polling the branch when the provider can't reach you.
- **[Deploying from CI](ci-cd.md)**: the GitHub Action, the CLI image for GitLab
  and other CIs, and the raw API call, deploying the tag your pipeline just
  pushed.
- **[Pull request previews](pull-request-previews.md)**: a service per pull
  request, and why forks are never previewed.
- **[Environments](environments.md)**: staging, demo or any other deployment of
  a service under its own name, and reporting deploys to GitHub.
- **[Release channels](release-channels.md)**: a managed canary service fed by a
  branch, and the service itself deployed from matching tags.
- **[Main is canary, tags are stable](main-canary-tags-stable.md)**: a cookbook
  for that release model, with a GitHub Actions release workflow, rollback and
  pull request previews.
- **[Testing pull requests with GitHub Actions](github-actions-preview-testing.md)**:
  E2E tests against each pull request's preview, then shipping the exact image
  that passed.
- **[Required status checks](status-checks.md)**: holding a build until CI
  passes on the exact commit.
- **[Importing a compose file](compose-import.md)**: what maps across from a
  `docker-compose.yaml`, and what comes back as a warning.
- **[Migrating from Dokploy or Coolify](migrating-from-dokploy-or-coolify.md)**:
  reading another instance and recreating its apps, stacks and databases here.
- **[Deploying](deploying.md)**: the live progress panel, health-gated
  redeploys, readiness checks and retried requests.
- **[Revisions and rollback](revisions-and-rollback.md)**: every deploy as a
  revision, rolling back, retained images and auto-rollback, and the
  instance-wide deployment history.
- **[Image scanning](image-scanning.md)**: Trivy scans through the registry
  mirror, the Security tab, and blocking deploys on findings.
- **[Env vars](env-vars.md)**: key/value rows, linking a service to fill in
  connection details, and env files on the host.
- **[Networking](networking.md)**: container port, network mode,
  DNS-resolvability, extra domains and your own SSL certificates.
- **[Redirects](redirects.md)**: send a hostname or path to another URL, served
  by Traefik with no container.
- **[Error pages](error-pages.md)**: the branded pages shown while an app is
  still deploying, down, or on an address nothing uses, and how to brand them as
  your own.
- **[DNS automation](dns-automation.md)**: your domains and their records at 16
  DNS providers (Cloudflare, Route 53, Google, Azure, Hetzner, Namecheap…), kept
  in sync with your services, or Pangolin resources.
- **[Runtime and compute](runtime-and-compute.md)**: entrypoint, command,
  labels, run-as user, capabilities, devices, privileged mode, and CPU/memory
  limits.
- **[Swarm mode](swarm-mode.md)**: replicas, what swarm mode changes, and adding
  a node.
- **[Observability](observability.md)**: per-service monitoring (requests,
  response time, errors, uptime, CPU and memory from today to all time), uptime
  probes, live logs, failed deploys and errors, and the web terminal.
- **[Error tracking](error-tracking.md)**: Sentry-compatible error collection
  per service, issues, stack traces linked to the source, and alerts.
- **[Tracing](tracing.md)**: OpenTelemetry traces from your services through
  Homerun's own collector, trace waterfalls, and traces of Homerun's own jobs.
- **[Scheduling and the job queue](scheduling.md)**: scheduled redeploys, cron
  jobs, the Scheduling page, and the background job queue.

## Stacks, templates and storage

- **[Stacks](stacks.md)**: grouping services on a shared private network,
  nesting stacks, and the dependency tree/diagram.
- **[Templates](templates.md)**: the built-in app catalog, quick deploys, host
  access, linked companion containers, and saving your own.
- **[Storage volumes](storage-volumes.md)**: bind-mount and Docker-managed
  volumes, and mounting them into services.
- **[Volume backups](backups.md)**: reusable backup destinations (S3, SFTP, SMB,
  WebDAV), scheduled backups of either volume kind, the backup history, and
  restoring.
- **[Object storage](object-storage.md)**: the built-in S3 store, connecting
  S3-compatible providers, buckets, lifecycle and access keys.
- **[Build servers & the Homerun Agent](remote-hosts-and-agent.md)**: building
  images on a second machine, the standalone agent and installer.
- **[Workstations](workstations.md)**: dev boxes in the browser: an IDE with a
  persistent home and your repository cloned, on this server or an agent host.
- **[Machine terminals](machine-terminals.md)**: a browser shell on this server
  and every remote host over SSH, Homerun's key and host-key checking.

## Users and access

- **[Users and roles](users-and-roles.md)**: admin, developer, read-only and
  custom roles, creating and inviting accounts, and onboarding.
- **[Authentication providers](authentication-providers.md)**: OAuth/OIDC
  sign-in, emailed codes and links, preferred methods, sign-in requirements, and
  linking a provider to an existing account.
- **[Your profile](your-profile.md)**: personal information, sessions, API keys,
  appearance, and git provider accounts.
- **[Two-factor authentication and passkeys](two-factor-and-passkeys.md)**:
  authenticator codes, backup codes, and passkeys.
- **[Per-app login wall](login-wall.md)**: requiring a sign-in before anyone
  reaches a service, and who's allowed through.
- **[Blocked paths and IP bans](blocked-paths-and-ip-bans.md)**: turning away
  requests for `.env`, `.git` and other probed paths, and banning addresses that
  keep trying.
- **[Sign in with Homerun](sign-in-with-homerun.md)**: Homerun as an OIDC
  provider for the apps you host, and the OAuth clients AI agents sign in with.

## Operations and maintenance

- **[The dashboard](dashboard.md)**: service counts, host resources and history,
  `⌘K` search, and setup diagnostics.
- **[System Logs](system-logs.md)**: live logs of your instance's stack and
  Traefik, and restarting or updating Traefik.
- **[Docker Cleanup](docker-cleanup.md)**: previewing and pruning what Docker
  can reclaim, and the image mirror cleanup.
- **[Docker Registry](registry.md)**: turning the image mirror into a real
  private registry, push/pull tokens, and publishing it at a hostname.
- **[Notifications](notifications.md)**: the bell, and sending events to
  Discord, Slack, Telegram, a webhook, email or a browser through push, even
  with Homerun closed.
- **[Status pages](status-pages.md)**: private or public uptime pages.
- **[Upgrading Homerun](upgrading.md)**: the one-click update, and upgrading by
  hand.
- **[API & CLI](api-and-cli.md)**: the REST API, the live Swagger UI and the
  `homerun` CLI.
- **[MCP server for AI agents](mcp.md)**: connecting Claude or any MCP agent (by
  URL alone, a registered client, or an API key), what it can do, how secrets
  are kept from it, and revoking it.
- **[Infrastructure as code](infrastructure-as-code.md)**: the Terraform
  provider, Pulumi, generating a configuration from what's running, Terraform
  state with versions, diff, rollback and locking, and drift between a state and
  the instance.

## Something's out of date

This app moves fast and these docs are hand-written, not generated: if a page
disagrees with the running app, the app is right. Please open an issue (or a PR)
against whichever page is stale. [`../CLAUDE.md`](../CLAUDE.md) is the denser,
implementation-level counterpart to this directory, aimed at contributors rather
than operators.

## Running from source instead

Everything above is written for someone _operating_ an already-running instance.
If you want to check out the code, run a dev server, and change things, see
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) instead, none of the install paths in
Getting Started need Bun, `git`, or a source checkout.
