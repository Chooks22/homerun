# Migrating from Dokploy or Coolify

**Settings → Migrate** (needs the Settings permission) reads another PaaS
instance and recreates what it finds here. Pick Dokploy or Coolify, give it the
instance URL and an API token, and **Read instance** lists every application,
compose stack and database, grouped by the project it lives in. It only ever
makes read requests: nothing on the other side is stopped, changed or deleted,
and the token is sent with each request on that page, never stored.

Tick what you want and **Import**. Each source project becomes a Homerun stack,
and every entry goes through the same importer as
[Importing a compose file](compose-import.md), so volumes, slugs and warnings
behave the same way. Nothing is deployed: each imported service waits until you
deploy it.

What carries over:

- **Docker image apps**: image and tag, env vars, the port of their first domain
  (public) or internal-only when they had no domain, each domain (one something
  on this instance already routes, a service, a redirect, a workstation or the
  dashboard, is dropped) with its path (with Dokploy's **Strip Path** carried
  over as [Strip path](networking.md); an **Internal Path** is a warning),
  CPU/memory limits, named-volume and bind mounts, and Dokploy's private
  registry credentials.
- **Start commands**: a Dokploy command runs through `/bin/sh -c` and its
  arguments replace the image's, the same way Dokploy starts it. On Coolify,
  `start_command` becomes the container command, and the custom docker run
  options Homerun can apply (`--cap-add`, `--device`, `--privileged`, `--label`,
  `--entrypoint`, `--user`) land on the
  [Container → Runtime](runtime-and-compute.md#runtime); any other flag is a
  warning.
- **File mounts and storage**: a Dokploy file mount (on an app, a database, or
  bound from a compose stack's `../files/` directory) is written under
  `/var/lib/homerun/files/<slug>/` on this host and bind-mounted read-only at
  the same path. Coolify persistent volumes, host binds and file storages come
  across the same way when Coolify's API lists them.
- **Git apps**: become
  [git-based](deploy-source-and-builds.md#deploy-source-image-or-git-repo)
  services with the repository, branch, build context and
  [build method](deploy-source-and-builds.md#build-methods): a Dockerfile (with
  its path), Nixpacks, Railpack, or Dokploy's Heroku and Paketo buildpacks.
  Custom install or build commands set on Coolify aren't carried over, put them
  in the builder's config file in the repository. A private repository needs a
  [connected git provider](git-providers.md).
- **Compose stacks**: the stored compose file, with the stack's own variables
  substituted in. On Dokploy, each domain's port is applied to the service it
  targets, and named volumes keep pointing at the data Dokploy created
  (`<appName>_<volume>`, or the volume's own `name:`/`external` declaration).
- **Databases**: the image, the port, and the credentials turned into the
  image's own env vars (`POSTGRES_PASSWORD`, `MYSQL_ROOT_PASSWORD`, …), always
  internal-only. A Redis, KeyDB or Dragonfly password is applied through the
  start command, the way both platforms set it.

What doesn't, and shows up as a blocked entry or a warning instead: apps built
with a static build pack, and compose stacks read from a repository at deploy
time. Coolify doesn't expose registry credentials, and older Coolify versions
don't list persistent storage in their API: the import says so, re-attach those
volumes by hand.

For Dokploy, create the token under **Settings → Profile → API/CLI**. For
Coolify, create it under **Keys & Tokens** with the `read` and `read:sensitive`
permissions: without `read:sensitive`, env values and database passwords come
back hidden.

## On the same host

Dokploy and Coolify already hold ports 80, 443 and 3000, so install Homerun next
to them on other ports:

```bash
curl -fsSL https://raw.githubusercontent.com/orochibraru/homerun/main/cmd/installer/bootstrap.sh \
  | sudo bash -s -- --mode=full --domain=homerun.example.com \
    --dashboard-port=4500 --http-port=8080 --https-port=8443
```

On a Dokploy host the swarm already exists and the installer reuses it. Open
`http://homerun.example.com:4500`, run the import against the old instance's own
URL, and check every service, its env vars and its volumes before deploying
anything. Imported named volumes point at the data the old platform created on
this host: **stop the old app before deploying its Homerun copy**, two
containers writing the same database volume corrupt it.

Routing can be checked before the switch with
`curl -k -H 'Host: app.example.com' https://127.0.0.1:8443`. Let's Encrypt can't
issue certificates while port 80 isn't Homerun's, so expect Traefik's
self-signed one until then.

To take over 80/443, stop the old proxy (`docker stop dokploy-traefik` on
Dokploy, `docker stop coolify-proxy` on Coolify), then run the same one-liner
again, same `--domain=`, with `--http-port=80 --https-port=443`, or set
`HOMERUN_HTTP_PORT=80` and `HOMERUN_HTTPS_PORT=443` in
`/home/homerun/homerun/.env` and run `sudo docker compose up -d traefik` there
(add `-f compose.yaml -f compose.swarm.yaml` on a swarm install). Restart the
old proxy to roll back.
