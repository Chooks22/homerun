# Infrastructure as code

Homerun can be managed with Terraform, OpenTofu or Pulumi: stacks, services and
every setting the dashboard has, plus the objects around them. The
**Infrastructure as Code** page (Integrations, needs the Infrastructure as code
permission) lists your IaC projects. Each project picks a tool, keeps its state
in a bucket on one of your [object stores](object-storage.md), covers a stack or
a service, writes a starter configuration from what's already running and
compares its state with the instance to show what changed outside it.

## Projects

**New project** opens a page that takes:

- **Tool**: Terraform, OpenTofu or Pulumi. Terraform and OpenTofu use the state
  backend Homerun serves (versions, diffs, rollbacks and locks below). Pulumi
  doesn't speak that protocol and keeps its own state in the bucket.
- **What it manages**: a stack (its substacks included) or a service, searched
  by name, or nothing yet. It names the project when you haven't typed a name,
  and it's what the Generate tab starts on.
- **Name**, **Store**, **Bucket** (created when the store doesn't have it yet)
  and an optional **Folder in the bucket**.

The list shows each project's tool, what it manages, where its state lives, and
for Terraform and OpenTofu the latest serial and when it was written, with a
lock icon while a run holds the lock. Until an object store exists, the page
points at Object Storage instead. A project's page has five tabs: **State**,
**Generate**, **Drift**, **Credentials** and **Settings**.

**Settings** renames the project, changes what it manages, or switches its tool.
Switching between Terraform and OpenTofu changes nothing but the commands the
pages show. Moving to or from Pulumi doesn't convert the state: the versions
Homerun kept stay, Pulumi keeps its own. Its danger zone deletes the project,
its versions and its lock; the state files stay in the bucket.

## Credentials

A project's **Credentials** tab lists every API key on your account with its
permissions, last use and expiry, and revokes them. **New API key** opens a page
that creates a key with the permissions your account has today (not ones granted
later), and shows it once, ready to paste: the two `export` lines
(`HOMERUN_API_KEY` for the provider, `TF_HTTP_PASSWORD` for the state backend)
for Terraform and OpenTofu, the `pulumi config set --secret homerun:apiKey`
command for Pulumi. For a key narrowed to a few areas, use **Profile → API
Keys**. A Pulumi project's Credentials tab also lists the bucket's access keys,
which Pulumi reads and writes its state with: on the built-in store it creates
and revokes keys scoped to the bucket; for a provider, keys come from its own
console.

## The Terraform provider

The provider's address is `orochibraru/homerun`. It talks to the REST API, so it
can do what an API key can (see [API & CLI](api-and-cli.md)), and it needs a key
with the matching permission for each resource it manages (write on DNS for DNS
connections, on Git providers for git providers, on Object storage for object
stores and buckets, and so on).

```hcl
terraform {
  required_providers {
    homerun = {
      source = "orochibraru/homerun"
    }
  }
}

provider "homerun" {
  endpoint = "https://homerun.example.com"
}
```

`endpoint` and `api_key` fall back to the `HOMERUN_ENDPOINT` and
`HOMERUN_API_KEY` environment variables.

### Resources

| Resource                          | What it manages                                                                                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `homerun_stack`                   | A stack, nested in another with `parent_id`.                                                                                                                                              |
| `homerun_service`                 | A service with every setting: source and build, registry, env vars, compute, networking and domains, published ports, runtime, healthcheck, login wall, previews, release channels, cron. |
| `homerun_service_environment`     | An environment of a service (staging, demo and so on).                                                                                                                                    |
| `homerun_service_dependency`      | One service depending on another.                                                                                                                                                         |
| `homerun_volume`                  | A storage volume and its backup settings.                                                                                                                                                 |
| `homerun_volume_mount`            | A volume mounted into a service.                                                                                                                                                          |
| `homerun_cron_job`                | A cron job.                                                                                                                                                                               |
| `homerun_redirect`                | A redirect.                                                                                                                                                                               |
| `homerun_notification_channel`    | A notification channel of the API key's account.                                                                                                                                          |
| `homerun_backup_destination`      | A backup destination (S3, SFTP, SMB or WebDAV).                                                                                                                                           |
| `homerun_status_page`             | A status page.                                                                                                                                                                            |
| `homerun_dns_connection`          | A DNS provider account (`dns_provider` is its id, `credentials` its fields).                                                                                                              |
| `homerun_git_provider`            | A GitLab, Gitea or Bitbucket OAuth app. A GitHub App is registered from the dashboard, then imported.                                                                                     |
| `homerun_build_cache_registry`    | A build cache registry.                                                                                                                                                                   |
| `homerun_object_store`            | An S3-compatible object store. The built-in store can be read but not changed.                                                                                                            |
| `homerun_bucket`                  | A bucket on a store, with its object expiration.                                                                                                                                          |
| `homerun_service_account`         | A service account and its permissions. Its id goes in a service's `auth_allowed_user_ids`; its API keys are minted outside Terraform, so no secret lands in the state.                    |
| `homerun_user`                    | A person's account: email, name, role and a custom role's permissions. Created without a password, like Users → Add user.                                                                 |
| `homerun_oauth_provider`          | An OAuth/OIDC sign-in provider (Authentication → Providers). `client_secret` is write-only; a login wall offers it as `oauth:<name>`.                                                     |
| `homerun_registry_token`          | A push and pull token for the built-in registry. Its `secret` is generated on create and kept in the state; an imported token has none.                                                   |
| `homerun_instance_settings`       | Settings → General, Docker and Networking: base domain, dashboard URL, release channel, default UI mode, resource alerts, image scanning, orchestration mode, Traefik.                    |
| `homerun_smtp_settings`           | Settings → Email.                                                                                                                                                                         |
| `homerun_tls_settings`            | Settings → TLS: the instance certificate.                                                                                                                                                 |
| `homerun_error_pages`             | Settings → Error pages: branding and page texts.                                                                                                                                          |
| `homerun_ip_ban_settings`         | Settings → IP bans: when an address gets banned, and the CrowdSec push.                                                                                                                   |
| `homerun_authentication_settings` | The Authentication page's switches: emailed codes and links, featured sign-in methods, passkey and two-factor requirements.                                                               |
| `homerun_registry_settings`       | Docker Registry → Settings: auth and public hostname.                                                                                                                                     |
| `homerun_remote_host`             | A build server: a Docker daemon (`docker_host`, optional TLS) or a Homerun Agent (`agent_url`, `agent_token`, checked against the agent). An enrolled server can be imported.             |
| `homerun_domain`                  | A domain Homerun manages, linked to a DNS connection's zone or not, with its record target and automation switch.                                                                         |
| `homerun_dns_record`              | A record made by hand at a domain's DNS provider.                                                                                                                                         |
| `homerun_workstation`             | One of the API key owner's dev workstations: image, resources, repository, extensions, git identity, auto-stop and whether it runs.                                                       |
| `homerun_workstation_preset`      | One of the API key owner's workstation presets.                                                                                                                                           |

The data sources `homerun_template`, `homerun_service` and `homerun_stack` read
an object by `id`, a template also by `name`, a service or a stack also by
`slug`.

How the attributes behave:

- **Left out means left alone.** An attribute missing from the configuration
  keeps whatever value the instance has, and removing one from the configuration
  doesn't reset it. Set it to change it.
- **Secrets are write-only.** Passwords, keys, a webhook target and DNS
  credentials are sent to Homerun but never read back, so a change made in the
  dashboard doesn't show in a plan. They're marked sensitive.
- **Values are stored the way Homerun stores them.** A domain is stored in
  lowercase and the destination of a redirect gets a trailing `/`: write them
  that way, or the next plan shows the difference.
- **`template_id`** creates the service from a template (its image, variables,
  volumes and linked services), then applies the other attributes on top. Linked
  services the template creates aren't managed by the configuration.
- **`deploy_on_change`** on a service or an environment deploys it after it's
  created and after every change, and waits for the deploy. A failed deploy is a
  warning: the settings are saved either way.
- **Import** by id: `terraform import homerun_service.web <id>`, or a Terraform
  1.5 `import` block. A bucket's id is `<store_id>/<name>`, a DNS record's
  `<domain_id>/<record_id>`.
- **A DNS record is replaced on every change**, since several providers derive a
  record's id from its value. Write its `name` in full (`www.example.com`, or
  the domain itself for its apex) and its `content` the way the provider answers
  (no trailing dot, TXT unquoted), or the next plan replaces it again. Records
  Homerun creates for services' hostnames aren't listed by the IaC page and
  shouldn't be managed here.
