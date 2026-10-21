# Workstations

**Workstations** in the sidebar (Workspace) gives you a dev box in the browser:
a container running a web IDE
([code-server](https://github.com/coder/code-server) by default, VS Code in the
browser, or [openvscode-server](https://github.com/gitpod-io/openvscode-server))
with a home directory that survives restarts and, optionally, your repository
already cloned into it. It runs on this server, on any
[agent host](remote-hosts-and-agent.md#homerun-agent), or on a remote Docker
host registered with a `tcp://` or `ssh://` address.

Workstations are personal: you only ever see your own, and an admin doesn't see
the workstations of other accounts either. Creating one needs write access to
Workstations, which the Developer role has.

Workstations and presets are also in the REST API (`/api/v1/workstations`,
`/api/v1/workstation-presets`), the CLI (`homerun workstations`,
`homerun workstation-presets`), the [MCP server](mcp.md) and the Terraform
provider (`homerun_workstation`, `homerun_workstation_preset`), scoped to the
API key's owner the same way, see [REST API and CLI](api-and-cli.md) and
[Infrastructure as code](infrastructure-as-code.md).

## Creating one

**New Workstation** asks for:

- **Name**: a name already used by another workstation gets a numbered suffix.
- **Domain**: where it opens, `<name>.dev.<your base domain>` by default. The
  `dev.` subdomain keeps workstations apart from services, so a workstation and
  a service can share a name. Any other hostname pointing at this server works
  too. A domain Homerun already routes (the dashboard, the registry or object
  storage, a service's default hostname or domains, a redirect, a status page or
  another workstation) is refused, and the form warns as you type: a workstation
  never takes a hostname over. The domain can't be changed after creation.
  Workstations created before domains keep `<name>.<your base domain>`.
- **Runs on**: **This server**, one of your registered agent hosts, or a remote
  Docker host registered with a `tcp://` or `ssh://` address (this server's
  worker drives that daemon directly).
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
- **Editor** (optional): extensions and `settings.json`, see
  [Editor and git setup](#editor-and-git-setup).
- **Git** (optional): which connected git provider pushes from the IDE, and the
  commit name and email.
- **CPU limit**, **Memory limit**, **Environment variables** (optional).
- **Login wall** (optional): put Homerun's sign-in in front of the IDE from the
  start, see [Signing in](#signing-in).

With [presets](#presets) saved, **Start from a preset** at the top fills the
whole form from one, login wall included; change anything before creating.

It starts as soon as it's created. The Overview tab follows the start (pulling
the image, starting, cloning, setting up the IDE) and shows **Open IDE** once it
runs.

For [openvscode-server](https://github.com/gitpod-io/openvscode-server) (for
example `gitpod/openvscode-server`), set the image, its port (`3000`) and its
home (`/home/workspace`).

## Presets

A preset is a saved set of workstation settings (where it runs, repository,
editor, git, container and login wall) to start new workstations from. Like
workstations, they're personal. A preset's login wall is checked like a
workstation's when it's saved: its sign-in methods have to be enabled on the
instance, and turning it on needs the Dashboard URL.

- **Workstations → Presets** lists yours, **New Preset** makes one from scratch,
  and the page of a preset edits it, deletes it, or starts **New workstation
  from it**.
- **Settings → Save as preset** on a workstation saves its current settings as a
  new preset, under the name and the description you give it.

A preset is a copy: editing or deleting it never touches a workstation created
from it, and saving a workstation's settings later doesn't update its preset.

## Editor and git setup

The IDE is configured per workstation and applied on every start, inside the
running container, as its own user. Both code-server and openvscode-server are
driven: Homerun uses `code-server` when the image has it, else
`openvscode-server` (on the `PATH`, under `$OPENVSCODE_SERVER_ROOT`, or where
the linuxserver image installs it). A repository's dev container config can fill
it in (see [dev container configs](#repository-dev-container-configs)):

- **Extensions**: search [Open VSX](https://open-vsx.org) (the registry both
  IDEs install from) and pick them, or paste an exact `publisher.name` id. Each
  start installs the list with the IDE's own `--install-extension`, and
  uninstalls one that a previous start installed and that you've since removed.
  Extensions installed from the IDE itself are left alone. Needs the image to
  ship one of the two IDEs; an extension that fails to install fails the start
  with its id.
- **Settings**: a JSON object written over the IDE's `settings.json`:
  code-server's user settings
  (`<home>/.local/share/code-server/User/settings.json`), or openvscode-server's
  machine settings (`<home>/.openvscode-server/data/Machine/settings.json`).
  Leave it empty to keep what you change from the IDE.
- **Import from Settings Sync** (the Editor panel's header button): reads what
  VS Code's Settings Sync holds for your github.com account, the one connected
  under Git providers. Its extensions are added to **Extensions**, skipping
  builtin and turned-off ones; any Open VSX doesn't publish (Remote SSH, Copilot
  and other Microsoft-only extensions) are named and left out. Its user
  `settings.json` is merged into **Settings**, synced keys winning. Nothing is
  saved until you save the panel. Only works when VS Code syncs to a GitHub
  account, not a Microsoft one.
- **Git**: pick one of your connected [git providers](git-providers.md). Its
  token goes into the git credential store (`<home>/.git-credentials`, replacing
  only that host's line, with `credential.helper store`), so `git push` and
  `git pull` work from the terminal in the IDE, and into `GH_TOKEN` (GitHub) or
  `GITLAB_TOKEN` (GitLab) for `gh` or `glab`. **Commit name** and **Commit
  email** set `user.name` and `user.email`; the name defaults to your provider
  username. A short-lived provider token is refreshed on each start, so restart
  a workstation that has been running for long if a push gets refused.

## Repository dev container configs

When the repository on **New Workstation**, **New Preset**, the page of a
preset, or a workstation's Settings tab comes from a connected
[git provider](git-providers.md) (picked, or a clone URL on its host), Homerun
looks for `.devcontainer/devcontainer.json`, then `.devcontainer.json`, on the
chosen branch. If one is there, a panel names it and **Apply** merges into the
form, keeping what you've typed there:

- `customizations.vscode.extensions` (and the legacy top-level `extensions`)
  into **Extensions**,
- `customizations.vscode.settings` (and the legacy top-level `settings`) into
  **Settings**, the config winning on the same key,
- `containerEnv` and `remoteEnv` into **Environment variables**, skipping values
  that reference another variable (`${localEnv:…}`).

The container itself isn't applied: `image`, `build`, `features`, mounts, and
the lifecycle commands (`postCreateCommand`…) are listed as not applied, since a
workstation runs a web IDE image rather than the dev container's own. Nothing is
read again later: it's a one-time fill of the form, not a sync. On the Settings
tab, whose sections otherwise save on their own, **Apply** saves the Editor and
Container sections right away; start the workstation again to use them.

## Observability

The **Observability** tab shows the container's CPU, memory and network use
right now (read every 5 seconds while the page is open, against the CPU and
memory limits when set), how much the home volume holds (measured with `du`
inside the running container every minute, so the image needs `du`), and a
history chart. A running workstation is sampled once a minute, wherever it runs,
alongside the services. The Workstations list shows each running one's latest
CPU and memory.

## Logs and self-test

The **Logs** tab streams what the IDE container prints, its last 500 lines then
live. A failed image pull or clone happens before the container runs; its error
is on the Overview tab instead.

**Settings → Self-test** checks the workstation end to end: the container runs,
a remote host's published port answers this server, the hostname resolves, and
`https://<its domain>` reaches the IDE through Traefik with a certificate that
verifies. A failed check says why: a 404 means Traefik has no router for the
hostname (or DNS points elsewhere), a 502 means the router exists but nothing
answers on the IDE port.

## Signing in

**With the login wall on** (Settings → **Login wall**, **Require login to open
this workstation**), opening the workstation goes through Homerun's own
[login wall](login-wall.md), with the same options a service has: the sign-in
methods it accepts and the users, emails and groups it lets in. You, its owner,
always get in, whichever method you sign in with; anyone else has to match the
rules. It takes over from the git sign-in and, for code-server on this server,
from the password too (Homerun starts it with `--auth none`). Policy changes
apply at once and revoke sessions issued under the old rules; turning the wall
on or off restarts a running workstation so its route follows. The user list is
offered only to an account that can read Services, the same list the service
Security tab shows. The Overview's **Sign-in** panel says when the wall is on.

**Otherwise, with a git provider picked under Git**, opening the workstation
signs you in through that provider instead of a password: Traefik sends you to
the provider's consent screen, the provider sends you back through Homerun's
usual git provider callback, and only the account your connection belongs to
gets in (any other account is refused). You then get an 8-hour session cookie on
the workstation's own hostname. For code-server on this server, Homerun starts
it with `--auth none`, so there's no second password prompt. On a remote host,
or with any other image, the IDE keeps its `PASSWORD` too, since a remote host's
published port is reachable without going through Traefik. It needs the
Dashboard URL set (Settings → General) and applies from the next start. Removing
the git provider, disconnecting it, or reconnecting another account locks the
running workstation until you start it again; it never falls open.

**With neither**, Homerun generates a password per workstation and passes it to
the container as `PASSWORD`, which code-server asks for on its login page. Copy
it from the Overview tab. **Reset password** generates a new one, which takes
effect on the next start. An image that ignores `PASSWORD` has to bring its own
sign-in.

## Starting, stopping, recreating

- **Start** (or **Recreate** while it runs) pulls the image again, so a moving
  tag like `:latest` picks up its new release, then recreates the container from
  the current settings. A pull that fails (registry unreachable, an image built
  on the host) falls back to the copy the host already has. The home directory
  is a Docker volume (`homerun-workstation-<id>`), so files, extensions and the
  cloned repository survive it. Outside the dashboard, Recreate is
  `POST /api/v1/workstations/{id}/recreate`, `homerun workstations recreate` and
  the MCP tool `recreate_workstation`.
- **Stop** stops the container and keeps everything.
- Settings changes apply on the next start. Each section of the Settings tab
  saves on its own.
- Delete is under **Settings → Danger zone**. The home volume is kept unless you
  tick **Also delete the home volume**.

Deleting your account removes your workstations and their home volumes. Deleting
a remote host removes the workstations on it: their containers on that host,
their routes and DNS records go too (best effort, an unreachable host is logged
and skipped), while their home volumes stay on the host.

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

## On a remote host

The workstation's IDE port is published on an ephemeral port of the remote host
(an agent host, or a `tcp://` or `ssh://` Docker host), and this server's
Traefik routes its domain to it through its file provider, so it gets the same
TLS as everything else. That needs Traefik's dynamic config directory (set by
every shipped compose file and the installer); without one, **Open IDE** links
straight to `http://<remote host>:<port>`. The address is the agent URL's host,
or the Docker address's host.

Either way the published port is open on the remote host's network, guarded by
the IDE password (kept even with the git sign-in or the login wall): firewall it
if the host is reachable from the internet. An agent host's worker has to be at
least the version that added workstations; an older one answers that it doesn't
know the route. A `tcp://` Docker host needs nothing installed: this server's
worker talks to its daemon with the host's TLS certificates. An `ssh://` Docker
host needs nothing installed either, only Homerun's SSH key: the worker signs in
as the address's user and reaches `/var/run/docker.sock` through the SSH
connection, see
[Direct Docker connection over SSH](remote-hosts-and-agent.md#direct-docker-connection-over-ssh).
