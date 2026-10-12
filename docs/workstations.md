# Workstations

**Workstations** in the sidebar (Workspace) gives you a dev box in the browser:
a container running a web IDE
([code-server](https://github.com/coder/code-server) by default, VS Code in the
browser) with a home directory that survives restarts and, optionally, your
repository already cloned into it. It runs on this server or on any
[agent host](remote-hosts-and-agent.md#homerun-agent).

Workstations are personal: you only ever see your own, and an admin doesn't see
the workstations of other accounts either. Creating one needs write access to
Workstations, which the Developer role has.

## Creating one

**New Workstation** asks for:

- **Name**: also its address, `<name>.<your base domain>`. A name already used
  by a service or another workstation gets a numbered suffix.
- **Runs on**: **This server**, or one of your registered agent hosts. Only
  agent hosts are offered: a raw Docker connection can't run one.
- **Repository** (optional): with a [git provider](git-providers.md) connected,
  pick a repository from your account and one of its branches; **Use a clone URL
  instead** takes any `http(s)` URL and branch. It's cloned into the home
  directory the first time the workstation starts, with your git provider
  connection when the host matches one, so a private repository works. The
  checkout keeps a plain `origin` without the token; it's never re-cloned once
  it's there.
- **Image**, **IDE port**, **Home path**: `codercom/code-server:latest`, `8080`
  and `/home/coder` by default. Any image serving a web IDE over HTTP works; the
  home path is where the persistent volume is mounted, and the image needs `git`
  for the clone.
- **CPU limit**, **Memory limit**, **Environment variables** (optional).

It starts as soon as it's created. The Overview tab follows the start (pulling
the image, starting, cloning) and shows **Open IDE** once it runs.

## Logs and self-test

The **Logs** tab streams what the IDE container prints, its last 500 lines then
live. A failed image pull or clone happens before the container runs; its error
is on the Overview tab instead.

**Settings → Self-test** checks the workstation end to end: the container runs,
an agent host's published port answers this server, the hostname resolves, and
`https://<name>.<your base domain>` reaches the IDE through Traefik with a
certificate that verifies. A failed check says why: a 404 means Traefik has no
router for the hostname (or DNS points elsewhere), a 502 means the router exists
but nothing answers on the IDE port.

## Signing in

Homerun generates a password per workstation and passes it to the container as
`PASSWORD`, which code-server asks for on its login page. Copy it from the
Overview tab. **Reset password** generates a new one, which takes effect on the
next start. An image that ignores `PASSWORD` has to bring its own sign-in.

The [login wall](login-wall.md) doesn't cover workstations yet; the password of
the IDE itself is what stands in front of it.

## Starting, stopping, recreating

- **Start** (or **Recreate** while it runs) recreates the container from the
  current settings. The home directory is a Docker volume
  (`homerun-workstation-<id>`), so files, extensions and the cloned repository
  survive it.
- **Stop** stops the container and keeps everything.
- Settings changes apply on the next start.
- Delete is under **Settings → Danger zone**. The home volume is kept unless you
  tick **Also delete the home volume**.

Deleting your account removes your workstations and their home volumes.

## Auto-stop

Off by default. The **Auto-stop** panel on the Overview stops the workstation
for you, so an IDE you forgot about doesn't hold CPU and memory all night:

- **When nobody uses it**: stops once no browser has been connected to the IDE
  for the given number of minutes. Homerun checks every minute by counting the
  open connections to the port the IDE listens on inside the container, so an
  open IDE tab, even an idle one, keeps it running. If that count can't be read
  (the image has no `cat`, or it's still starting), the workstation counts as in
  use.
- **After a set time**: stops that many minutes after it starts, open tab or
  not.

The delay is 5 minutes to a week. The setting sticks: every **Start** arms the
countdown again, and saving it while the workstation runs restarts the countdown
from now. The Status panel shows roughly when it'll stop. An auto-stop is a
plain **Stop**: the container and home volume stay, **Start** brings it back.

## On an agent host

The workstation's IDE port is published on an ephemeral port of the agent host,
and this server's Traefik routes `<name>.<your base domain>` to it through its
file provider, so it gets the same TLS as everything else. That needs Traefik's
dynamic config directory (set by every shipped compose file and the installer);
without one, **Open IDE** links straight to `http://<agent host>:<port>`.

Either way the published port is open on the agent host's network, guarded by
the IDE password: firewall it if the agent host is reachable from the internet.
The agent host's worker has to be at least the version that added workstations;
an older one answers that it doesn't know the route.