- **Workstations and their presets are personal.** They belong to the API key's
  owner, like in the dashboard, and another account's can't be read or imported.
  A workstation's `domain` and `remote_host_id` can't change after it's created;
  destroying one keeps its home volume; its editor settings are set from the
  dashboard. `desired_state = "running"` starts it again on the next apply after
  an auto-stop.
- **Users and sign-in providers.** A `homerun_user` is created without a
  password and picks one at their first sign-in, like an account added from
  Users; destroying it hands what they created over to the API key's owner, and
  the API refuses demoting or destroying the last admin. A
  `homerun_oauth_provider`'s name is its id: it's part of the redirect URI and
  of the `oauth:<name>` method a service's `auth_providers` lists, so changing
  it replaces the provider. Every save fetches its discovery document first. A
  login wall method that isn't enabled on the instance, a wall with no method,
  or a malformed `auth_allowed_emails` entry is refused by the API, and the
  apply fails with the reason, like the Security tab would. Homerun's own OIDC
  apps (Sign in with Homerun) are managed from the dashboard only.
- **Uptime monitoring** is a service setting, `uptime_enabled` on
  `homerun_service`; there's no separate check to manage.
- **Instance settings are singletons.** The `*_settings` resources and
  `homerun_error_pages` each manage the one settings object the instance has, at
  its fixed id `instance`: creating one adopts it and applies what the
  configuration sets, and destroying it only drops it from the state, the
  instance keeps its settings. Import one with
  `terraform import homerun_smtp_settings.mail instance`. A service's login wall
  can offer `email-otp` once `homerun_authentication_settings` has `email_otp`
  on and `homerun_smtp_settings` configures SMTP.

