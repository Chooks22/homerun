# Getting started

Homerun needs three things at runtime: a Docker socket to manage containers, a
Postgres database, and Traefik for routing and TLS. Pick whichever install path
fits, both run entirely from prebuilt release binaries and Docker images, and
neither needs Bun, `git`, or a source checkout on the target host. Want to run
from source instead, to develop on it? See
[CONTRIBUTING.md](../CONTRIBUTING.md).

**You configure Homerun from its own dashboard, not from files.** The one-liner
below sets up everything the container needs to start and then hands you a
first-run wizard; from that point on, base domain, Docker, Traefik, email,
sign-in methods and DNS are all settings pages you click through. There's no
config file you have to maintain, see [Configuration](configuration.md) for the
handful of exceptions and why they exist.

## Supported systems

The one-liner installer (Option A) needs Linux on `amd64` or `arm64`, with
systemd, and with `apt-get`, `dnf` or `yum`. It installs Docker through
[get.docker.com](https://get.docker.com), so it only works on distros Docker
itself publishes packages for.

| Distro                                                       | Status                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Ubuntu 24.04 LTS, Ubuntu 26.04 LTS                           | **Supported**, the installer is tested against both on real VMs                          |
| Ubuntu 22.04 LTS, Debian 12+                                 | Should work, same apt path, not tested on real hardware                                  |
| Fedora, RHEL 9 / Rocky / Alma / CentOS Stream                | Best effort, the dnf/yum path exists but has never run on a real box, report what breaks |
| CentOS 7, other end-of-life releases                         | Not supported, Docker no longer ships packages for them                                  |
| Alpine, NixOS, Arch, anything without systemd or apt/dnf/yum | Not supported by the installer, use Option B                                             |

Option B (Docker Compose) doesn't care about the distro: any host that already
runs Docker Engine with the Compose plugin works, rootful included.

## Option A, the one-liner (fresh Linux server)

```sh
curl -fsSL https://raw.githubusercontent.com/orochibraru/homerun/main/cmd/installer/bootstrap.sh \
  | sudo bash -s -- --mode=full
```

This downloads the prebuilt `homerun-installer-<arch>` release binary for your
host's architecture and runs it, which:

1. Installs Docker Engine and enables the **system (rootful)** daemon.
2. Creates a dedicated system user (`homerun` by default), in the `docker`
   group, that owns the install directory, `/home/homerun/homerun`.
3. Runs `docker swarm init`, advertising the address of the host's default route
   (`--advertise-addr=<ip>` to pick another one on a multi-interface host), and
   creates the `homerun` bridge network plus the attachable `homerun-swarm`
   overlay that swarm services join.
4. Asks what domain (or IP) this instance will be reached at, offering the
   host's own address as the default. It is never `localhost`: that address
   becomes the app's `ORIGIN`, and better-auth only trusts that one origin, so a
   `localhost` value makes the first sign-up fail with "Invalid origin" from any
   browser that isn't on the box. Pass `--domain=homerun.example.com` to answer
   it up front, which a `curl | bash` install has to do (no terminal to prompt
   on, so it takes the detected address otherwise).
5. Writes a standalone compose file and runs `docker compose up -d` against it
   on the system daemon: Traefik (with both its docker and swarm providers on),
   Postgres, the app itself and a `worker` container from the same image (the
   only one of the four that touches the Docker socket, see
   [Configuration](configuration.md#the-app-and-the-worker)), all pulled from
   published images, then prints the dashboard URL.

The instance starts in [swarm mode](swarm-mode.md): every service deploys as a
replicated swarm service, and more machines can join as workers. **The trade-off
is that the Docker daemon runs as root**, so anything with access to its socket
(Homerun itself, and any service you give the socket to) is effectively root on
the host. Rootless Docker avoids that, but it can't create overlay networks, so
it can't run a swarm.

To keep the old rootless setup instead, add `--docker=rootless`: Docker runs
under the `homerun` user (`get.docker.com/rootless`, a `systemd --user` unit,
lingering enabled), nothing Homerun deploys runs as root, and the instance runs
in standalone mode (one container per service, no replicas, no extra nodes).

### Moving a rootless install to rootful + swarm

An instance installed rootless (the installer's default before swarm became the
default) can be moved in place:

```sh
curl -fsSL https://raw.githubusercontent.com/orochibraru/homerun/main/cmd/installer/bootstrap.sh \
  | sudo bash -s -- --migrate-to-rootful --yes
```

It stops everything on the rootless daemon (the stack and every deployed
service), enables the system daemon, copies every named volume across with file
ownership as the containers saw it, initialises the swarm and the networks,
rewrites `compose.yaml` and `homerun.yaml` for the system socket (keeping
`.env`, and a copy of the old compose file as `compose.rootless.yaml`), starts
the stack, switches the instance to swarm mode and queues a redeploy of every
service, which then come back as swarm services. Finally it stops and disables
the rootless daemon, **without deleting its data**, and prints the commands that
remove it once you're happy. If a step fails, fix the cause and run the same
command again: finished volume copies and the instance switch are recorded in
`/home/homerun/homerun/.rootful-migration` and skipped.

Two things it can't do for you, and lists at the end: containers Homerun didn't
create (not the stack, not a service) aren't moved, and host paths bind-mounted
into services keep the ownership the rootless user's subuid mapping gave them,
so a service running as a non-root user may need a `chown` there. Pass
`--domain=` if the instance's address can't be read from the old compose file.

The dashboard is routed through Traefik like any deployed service, so it's
reachable at the domain you gave it, with a real certificate. Installing against
a bare IP instead gets you Traefik's own self-signed certificate, since ACME
can't issue for an IP; port 3000 works directly either way.

Run `--mode=agent` instead of `--mode=full` if you only want this box to run the
[Homerun Agent](remote-hosts-and-agent.md#homerun-agent) as a remote build
server for a different Homerun instance, not the full app. Add `--dry-run` to
print every command without running anything, `--version=vX.Y.Z` to pin a
release instead of the latest one, and see
[`cmd/installer/README.md`](../cmd/installer/README.md) for the rest of the
flags (`--user=`, `--port=`, `--image=`, and `--dashboard-port=`/
`--http-port=`/`--https-port=` to install next to another proxy, see
[Migrating from Dokploy or Coolify](migrating-from-dokploy-or-coolify.md#on-the-same-host)).

> The installer's mutating steps (package install, rootful and rootless Docker
> setup, the swarm, systemd units, the rootless-to-rootful migration) are
> verified live for both `--mode=agent` and `--mode=full` against real
> disposable VMs, see [`cmd/installer/README.md`](../cmd/installer/README.md)
> for what was checked (and the real bugs that run found and fixed). `--dry-run`
> first is still a good habit on a box that matters.

## Option B, Docker Compose

Already have Docker set up the way you want it (rootful is fine here) and just
want the stack? [`compose.prod.yaml`](../compose.prod.yaml) runs Traefik +
Postgres + the app + a `worker` container (see
[Configuration](configuration.md#the-app-and-the-worker) for what that is), all
pulled from published images, no installer, no rootless setup, no source
checkout:

```sh
curl -fsSLO https://raw.githubusercontent.com/orochibraru/homerun/main/compose.prod.yaml
curl -fsSLO https://raw.githubusercontent.com/orochibraru/homerun/main/.env.example
mv .env.example .env && $EDITOR .env
docker network create homerun
docker compose -f compose.prod.yaml up -d
```

**You fill in exactly two values**, both in `.env`, and then you're done with
files for good:

- `AUTH_SECRET`, any long random string (`openssl rand -hex 32`). It signs your
  sessions and encrypts every secret Homerun stores, so don't leave it blank and
  don't change it later.
- `ORIGIN`, the scheme, host and port you actually type in the address bar to
  reach the dashboard: `http://203.0.113.10:3000`, or
  `https://homerun.example.com`. Leaving it at `localhost` while reaching the
  instance from another machine makes the first sign-up fail with "Invalid
  origin". See
  [Configuration](configuration.md#what-the-container-needs-before-it-can-start).

`docker compose` refuses to start without either one, on purpose, rather than
booting into a broken instance.

`.env` is the only file the stack needs. Everything a YAML config file could
hold is a `/settings` field in the dashboard instead, and you only mount one if
you'd specifically rather manage settings as a file, see
[the optional YAML file](configuration.md#the-optional-yaml-file).

Everything else in `.env` already has a working default. The ones worth knowing
about are `DASHBOARD_DOMAIN` (serve the dashboard on a real hostname through
Traefik with a real certificate, instead of port 3000 with a self-signed one)
and `ACME_EMAIL`, see
[Compose-only variables](configuration.md#compose-only-variables).

`compose.prod.yaml` is self-contained: it doesn't `extends:` the in-repo
`tools/compose/*.yaml` fragments that `compose.yaml` shares, so a downloaded
copy works on its own. [`compose.yaml`](../compose.yaml) (the dev-only variant,
no `app` service) is the reference if you'd rather run each container by hand.

## First boot

Visit the app at the address the installer printed, or the `ORIGIN` you set
(`http://localhost:5173` in dev). **The first account you create becomes admin
automatically.** After that there's no public sign-up: every other account is
created by an admin from `/users`, either directly (name, email, role, no
password to hand over — they choose their own at their first sign-in, see
[Users and roles](users-and-roles.md)) or by email invite once SMTP is
configured.

Signing in for the first time drops you into a six-step onboarding wizard:

1. **Core**, your base domain (the DNS suffix deployed services are routed
   under, so a service lands at `<slug>.<your domain>`) and the dashboard URL.
   The base domain starts as the address you opened the dashboard on, unless
   that's an IP address: `<slug>.192.168.1.10` isn't a valid hostname, so type a
   real domain there. It also asks how you'll use Homerun: **Homelab,
   click-ops** starts every account in [simple mode](ui-modes.md), **Engineering
   work** in advanced mode.
2. **Docker**, the socket path and the shared network name. The detected
   defaults are almost always right.
3. **Traefik**, which entrypoint and certificate resolver your services' routes
   should use.
4. **Email**, optional SMTP, only needed for invite emails.
5. **DNS**, optional: connect a Cloudflare zone or Pangolin, so every service
   you deploy gets its DNS record or tunnel route created for you. Each has a
   **Test** button that checks the credentials before you finish. For Pangolin,
   paste the site's Newt endpoint, ID and secret and Homerun runs the Newt
   tunnel client for you.
6. **Review**, confirm and finish.

Everything it asks is also editable afterwards from `/settings`, and nothing it
skips is hidden in a file, see [Configuration](configuration.md).

## Your first service

1. **Services → Deploy a Service**, or start from **Templates** and pick
   something from the built-in catalog, which is the fastest way to see it work
   end to end. **Quick Deploy** on a template card creates and deploys it with
   no further input.
2. The wizard walks five steps: basic info, networking (container port and
   whether it gets a public subdomain), environment variables, volumes (a new
   named volume, an existing one, or one already on this machine, mounted at a
   path), and compute limits. The port, volumes and environment variables the
   image, Dockerfile or repository's manifest declares are detected and filled
   in for you, see
   [Services](services.md#detected-from-the-image-dockerfile-or-manifest).
3. **Create and Deploy** drops you on the service's Overview tab with live
   progress, pull, create, start, streaming as it happens.
4. Once it's running, it's reachable at `<slug>.<your base domain>` over TLS,
   with no DNS or reverse-proxy work on your side beyond pointing the domain at
   this host.

![The Deploy a Service wizard](images/deploy.webp)

See the [docs index](README.md) for everything the wizard doesn't cover:
git-based builds, volumes, logs, the web terminal, scheduled redeploys, and the
per-app login wall.

## Health check

`GET /api/health` returns a plain `200 OK`, useful for a container healthcheck
or an uptime monitor, and unauthenticated by design (the same "describes shape,
not data" carve-out as `/api/v1/openapi.json`, see [API & CLI](api-and-cli.md)).
`GET /api/v1/ready` goes further: `200` only once the database and the auth
layer answer, `503` with the error otherwise. It's also unauthenticated, and
it's what a [self-update](upgrading.md) waits on before switching.

## Next steps

- [Services](services.md), deploy your first service.
- [Configuration](configuration.md), what's settable and where.
- [Users and roles](users-and-roles.md), inviting people, and
  [Authentication providers](authentication-providers.md), adding SSO.
- [The dashboard](dashboard.md), [System Logs](system-logs.md) and
  [Docker Cleanup](docker-cleanup.md), day-two housekeeping.
