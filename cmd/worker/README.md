# Homerun worker

`homerun-worker` is the Go half of Homerun. One binary, two modes, picked by
whether `DATABASE_URL` is set:

- **Next to the app** (`DATABASE_URL` set): leases the heavy background jobs
  (deploys, builds, backups, scans, cron jobs, cleanups) from the app's Postgres
  job queue, and serves the Docker control API the app calls for everything that
  touches Docker (container status, start/stop/restart, logs, the web terminal,
  host stats, prunes, swarm). Port `7430`, bearer token derived from
  `AUTH_SECRET` on both sides. The app image ships it at
  `/usr/local/bin/homerun-worker` and the compose files run it as the `worker`
  service. Every job it runs is recorded as an OpenTelemetry trace, a span per
  job and per stage, written straight to the app's database (see
  [`docs/tracing.md`](../../docs/tracing.md)).
- **Agent mode** (no `DATABASE_URL`): runs on a _remote_ build host's own Docker
  daemon and serves only a small, token-authenticated HTTP surface (git builds,
  image export, host stats) for the main instance to drive. Port `7420`. It's
  wired into the app as a build-server connection kind
  (`remote_host.kind: "agent"`), see
  [`docs/remote-hosts-and-agent.md`](../../docs/remote-hosts-and-agent.md).

Agent mode deliberately doesn't expose the Docker control API: that API is exec,
a terminal and arbitrary container creation, so on a host reached over the
network a leaked token would be the whole daemon. A build host only ever needs
to be asked to build.

## Running it in agent mode on a remote host

None of these need Go or a source checkout on the target host.

**Via the installer (recommended for a fresh host).** Sets up rootless Docker
too, then installs the worker as the `homerun-worker` `systemd --user` unit, see
[`cmd/installer/README.md`](../installer/README.md):

```bash
curl -fsSL https://raw.githubusercontent.com/orochibraru/homerun/main/cmd/installer/bootstrap.sh \
  | sudo bash -s -- --mode=agent
```

Its token then lives in the rootless user's `~/.homerun-worker/token`
(`sudo -u homerun cat /home/homerun/.homerun-worker/token`).

**Already running Docker your own way?** Run the published image
(`docker.io/orochibraru/homerun-worker`, `linux/amd64` + `linux/arm64`, built
from the `worker` stage in the root [`Dockerfile`](../../Dockerfile) via the
`worker` target in the root [`docker-bake.hcl`](../../docker-bake.hcl)),
mounting the Docker socket the same way any Docker-managing container does:

```bash
docker run -d --name homerun-worker --restart unless-stopped \
  -p 7420:7420 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v homerun-worker-token:/root/.homerun-worker \
  docker.io/orochibraru/homerun-worker:latest
```

The second volume persists the generated token across container restarts; set
`-e WORKER_TOKEN=...` instead to pin it yourself. Never pass `DATABASE_URL`
here, it would switch the container out of agent mode. Mount
`/run/user/<uid>/docker.sock` onto `/var/run/docker.sock` to drive a rootless
daemon instead of the system one.

**Grab the prebuilt binary directly** from this repo's GitHub releases (Linux
only, amd64/arm64, see `scripts/build-packages.ts`):

```bash
curl -fsSL https://github.com/orochibraru/homerun/releases/latest/download/homerun-worker-amd64.gz | gunzip -c > homerun-worker
chmod +x homerun-worker
./homerun-worker
```

(`-arm64` on an arm64 host. No macOS build: the worker only ever runs on the
Linux host it manages.)

On first boot with no `WORKER_TOKEN` set, it generates a token, persists it to
`WORKER_TOKEN_FILE` and prints it in its startup banner. Paste that, plus this
host's reachable `http://host:7420`, into the main instance's Remote Hosts page.

**From source**, from the repo root:

```bash
go run ./cmd/worker                        # agent mode, as long as DATABASE_URL is unset
bun run scripts/build-packages.ts amd64    # or arm64, writes dist/homerun-worker-<arch>
```

## Env vars