### Installing it

The provider is published to the
[Terraform Registry](https://registry.terraform.io/providers/orochibraru/homerun)
and the
[OpenTofu Registry](https://search.opentofu.org/provider/orochibraru/homerun),
with a version for every Homerun release, so `terraform init` (or `tofu init`)
downloads it like any other provider: nothing to build or install by hand. A
project's **Generate** tab has the commands to run for its tool, with your
instance's URL filled in.

## Generating a configuration

A Terraform or OpenTofu project's **Generate** tab writes the configuration for
one stack or one service, never the whole instance at once: a project per stack
or service keeps each plan small and each state independent. A stack covers
itself, its substacks, their services with their environments, dependencies,
mounts and volumes, and the status pages of those stacks. A service covers
itself, its environments, the dependencies it declares, and its mounts with
their volumes; its stack and the services it depends on stay outside, referenced
by id. It starts on what the project manages; search for another stack or
service by name to generate for it instead. The `http` backend block always
points at the project's own [state](#terraform-state), and the commands in the
README use `tofu` for an OpenTofu project.

The project is a folder you download as a zip, and preview file by file on the
page, highlighted:

- `versions.tf`: the provider's source and the project's backend.
- `providers.tf`: the provider, pointed at this instance.
- One `service_<name>.tf` per service, with its environments, dependencies and
  volume mounts, each next to its `import` block.
- `stacks.tf` (stacks and status pages) and `volumes.tf`.
- `variables.tf`, `terraform.tfvars` and `terraform.tfvars.example`, when there
  are secrets.
- A `README.md` with the steps below, and a `.gitignore` that keeps the state,
  `.terraform/` and `terraform.tfvars` out of git.

Values a setting leaves at its default are left out. References between objects
become Terraform references (`homerun_stack.apps.id`). No secret value is ever
written in a `.tf` file: env vars marked secret, and secrets the API never
returns, become sensitive variables. Their values go in `terraform.tfvars`: the
env vars come filled in with what runs today, and each secret Homerun never
reads back (a registry password, a provider's client secret) is a commented-out
line to fill in, so Terraform asks for it instead of applying an empty value
over the real one. The page shows that file with the values masked; the zip has
them, so keep it private. `terraform.tfvars.example` is the same list, empty,
safe to commit. Then:

```sh
export HOMERUN_API_KEY=<an API key>
export TF_HTTP_PASSWORD=$HOMERUN_API_KEY
terraform init
terraform plan
```

The first plan imports everything and updates the write-only secrets (Terraform
can't know their current value). Previews, canaries and the built-in object
store are Homerun's own and aren't included.

### From the CLI

The [CLI](api-and-cli.md#cli) writes the same project without the browser, with
an API key that can read what you generate from (the Infrastructure as code
permission, plus the areas of the services involved):

```sh
homerun iac generate --service api
homerun iac generate --stack web --state-project <project id>
```

`--stack` and `--service` take an id or a slug. The files go into
`./<slug>-terraform/` (`--out <dir>` for another directory), and the CLI writes
nothing when any of them already exists unless you pass `--force`.
`terraform.tfvars` is written readable by you only, since it holds the secret
values. The CLI then prints the files it wrote and the commands to run next.
`--zip <file>` saves the zip instead, and `--stdout` prints every file after a
`# ==> <path> <==` line, for a quick look or a pipe.

## Terraform state

A Terraform or OpenTofu project's **State** tab keeps its state in the project's
bucket through Terraform's `http` backend. It shows the block to paste (the
Generate tab's files already have it), the lock and the versions:

```hcl
terraform {
  backend "http" {
    address        = "https://homerun.example.com/api/v1/iac/projects/<id>/state"
    lock_address   = "https://homerun.example.com/api/v1/iac/projects/<id>/lock"
    unlock_address = "https://homerun.example.com/api/v1/iac/projects/<id>/lock"
    lock_method    = "POST"
    unlock_method  = "DELETE"
    username       = "homerun"
  }
}
```

Terraform authenticates with HTTP Basic: any username, and a Homerun API key as
the password, set as `TF_HTTP_PASSWORD` so it stays out of the file. The key
comes from the project's [Credentials](#credentials) tab. It needs write access
to Infrastructure as code to write or lock the state; with read access it can
only read it. Terraform never needs a key for the bucket itself: it only talks
to Homerun, which reads and writes the bucket with the store's own credentials.

- **Versions.** Every state Terraform writes is kept as its own object in the
  bucket and listed newest first, with its serial, when, who (the API key's
  owner) and its size. Nothing is overwritten.
- **Diff.** Open a version to see which resources it added, changed and removed
  compared with the version before it.
- **Rollback.** **Roll back** on an older version writes it back as the newest
  state, with a serial past the latest so Terraform accepts it. The versions in
  between stay in the history. It's refused while the state is locked.
- **Lock.** Terraform locks the state for every plan and apply, and a second run
  is refused with the first one's lock info until it finishes. The lock lives in
  Homerun, not in the bucket, so it works on every store. **Force unlock**
  releases a lock left behind by a run that died; only use it when that run is
  really gone.

Pulumi doesn't speak Terraform's backend protocol, so a Pulumi project's
**State** tab shows the bucket's endpoint and region and a `pulumi login`
command that points Pulumi straight at the project's bucket and folder, with an
access key for the bucket (from the Credentials tab) in `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. Pulumi then keeps its own history and locks in the
bucket; the versions, diff and rollback above only cover Terraform and OpenTofu.

## Drift

A Terraform or OpenTofu project's **Drift** tab reads the latest version of its
state and compares every `homerun_*` resource in it with the live object,
through the same mapping the provider uses:

- **Drifted**: an attribute changed outside Terraform, with the value in the
  state and the live one. A sensitive attribute (env vars) only says it changed.
  `terraform plan` puts it back unless the configuration changes too.
- **Missing**: in the state, deleted on the instance. `terraform plan` creates
  it again.
- **Unmanaged**: running, with no resource in this state. The Generate tab
  writes its import block.

Write-only attributes can't be compared and are left out. Instance settings are
compared when the state manages them, and never listed as unmanaged. Pulumi
projects have no drift check yet: `pulumi refresh --preview-only` shows the same
thing.

## Pulumi

Pulumi (3.147 or later) runs any Terraform provider, so there's no separate
Pulumi provider. Add it to a Pulumi project from the registry, which generates a
typed SDK and records it under `packages` in `Pulumi.yaml`:

```sh
pulumi package add terraform-provider orochibraru/homerun
pulumi config set homerun:endpoint https://homerun.example.com
pulumi config set --secret homerun:apiKey <an API key>
```

The configuration keys use camel case. Every `homerun_` resource is a class
(`homerun_service` is `Service`) with camel case attributes, and data sources
are `get` functions:

```ts
import * as homerun from "@pulumi/homerun";

const web = new homerun.Stack("web", { name: "Web", slug: "web" });

const postgres = homerun.getTemplateOutput({ name: "PostgreSQL" });
const db = new homerun.Service("db", {
  stackId: web.id,
  templateId: postgres.id,
  slug: "web-db",
});

new homerun.Service("api", {
  name: "API",
  slug: "api",
  stackId: web.id,
  image: "ghcr.io/acme/api",
  tag: "1.4.0",
  containerPort: 8080,
  envVars: { DATABASE_HOST: db.slug },
  deployOnChange: true,
});
```

A Pulumi project's Generate tab shows these snippets with your instance's URL
filled in. Homerun doesn't write a Pulumi program from what's running yet: start
from the example and adopt existing objects with `pulumi import`.
