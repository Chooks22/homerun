---
page_title: "homerun_workstation (Resource)"
description:
  "One of the API key owner's dev workstations: a browser IDE container with a
  persistent home volume. Destroying it keeps the volume. The editor settings
  are set from the dashboard."
---

# homerun_workstation (Resource)

One of the API key owner's dev workstations: a browser IDE container with a
persistent home volume. Destroying it keeps the volume. The editor settings are
set from the dashboard.

## Example usage

```terraform
resource "homerun_workstation" "example" {
  name              = "api"
  git_url           = "https://github.com/acme/api.git"
  extensions        = ["esbenp.prettier-vscode"]
  memory_limit_mb   = 4096
  auto_stop_mode    = "idle"
  auto_stop_minutes = 60
}
```

## Schema

### Required

- `name` (String)

### Optional

- `auto_stop_minutes` (Number)
- `auto_stop_mode` (String) idle or timer, unset for never.
- `cpu_limit` (String) Cores, like 1.5.
- `desired_state` (String) running or stopped. A new workstation starts unless
  it's stopped.
- `domain` (String) Defaults to `<slug>.dev.<base domain>`. Changing it replaces
  the resource.
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
  Changing it replaces the resource.

### Read-only

- `id` (String) The object's id.
- `slug` (String)

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_workstation.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_workstation.example "<id>"
```