| Var                           | Default                      | Meaning                                                                                                                                                                                 |
| ----------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | _(unset)_                    | The app's Postgres. Unset means agent mode.                                                                                                                                             |
| `AUTH_SECRET`                 | _(none)_                     | The app's auth secret, which job specs are encrypted with and the control API token is derived from. Next to the app only.                                                              |
| `DOCKER_SOCKET_PATH`          | _(detected)_                 | The local Docker socket. Unset, it uses a `unix://` `DOCKER_HOST`, then the `docker` CLI's current context, then the first common socket path that exists, then `/var/run/docker.sock`. |
| `WORKER_PORT`                 | `7430`, `7420` in agent mode | HTTP listen port.                                                                                                                                                                       |
| `WORKER_TOKEN`                | _(derived / generated)_      | Bearer token callers present. Unset, it's derived from `AUTH_SECRET` next to the app, and generated then persisted to `WORKER_TOKEN_FILE` in agent mode.                                |
| `WORKER_TOKEN_FILE`           | `~/.homerun-worker/token`    | Where agent mode persists a generated token. Unused next to the app.                                                                                                                    |
| `WORKER_CONCURRENCY`          | `3`                          | Jobs executed at once. Next to the app only.                                                                                                                                            |
| `WORKER_ID`                   | `<hostname>-<pid>`           | Lease owner name recorded on every job. Next to the app only.                                                                                                                           |
| `WORKER_LOG_LEVEL`            | `LOG_LEVEL`, else `info`     | `debug`, `info`, `warn` or `error`.                                                                                                                                                     |
| `WORKER_DOCKER_TIMEOUT`       | `60s`                        | One Docker control call's deadline (a Go duration).                                                                                                                                     |
| `WORKER_DOCKER_STALL_TIMEOUT` | `10m`                        | How long a Docker stream may go without data while its container stops answering.                                                                                                       |
| `WORKER_JOB_STALL_TIMEOUT`    | `15m`                        | A job with no progress this long fails, heartbeat or not. Next to the app only.                                                                                                         |

A stop waits up to 120 seconds in agent mode for in-flight requests (a build in
progress) before forcing the shutdown; a second SIGINT/SIGTERM forces it
immediately.

## Agent-mode HTTP surface

Every route requires `Authorization: Bearer <token>` except `/v1/health` and
`/v1/openapi.json`.

- `GET /v1/health`, `{status, version}`, unauthenticated, for a load balancer or
  monitor probe.
- `GET /v1/openapi.json`, this surface's own OpenAPI document, unauthenticated.
- `GET /v1/stats`, host CPU/RAM/disk/GPU, the same shape as the main app's
  `SystemStatsService`.
- `POST /v1/build`, body is a `BuildInput` (see `internal/agent/build.go`):
  clones a git repo at a ref (a branch, tag or full commit SHA) and builds it
  into a local image with `buildMethod`: `dockerfile` (the default,
  `docker buildx build` with BuildKit, `buildTarget` picking the stage, the last
  one when unset), `bake` (`docker buildx bake`, one target of `bakeFile`,
  default `docker-bake.hcl`, `buildTarget`, default `default`), or `nixpacks`,
  `railpack`, `heroku`, `paketo`. Every method runs in a pinned `docker:cli`
  helper container with the host's Docker socket mounted, see
  `internal/agent/builders.go`. With `push`, the BuildKit layer cache is read
  from and written to that registry (`<registry>/<image>:buildcache`) and the
  image is pushed there afterward. A `commit` pins the build to that commit even
  when the branch has moved on. With `platform` (an os/arch pair, `linux/amd64`)
  naming another CPU architecture than this host's, the build installs QEMU
  (`tonistiigi/binfmt`, pinned in `builder-tools.json`, one privileged
  container) and runs emulated, so the image runs where it's deployed. Returns
  `{success, commit?, error?}`, where a failed build's `error` carries its most
  telling output line.
- `GET /v1/images/save?ref=<image:tag>`, streams a local image as a
  `docker save` tarball (`application/x-tar`, 404 when the image isn't there).
  The main app `docker load`s it when a build server has no cache registry.
- `PUT /v1/workstations/{id}`, body is a workstation `Spec` (see
  `internal/workstation`): pulls the image (falling back to the local copy when
  the pull fails), ensures the `homerun-workstation-<id>` home volume, recreates
  the container with its port published on an ephemeral host port, starts it,
  then clones `git` into the home volume as the container's own user when it
  isn't there yet. Answers `202` as soon as the start is under way, `409` while
  one already is.
- `GET /v1/workstations/{id}?port=<container port>`,
  `{state, error?, containerId?, hostPort}`: `pulling`, `starting`, `cloning`
  while a start is in flight, then `running`, `stopped`, `failed` or `missing`
  from the container itself, with the host port it's published on.
- `GET /v1/workstations/{id}/disk?path=<home path>`, `{bytes}`: how much the
  home directory holds, from `du` run in the container, `404` when it isn't
  running.
- `POST /v1/workstations/{id}/stop` stops it, keeping the container and volume.
- `DELETE /v1/workstations/{id}?volume=1` removes the container, and the home
  volume too with `volume=1`.

The local worker's Docker control API serves the same workstation routes
(without publishing the port: the app joins it to the Traefik network instead),
from the same `internal/workstation` package. There, a request carrying
`X-Homerun-Docker-Remote` (base64 JSON of a remote host's `tcp://` address and
TLS material, or its `ssh://user@host` address, Homerun's SSH private key and
the recorded host key) runs on that remote daemon instead, published like on an
agent. An `ssh://` daemon is reached through one shared SSH connection per host,
as a stream-local channel to its `/var/run/docker.sock`.
`POST /v1/ssh/docker-probe` (the same JSON as the body) connects once, checks
the daemon answers and returns the SSH host key presented, which the app records
before using the host (`409` when a sent host key doesn't match, `502` when the
SSH sign-in or the socket forwarding fails).
