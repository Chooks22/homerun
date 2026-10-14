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

Workstations and presets are also in the REST API (`/api/v1/workstations`,
`/api/v1/workstation-presets`) and the Terraform provider
(`homerun_workstation`, `homerun_workstation_preset`), scoped to the API key's
owner the same way, see [Infrastructure as code](infrastructure-as-code.md).

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
- **Editor** (optional): extensions and `settings.json`, see
  [Editor and git setup](#editor-and-git-setup).
- **Git** (optional): which connected git provider pushes from the IDE, and the
  commit name and email.
- **CPU limit**, **Memory limit**, **Environment variables** (optional).

With [presets](#presets) saved, **Start from a preset** at the top fills the
whole form from one; change anything before creating.

It starts as soon as it's created. The Overview tab follows the start (pulling
the image, starting, cloning, setting up the IDE) and shows **Open IDE** once it
runs.

## Presets

A preset is a saved set of workstation settings (where it runs, repository,
editor, git, container) to start new workstations from. Like workstations,
they're personal.

- **Workstations → Presets** lists yours, **New Preset** makes one from scratch,
  and the page of a preset edits it, deletes it, or starts **New workstation
  from it**.
- **Settings → Save as preset** on a workstation saves its current settings as a
  new preset, under the name and the description you give it.

A preset is a copy: editing or deleting it never touches a workstation created
from it, and saving a workstation's settings later doesn't update its preset.

## Editor and git setup

The IDE is configured per workstation and applied on every start, inside the
running container, as its own user. A repository's dev container config can fill
it in when you create a workstation or a preset (see
[dev container configs](#repository-dev-container-configs)):

- **Extensions**: search [Open VSX](https://open-vsx.org) (the registry
  code-server installs from) and pick them, or paste an exact `publisher.name`
  id. Each start installs the list with `code-server --install-extension`, and
  uninstalls one that a previous start installed and that you've since removed.
  Extensions installed from the IDE itself are left alone. Needs the image to
  ship `code-server`; an extension that fails to install fails the start with
  its id.
- **Settings**: a JSON object written over code-server's user `settings.json`
  (`<home>/.local/share/code-server/User/settings.json`). Leave it empty to keep
  what you change from the IDE.
- **Git**: pick one of your connected [git providers](git-providers.md). Its
  token goes into the git credential store (`<home>/.git-credentials`, replacing
  only that host's line, with `credential.helper store`), so `git push` and
  `git pull` work from the terminal in the IDE, and into `GH_TOKEN` (GitHub) or
  `GITLAB_TOKEN` (GitLab) for `gh` or `glab`. **Commit name** and **Commit
  email** set `user.name` and `user.email`; the name defaults to your provider
  username. A short-lived provider token is refreshed on each start, so restart
  a workstation that has been running for long if a push gets refused.

## Repository dev container configs

When the repository on **New Workstation**, **New Preset**, or the page of a
preset, comes from a connected [git provider](git-providers.md) (picked, or a
clone URL on its host), Homerun looks for `.devcontainer/devcontainer.json`,
then `.devcontainer.json`, on the chosen branch. If one is there, a panel names
it and **Apply** merges into the form:

- `customizations.vscode.extensions` (and the legacy top-level `extensions`)
  into **Extensions**,
- `customizations.vscode.settings` (and the legacy top-level `settings`) into
  **Settings**, the config winning on the same key,
- `containerEnv` and `remoteEnv` into **Environment variables**, skipping values
  that reference another variable (`${localEnv:…}`).

The container itself isn't applied: `image`, `build`, `features`, mounts, and
the lifecycle commands (`postCreateCommand`…) are listed as not applied, since a
workstation runs a web IDE image rather than the dev container's own. Nothing is
read again later: it's a one-time fill of the form, not a sync.

## Observability

The **Observability** tab shows the container's CPU, memory and network use
right now (read every 5 seconds while the page is open, against the CPU and
memory limits when set), and a history chart. A running workstation is sampled
once a minute, wherever it runs, alongside the services. The Workstations list
shows each running one's latest CPU and memory.

## Logs and self-test

The **Logs** tab streams what the IDE container prints, its last 500 lines then
live. A failed image pull or clone happens before the container runs; its error
is on the Overview tab instead.

**Settings → Self-test** checks the workstation end to end: the container runs,
an agent host's published port answers this server, the hostname resolves, and
`https://<its domain>` reaches the IDE through Traefik with a certificate that
verifies. A failed check says why: a 404 means Traefik has no router for the
hostname (or DNS points elsewhere), a 502 means the router exists but nothing
answers on the IDE port.

## Signing in

**With a git provider picked under Git**, opening the workstation signs you in
through that provider instead of a password: Traefik sends you to the provider's
consent screen, the provider sends you back through Homerun's usual git provider
callback, and only the account your connection belongs to gets in (any other
account is refused). You then get an 8-hour session cookie on the workstation's
own hostname. For code-server on this server, Homerun starts it with
`--auth none`, so there's no second password prompt. On an agent host, or with
any other image, the IDE keeps its `PASSWORD` too, since an agent host's
published port is reachable without going through Traefik. It needs the
Dashboard URL set (Settings → General) and applies from the next start. Removing
the git provider, disconnecting it, or reconnecting another account locks the
running workstation until you start it again; it never falls open.

**Otherwise** Homerun generates a password per workstation and passes it to the
container as `PASSWORD`, which code-server asks for on its login page. Copy it
from the Overview tab. **Reset password** generates a new one, which takes
effect on the next start. An image that ignores `PASSWORD` has to bring its own
sign-in.

The [login wall](login-wall.md) itself doesn't cover workstations: it's the git
sign-in or the password of the IDE that stands in front of one.

## Starting, stopping, recreating

- **Start** (or **Recreate** while it runs) recreates the container from the
  current settings. The home directory is a Docker volume
  (`homerun-workstation-<id>`), so files, extensions and the cloned repository
  survive it.
- **Stop** stops the container and keeps everything.
- Settings changes apply on the next start. Each section of the Settings tab
  saves on its own.
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
and this server's Traefik routes its domain to it through its file provider, so
it gets the same TLS as everything else. That needs Traefik's dynamic config
directory (set by every shipped compose file and the installer); without one,
**Open IDE** links straight to `http://<agent host>:<port>`.

Either way the published port is open on the agent host's network, guarded by
the IDE password (kept even with the git sign-in): firewall it if the agent host
is reachable from the internet. The agent host's worker has to be at least the
version that added workstations; an older one answers that it doesn't know the
route.
