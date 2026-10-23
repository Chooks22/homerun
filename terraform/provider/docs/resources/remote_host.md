---
page_title: "homerun_remote_host (Resource)"
description:
  "A remote host git builds can run on: a Docker daemon or a Homerun Agent.
  Servers enrolled with the dashboard's install command can be imported."
---

# homerun_remote_host (Resource)

A remote host git builds can run on: a Docker daemon or a Homerun Agent. Servers
enrolled with the dashboard's install command can be imported.

## Example usage

```terraform
resource "homerun_remote_host" "example" {
  name        = "build-box"
  kind        = "agent"
  agent_url   = "http://10.0.0.5:7420"
  agent_token = var.build_box_agent_token
}
```

## Schema

### Required

- `name` (String)

### Optional

- `agent_token` (String, Sensitive) Checked against the agent before it's saved.
  Write-only: the API never returns it, so Terraform can't detect a change made
  outside it.
- `agent_url` (String) The agent's base URL, like `http://10.0.0.5:7420`.
- `docker_host` (String) tcp://host:2376 or ssh://user@host.
- `kind` (String) docker (a Docker daemon at docker_host) or agent (a Homerun
  Agent at agent_url). Changing it replaces the resource. Defaults to
  `"docker"`.
- `max_concurrent_builds` (Number) How many builds run on it at once, 0 for no
  limit. Unset follows the instance's build_concurrency.
- `tls_ca` (String, Sensitive) Write-only: the API never returns it, so
  Terraform can't detect a change made outside it.
- `tls_cert` (String, Sensitive) Write-only: the API never returns it, so
  Terraform can't detect a change made outside it.
- `tls_key` (String, Sensitive) Write-only: the API never returns it, so
  Terraform can't detect a change made outside it.

### Read-only

- `agent_token_set` (Boolean)
- `id` (String) The object's id.
- `tls_ca_set` (Boolean)
- `tls_cert_set` (Boolean)
- `tls_key_set` (Boolean)

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_remote_host.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_remote_host.example "<id>"
```
