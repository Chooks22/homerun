<!-- vale off -->

# TODO

The backlog, and the only one. There is no priority ordering, pick whatever.
When done delete the entry, no bloat.

## Small

- [ ] `deleteDns` (`dns.service.ts`) never refuses the dashboard's own hostname
      or a core host (registry, object storage, status page): giving a service
      (or workstation/redirect) the dashboard's domain, then changing or
      deleting it, deletes the dashboard's Pangolin resource and locks you out
      of the UI until an app restart re-runs `syncDashboardDns`. Reject those
      hosts at save time and skip them in `deleteDns`
- [ ] Route `screenshots.yaml` and `e2e.yaml` Docker Hub pulls through
      mirror.gcr.io like the integration job, they can flake on an anonymous
      pull refusal the same way
- [ ] Notification channels: move the "Add a channel" form off the list page
      onto its own `channels/new` route, like every other list page
- [ ] Workstation observability: show the home volume's disk use next to CPU,
      memory and network
- [ ] Workstation editor setup only drives code-server: support
      openvscode-server (its own extension CLI and settings path) for the
      extensions and settings.json

## Medium

- [ ] Version pinning and update checks in the REST API, the CLI, the MCP tools
      and the Terraform provider (pin/unpin, watch toggles, apply update), only
      the Source tab has them today
- [ ] MCP tools for what has no REST route yet: DNS domains and records, uptime
      and monitoring, the registry, remote hosts, users, system logs, Docker
      cleanup; and a call on whether credential-holding admin config (DNS
      connections, git providers, object stores) belongs on MCP at all
- [ ] MCP `get_cron_job` hands a job's `files` contents and script `source` over
      unredacted, unlike its command and env
- [ ] Deleting a single service mid-deploy isn't refused either: same busy guard
      and force option as stack delete
- [ ] Workstations behind the per-app login wall: the gate is service-shaped
      (`gatedService`, `AppAccessService`), a workstation only has the IDE's own
      password today
- [ ] Workstations in the REST API, MCP, the CLI and the Terraform provider
- [ ] Workstations on a raw `docker` remote host (the worker's
      `dockerapi.NewRemote`), only agent hosts can run one today
- [ ] Workstation start never re-pulls an image it already has, so a `:latest`
      IDE image never updates: add a "pull" toggle or always pull on Recreate
- [ ] Deleting an agent host cascades its workstation rows but leaves their
      containers on that host and their Traefik route file behind
- [ ] A service created after a workstation can take the workstation's slug, and
      the two then fight over the same hostname (and removing the workstation
      drops the Pangolin resource the service relies on): check workstation
      slugs on service creation too
- [ ] Deploys of anything behind Traefik report success without checking the
      route: probe the hostname once the container is up (local Traefik with the
      Host header for the router, the public URL for DNS/Pangolin) and fail on
      Traefik's own 404/502/504 or the edge's default certificate, warn on a
      certificate still being issued

## Large

- [ ] Pulumi projects: generate a Pulumi program
      (`new homerun.X(..., { import })`) from the inventory like the HCL
      generator, and a drift check reading Pulumi's checkpoint from the bucket

- [ ] Package registries: run language package registries (npm first, then PyPI,
      Maven, Cargo...) from Homerun as core services like the Docker registry,
      with tokens and an optional public hostname, listed under Registries in
      the sidebar next to Docker Registry
