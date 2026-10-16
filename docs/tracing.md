# Tracing

Advanced mode: [simple mode](ui-modes.md) hides the Traces section of a
service's Observability tab and the Traces tab of Monitoring. Everything here
keeps working either way, and a hidden page still opens from a link.

Homerun can collect OpenTelemetry traces from your services and show each one as
a waterfall: every span of a request, nested under the span that called it, with
how long it took and whether it failed. It runs its own OpenTelemetry collector,
so any OpenTelemetry SDK works unchanged, and it records traces of its own
background jobs too.

## The collector

The collector is on by default: Homerun runs it as one of its own containers,
`homerun-otel`, on the Homerun network. An admin turns it off under **Monitoring
→ Settings**, with **Run the OpenTelemetry collector**. It listens on:

- OTLP over HTTP at `http://homerun-otel:4318`
- OTLP over gRPC at `homerun-otel:4317`

It's only reachable from containers on the Homerun network: it's never published
on a host port or routed through Traefik. It batches what it receives and hands
it to the dashboard, which stores it. Turning it off removes the container; the
traces already stored stay until they expire.

The same page sets how long traces are kept, **7 days** by default, between 1
and 90. Spans older than that are deleted every hour, for services and Homerun's
own alike.

## Tracing a service

Open a service's **Observability → Traces** section, tick **Collect traces** and
save, then redeploy. On that deploy Homerun adds the standard OpenTelemetry SDK
variables to the service's environment:

| Variable                      | Value                                   |
| ----------------------------- | --------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://homerun-otel:4318`              |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf`                         |
| `OTEL_SERVICE_NAME`           | the service's slug                      |
| `OTEL_TRACES_EXPORTER`        | `otlp`                                  |
| `OTEL_RESOURCE_ATTRIBUTES`    | `homerun.service.id=<the service's id>` |

A variable you set yourself always wins, except `OTEL_RESOURCE_ATTRIBUTES`:
Homerun adds `homerun.service.id` to whatever you put there. Turning traces off
stops the injection on the next deploy.

Your app still needs an OpenTelemetry SDK that reads these variables, which is
how the official ones behave (Node's auto-instrumentation, Python's
`opentelemetry-instrument`, Java's agent, the .NET and Go SDKs set up with their
environment defaults).

Homerun files incoming spans under a service by their `homerun.service.id`
resource attribute, else by a `service.name` matching a service's slug, and only
while that service has traces turned on. Spans from anything else are accepted
by the collector and dropped.

A service's CI runs are the exception: when [Pipelines](pipelines.md) are on,
each finished run is filed under the service as a trace whether or not its own
traces are.

## The trace list

The **Traces** section lists the service's traces, newest first: the root span's
name, how long the whole trace took, how many spans it has, whether any of them
failed, and when it started. Search matches any span name or a trace id; tick
**Errors only** to keep traces with a failed span, and sort by newest, slowest
or most spans.

## A trace

Click a trace to open its waterfall. Each row is a span, indented under its
parent, with a bar placed at its start and as wide as its duration on the
trace's timeline: red for a failed span, green for one that reported success,
the accent color for one that set no status. A trace that crossed more than one
service shows the spans of each. Click a span to read its kind, status,
attributes and events (an exception recorded on a span shows up as an
`exception` event), and the resource it came from.

## From an error to its trace

When an [error tracking](error-tracking.md) event carries a trace id (Sentry
SDKs set one in the event's trace context) and Homerun has that trace, the
event's page shows a **View trace** button that opens it.

## Homerun's own traces

Every job Homerun's worker runs (deploys and builds, image scans, backups and
restores, cron jobs, Docker cleanups) is a trace of its own, under **Monitoring
→ Traces**. The job's span carries its type, id, attempt and outcome, with a
child span for its execution and for recording the outcome, and inside the
execution a span per stage: the image pull, build or rollback image, the scan,
starting the container or swarm service, the backup or restore, and a cron job's
container run with its exit code (a non-zero exit or a timeout marks it failed).
A failed job's trace shows which stage broke, with the error recorded on it, and
how long each stage took.

These traces are written straight to the database by the worker, so they're
recorded with or without the collector running. A build server's agent records
none.

A job's page under **Scheduling** shows its trace too, one per attempt, as the
same waterfall, with a link to the full trace, and so does each cron job run's
**Traces** tab (see [Scheduling](scheduling.md#cron-jobs)).
