---
page_title: "homerun_workstation_preset (Resource)"
description:
  "One of the API key owner's workstation presets: settings and a login wall a
  new workstation starts from."
---

# homerun_workstation_preset (Resource)

One of the API key owner's workstation presets: settings and a login wall a new
workstation starts from.

## Example usage

```terraform
resource "homerun_workstation_preset" "example" {
  name        = "node"
  description = "Node 22 with Prettier."
  image       = "codercom/code-server:latest"
  extensions  = ["esbenp.prettier-vscode"]
}
```

## Schema

### Required

- `name` (String)

### Optional

- `auth_allowed_emails` (List of String) Addresses, or *@domain patterns, an
  account's email must match to get in. Empty lets any address through.
- `auth_allowed_groups` (List of String) OIDC groups (from a linked provider) or
  Homerun roles, one of which an account must have to get in. Empty skips the
  check.
- `auth_allowed_user_ids` (List of String) The only accounts let in, by id (a
  homerun_user or homerun_service_account id). Empty lets every account through
  the other rules; a service account only ever gets in when listed here.
- `auth_providers` (List of String) Sign-in methods the wall offers: "password",
  "email-otp" (an emailed code), "magic-link" (an emailed link) and "oauth:"
  followed by a homerun_oauth_provider's name (oauth:pocket-id). Each must be
  enabled on the instance (the emailed ones in homerun_authentication_settings,
  with SMTP set up) or the API refuses it, and auth_required needs at least one.
  An emailed method proves only the mailbox, so it lets any Homerun account
  through unless auth_allowed_emails or auth_allowed_user_ids narrow it.
- `auth_required` (Boolean) Put Homerun's login wall in front of the IDE of
  every workstation created from this preset, instead of its password or git
  sign-in. Defaults to `false`.
- `cpu_limit` (String) Cores, like 1.5.
- `description` (String)
- `env` (Map of String, Sensitive) Variables set in the container. PASSWORD is
  Homerun's.
- `extensions` (List of String) Open VSX extension ids (publisher.name)
  installed on every start.
- `git_author_email` (String)
- `git_author_name` (String)
- `git_branch` (String)
- `git_provider_id` (String) The git provider whose connection authenticates git
  and, when set, signs in to the IDE.
- `git_url` (String) An http(s) repository cloned into the home directory.
- `home_path` (String) Defaults to `"/home/coder"`.
- `image` (String) Defaults to `"codercom/code-server:latest"`.
- `memory_limit_mb` (Number)
- `port` (Number) The IDE's port in the container. Defaults to `8080`.
- `remote_host_id` (String) The agent host it runs on, this server when unset.

### Read-only

- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_workstation_preset.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_workstation_preset.example "<id>"
```
