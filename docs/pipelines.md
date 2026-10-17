# Pipelines

**Pipelines**, under **Observability** in the sidebar, brings the CI runs of the
repositories you choose into Homerun: GitHub Actions workflow runs, GitLab CI
pipelines and Gitea Actions runs (Gitea 1.24 or later, the first version with an
Actions API). Each run lands with its jobs, timings and an estimated cost, the
pages add them up, and every finished run becomes a [trace](tracing.md) you can
open as a waterfall. Bitbucket Pipelines isn't supported.

A watched repository can be linked to any service, built from it or not: the
service then shows the repository's runs under its own **Observability →
Pipelines**, and [error tracking](error-tracking.md#back-to-the-source) links
its stack frames to that repository's source.

## Watching repositories

Open **Pipelines** and click **Watch repositories**, pick one of your connected
[git providers](git-providers.md), filter its repositories and tick as many as
you want, then click **Watch**. Repositories already watched are marked and
can't be ticked again; come back to this page any time to add more. Homerun
reads their runs with your connection, so you need a GitHub, GitLab or Gitea
provider connected first. Services already building from a repository are linked
to it right away, and each repository's first sync is queued.

From then on it's synced every five minutes. Each sync reads the latest 50 runs
and fetches the jobs of every run that's new, still running, or was re-run since
the last one, so a quiet repository costs one API call per sync. **Sync now** on
a repository's page, or **Sync all now** on the Pipelines page, queues a sync as
a background job on the [job queue](scheduling.md); the toast's **View task**
opens its log.

When a sync fails (a revoked token, a repository the connection can't see, an
older Gitea, a provider that was removed), the repository's page and the
Pipelines list show why, and the next sync tries again.

## The Pipelines page

Over the last 30 days, across every watched repository: how many runs, the share
that passed (of the runs that passed or failed; cancelled and skipped runs don't
count), the median duration and the duration only one run in twenty exceeds
(p95), the mean time a run waited before its first job started, billable minutes
and cost, plus the cost of every stored run. Below it, each repository with the
services linked to it, its own 30-day numbers and when it last synced, then
every run of every repository, newest first: repository, workflow and run
number, commit title, branch, commit and trigger, status, duration, time queued,
job count and cost. Search matches the repository, workflow, branch, commit
title or SHA; filter by status, and sort by newest, slowest, most expensive or
workflow. Each run opens its own page (see below) and links to its page on the
provider.

A repository's own page has the same numbers for it alone, broken down per
workflow, and its runs.

## A run

Click a run to open its page: its branch, commit, trigger, who started it, how
long it queued and ran, its attempt, billable minutes and cost; every job of
every attempt with its runner, duration, minutes and cost (earlier attempts
dimmed); and the run's trace as a waterfall, the run on top, its jobs under it
and each job's steps under the job. The trace appears once the run has finished
and been synced, and goes once it's older than the trace retention.

## Settings and linked services

A repository's **Settings** tab:

- **Sync CI runs** turns the five-minute sync on or off. **Sync now** works
  either way, and turning it off keeps the stored runs.
- **Runner rates** set what its runs cost, see below.
- **Linked services** ticks the services that use this repository. A service
  links to one repository at a time: ticking it here moves it from any other.
- **Stop watching**, in the danger zone, deletes the stored runs and drops the
  link to the services. Traces already exported stay until they expire.

## Cost

A job costs its run time rounded up to whole minutes, the way GitHub bills,
times the per-minute rate of its runner. The rate is the first line of **Runner
rates** whose label starts one of the job's runner labels (or its runner name),
in order; a job no line matches costs nothing:

```text
self-hosted = 0
ubuntu = 0.006
windows = 0.01
macos = 0.062
```

That's also the default for a GitHub repository, matching GitHub's hosted runner
prices; GitLab and Gitea default to no rates, since their runners are usually
your own. Order matters: GitHub labels a self-hosted Linux runner
`self-hosted, linux, x64`, so `self-hosted` comes first. Put a more specific
line, such as `ubuntu-latest-8-cores = 0.022`, above a general one. Saving new
rates re-costs every stored run. The numbers are an estimate, not your bill:
included free minutes and plan discounts aren't taken into account. A re-run
keeps the minutes of every attempt in the cost; its durations, queue time and
trace are the latest attempt's, counted from when that attempt started.

## Traces

Each finished run is exported as a trace: a root span from the moment the run
was queued to its end, a span per job that ran, and on GitHub and Gitea a span
per step. GitLab reports no steps, so its jobs carry their stage as an attribute
instead. Spans use the OpenTelemetry CI/CD attribute names
(`cicd.pipeline.name`, `cicd.pipeline.task.name`, `vcs.ref.head.revision`…) plus
each span's billable minutes and cost, and their service name is
`github-actions`, `gitlab-ci` or `gitea-actions`.

They go through Homerun's OpenTelemetry collector, like a service's own spans,
and are stored directly when the collector is off. Each run's page shows its
trace; the same trace is also listed under the **Traces** of the first service
linked to the repository, even when that service's own traces are turned off, or
under **Monitoring → Traces** when no service is linked. They expire with the
[trace retention](tracing.md#the-collector) while the runs themselves stay on
the Pipelines pages.
