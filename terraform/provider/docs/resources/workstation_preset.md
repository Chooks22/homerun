---
page_title: "homerun_workstation_preset (Resource)"
description:
  "One of the API key owner's workstation presets: settings a new workstation
  starts from."
---

# homerun_workstation_preset (Resource)

One of the API key owner's workstation presets: settings a new workstation
starts from.

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
