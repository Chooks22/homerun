# Pipelines

Advanced mode: [simple mode](ui-modes.md) hides the Pipelines section of a
service's Observability tab. Syncing keeps running either way.

A service built from a git repo can pull its repo's CI runs into Homerun: GitHub
Actions workflow runs, GitLab CI pipelines and Gitea Actions runs (Gitea 1.24 or
later, the first version with an Actions API). Each run lands with its jobs,
timings and an estimated cost, the Pipelines section adds them up, and every
finished run becomes a [trace](tracing.md) you can open as a waterfall.
Bitbucket Pipelines isn't supported.

## Turning it on

Open the service's **Observability → Pipelines** section, tick **Sync CI runs**
and save. Homerun reads the runs with the service owner's
[git provider](git-providers.md) connection, the same one it clones and checks
[status checks](status-checks.md) with, or a token embedded in the git URL. The
first sync starts right away, then every five minutes; **Sync now** runs one on
demand. Each sync reads the latest 50 runs and fetches the jobs of every run
that's new, still running, or was re-run since the last one, so a quiet repo
costs one API call per sync.

When a sync fails (a revoked token, a repo the connection can't see, an older
Gitea), the section shows why, and the next sync tries again.

Turning syncing off stops it and keeps every stored run, so the totals stay.

## What the section shows

Over the last 30 days: how many runs, the share that passed (of the runs that
passed or failed; cancelled and skipped runs don't count), the median duration
and the duration only one run in twenty exceeds (p95), the mean time a run
waited before its first job started, billable minutes and cost, plus the cost of
every stored run. A table breaks the same numbers down per workflow.

Below it, every run, newest first: workflow and run number, commit title,
branch, commit and trigger, status, duration, time queued, job count and cost.
Search matches the workflow, branch, commit title or SHA; filter by status, and
sort by newest, slowest, most expensive or workflow. Each run links to its page
on the provider and, once it has finished, to its trace.

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

That's also the default for a GitHub repo, matching GitHub's hosted runner
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
and are stored directly when the collector is off. They show up under the
service's **Traces** even when its own traces are turned off, and expire with
the [trace retention](tracing.md#the-collector) while the runs themselves stay
in the Pipelines section.
