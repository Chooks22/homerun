# Services

A **service** is one deployed container. Create one from
`Services → Deploy a Service`, either standalone or pre-filled from a
[stack](stacks.md) or [template](templates.md) via `?stackId=`/`?templateId=`.
The wizard's primary button, **Create and Deploy**, persists the config and
immediately deploys it, landing you on the new service's Overview tab; **Create
service**, the secondary button, just persists the config, the same as before,
deploy later from the Overview tab yourself.

![The Deploy a Service wizard](images/deploy.webp)

## Detected from the image, Dockerfile or manifest

As soon as you type an image (or pick a repository to build), the wizard reads
what it declares and shows it under the source fields: exposed ports, volumes,
environment variables, healthcheck, user, working directory, entrypoint and
command.

- **An image**: its config, read from the registry without pulling any layers,
  or from this machine when the registry can't be reached.
- **A git repository**: its [Homerun Manifest](manifest.md) (`.homerun.json`,
  `.homerun.yaml` or `.homerun.yml`, looked up next to the build context first,
  then at the root, the same way a deploy does) laid over its Dockerfile. **The
  manifest wins** for the port, protocol, environment, healthcheck, user,
  command and entrypoint it sets, and its build method, context and Dockerfile
  path decide which Dockerfile is read (none, for a build method other than a
  Dockerfile). Its other keys are listed as applied on deploy. A manifest that
  doesn't validate shows its problems, since every deploy would fail on them.
  The Dockerfile is its final stage, plus whatever it inherits from earlier
  stages, with `ARG`/`ENV` defaults expanded; a stage built from an external
  base image only reports what the Dockerfile adds. The repository is read the
  same way a deploy reads it, so a public one works without a connected git
  provider.

What it fills in for you:

- **Container port**: the manifest's `containerPort`, else the first exposed TCP
  port (UDP when that's all there is), unless you, a template or a previous
  submit already set one.
- **Volumes**: one new named volume per declared `VOLUME` path not already in
  the list. Change the source or the path and it stays yours; switch to another
  image and the untouched ones are swapped out.
- **Environment variables**: an **Import from** link in the Environment step
  adds the declared variables as editable rows, skipping the base-image plumbing
  (`PATH`, `HOME`, `LANG`, `*_VERSION`, and so on). It's a button, not
  automatic, because an imported value becomes an override that no longer
  follows the image when it changes.

Healthcheck, user, working directory, entrypoint and command are shown for
reference only: the container already gets them from the image, and a manifest's
are applied on every deploy, so there's nothing to copy. Override them on the
service's tabs after it's created.

## The services list

![The services list, grouped by stack](images/services.webp)

`Services` has a search box (matches name, image, and domain) plus Status/ Stack
filters, a sort (newest, oldest, name either way, recently updated; it's in the
URL, so a sorted view can be bookmarked), and a list/card view toggle that
remembers your choice per browser; both the search and filters are applied on
the server, so they reach every service on the instance, not just whichever page
happens to be on screen. Once you have more than a page's worth, a pager at the
bottom shows "26–50 of 60" and lets you step through the rest. Check one or more
services (a "select all" scopes to whatever's on the **current page**,
paginating or changing the search/filters clears your selection) to bring up a
bottom bar with bulk Start/Stop/Restart/Delete: bulk actions run against every
selected service and report back which ones succeeded, so one service with no
container yet doesn't block the rest. Bulk delete, and the single-row delete on
this page and the danger-zone delete on a service's own Settings tab, all
require typing a confirmation phrase (the service's name for a single delete,
`delete N services` for a bulk one) before the button unlocks, an irreversible
action gets a real "are you sure" rather than a single click. A delete removes
the container or swarm service first: one that's already gone is fine, but if
Docker fails to remove it, the service is kept and the error says why. The
Settings tab's delete then offers **Delete anyway**, which removes only
Homerun's record (the REST API's equivalent is
`DELETE /api/v1/services/:id?force=true`). A service with a deploy (or any other
job) still queued or running, for itself or one of its previews, environments or
canary, isn't deleted either: the Settings tab's delete dialog lists those jobs
and its button becomes **Force delete**, which cancels them first. Deleting a
preview or an environment on its own cancels its jobs without asking.

The list groups services by stack, ordered as a tree (a substack's group is
indented under its parent's), with services outside any stack last. A
**Dependencies** button next to the toolbar swaps the whole list for the same
dependency tree a [stack page](stacks.md#the-services-tabs-dependency-graph)
shows, but across every service on the instance rather than one stack, since a
dependency tree needs the whole unpaged set to draw correctly and can't be
combined with the list's own paging.

## Settings

![A service's Settings tab with its name, slug, pull policy, restart policy and environment](images/services-settings.webp)

Name, slug, restart policy, which stack the service belongs to, the
[scheduled redeploy](scheduling.md#scheduled-redeploy), the pull policy, whether
its image is [scanned](image-scanning.md),
[auto-rollback](revisions-and-rollback.md), and a danger-zone delete
(typed-confirm, see [The services list](#the-services-list)).

**Pull policy** decides whether a deploy pulls the image: **Always** (the
default, and the only way a moving tag like `:latest` picks up a new build),
**If missing** (only when the image isn't on the host yet, faster redeploys but
a moving tag goes stale), or **Never** (for an image built or loaded onto the
host by hand, the deploy fails if it isn't there).

**Save as template** is here too: it snapshots this service's current image,
tag, port, env vars, resource limits, healthcheck and
[runtime options](runtime-and-compute.md#runtime) into a reusable template of
your own, which then behaves exactly like a built-in one, including being
linkable as a companion to another template. See [Templates](templates.md).

## Health

![Observability → Health, showing the healthcheck the running container was created with](images/services-health.webp)

**Observability → Health** shows the healthcheck the running container was
actually created with: whether it's the service's own command, the image's
`HEALTHCHECK`, Homerun's generated port check or none, the command itself, its
interval, timeout, retries and start period, its live status and the last few
probes' exit codes and output. A swarm service's tasks aren't shown there.

Below it, the service's own settings, each taking effect on the next deploy:

- **Command** overrides the image's own Docker healthcheck with a shell command
  run inside the container (exit 0 = healthy). When a service has one, its
  uptime probe reports the healthcheck instead of knocking on the container
  port, which is what a portless container needs. It is also the service's
  [readiness check](deploying.md): a new container or swarm task gets no traffic
  until it passes.
- **Interval**, **Timeout**, **Retries** and **Start period** override the
  defaults (30s, 10s, 3 and 30s). Interval, timeout and retries also apply to
  Homerun's generated port check.
- **Turn off healthchecks** removes every check: the image's own is overridden
  with none, Homerun adds no port check, and the
  [post-deploy health watch](revisions-and-rollback.md) doesn't wait for an HTTP
  answer. For a background worker that doesn't listen on anything.

## Everything else a service does

Each part of a service has its own page:

- [Deploy source and build methods](deploy-source-and-builds.md)
- [Deploy on push](deploy-on-push.md),
  [pull request previews](pull-request-previews.md) and
  [required status checks](status-checks.md)
- [Deploying](deploying.md) and
  [revisions and rollback](revisions-and-rollback.md)
- [Image scanning](image-scanning.md)
- [Env vars](env-vars.md) and [storage volumes](storage-volumes.md)
- [Networking](networking.md), [DNS automation](dns-automation.md) and the
  [per-app login wall](login-wall.md)
- [Runtime and compute](runtime-and-compute.md) and [swarm mode](swarm-mode.md)
- [Observability](observability.md): monitoring, uptime, logs, errors and the
  terminal
- [Scheduling and the job queue](scheduling.md)
