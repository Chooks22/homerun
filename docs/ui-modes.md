# Simple and advanced modes

The dashboard runs in one of two modes.

- **Simple** is for self-hosting a homelab through click-ops: a short sidebar,
  templates and one-click deploys up front, sensible defaults, and the
  engineering settings out of the way.
- **Advanced** shows the full feature set for engineering work: environments,
  release channels, pull request previews, revisions, infrastructure as code,
  object storage, build servers, the registry and observability in depth.

A mode only changes what's in view. A feature simple mode hides keeps working:
services that use it keep using it, scheduled jobs still run, and its page still
opens from a link or by typing its address. Landing on a hidden page keeps its
sidebar entry, tab or section highlighted, so you can see where you are.

## Picking a mode

- **For the instance**: the onboarding wizard asks "How will you use Homerun?"
  on its first step, **Homelab, click-ops** (simple) or **Engineering work**
  (advanced), and makes that the instance default. An admin changes it later
  under **Settings → General → Interface mode**. An instance that never picked
  one, including every instance set up before modes existed, is in advanced
  mode.
- **For your account**: **Profile → Appearance → Interface** picks **Simple**,
  **Advanced** or **Follow the instance default** (the default). The profile
  menu in the top right has a **Switch to simple mode** or **Switch to advanced
  mode** shortcut that saves the same choice in one click.

Your own choice wins over the instance default. Read-only accounts can switch
too: the mode is a personal preference, not a change to the instance.

## What simple mode hides

### Sidebar

Simple mode keeps **Overview**, **Services**, **Monitoring**, **Stacks**,
**Templates**, **Cron Jobs**, **Status Page**, **Volumes**, **Backups**,
**Backup Destinations**, **Redirects**, **Git Providers**, **Notification
Channels**, **DNS**, **Users**, **Authentication** and **Settings** (the last
four for admins, as in advanced mode).

It hides **Deployments** (the instance-wide history), **Remote Hosts**,
**Scheduling**, **Terminal**, **Build Cache**, **Object Storage**,
**Infrastructure as Code**, **IDP**, **API Docs**, **System Logs**, **Docker
Registry** and **Docker Cleanup**. **Monitoring** stays with its traffic, uptime
and host charts; its **Traces**, **CrowdSec** and **Settings** tabs are hidden.

### A service's tabs

Every tab stays. Inside them, simple mode hides:

- **Environments & Deployments**: the **Environments** list, **Revisions**,
  **Previews** and **Channels**. The tab opens on **Source**, and **Environment
  Variables** stays. On a git service, the build method, build cache and build
  server sit behind a collapsed **Advanced** section on **Source**.
- **Overview**: gains a **Roll back to the previous version** button once the
  service has an earlier revision to go back to, in place of the Revisions list.
- **Observability**: **Errors** (error tracking) and **Traces**. **Monitoring**,
  **Events** and **Health** stay, and Health only shows the current healthcheck,
  not the override settings.
- **Networking**: the network mode sits behind a collapsed **Advanced** section,
  and **Response cache** and **Published ports** are hidden.
- **Container**: **Runtime** (entrypoint, command, labels, capabilities,
  devices…). On a swarm instance, **Replicas** sits behind a collapsed
  **Advanced** section on **Compute**.
- **Security**: **Blocked paths** and the login wall's path rules. The login
  wall itself and image scanning stay.

A setting simple mode tucks away still shows when a service already uses it:
blocked paths that are set, a response cache, published ports, healthcheck
overrides, host network mode or more than one replica.

### Settings

Simple mode keeps **General**, **Networking**, **Email** and **Migrate**, and
hides **Docker**, **TLS**, **Error pages** and **IP bans**. A hidden tab comes
back when a setup issue points at one of its fields.

### Creating a service

The wizard keeps all its steps, with the essentials first and the rest behind a
collapsed **Advanced** section: the build method and cache for a git repo, the
network mode and protocol, and on the **Compute** step the restart policy and
CPU and memory limits, summarized above the section so you can see the defaults
you're getting.

## The Overview in simple mode

Simple mode puts a **Deploy an app** strip above the service counts: a handful
of popular templates (Jellyfin, Immich, Vaultwarden, Home Assistant, Nextcloud,
Paperless-ngx, AdGuard Home, Uptime Kuma), each with a **Quick Deploy** button
that creates and deploys it with no further input, plus links to every template
and to deploying any Docker image. Read-only accounts don't get the strip.
Everything else on the [dashboard](dashboard.md) stays as in advanced mode.
