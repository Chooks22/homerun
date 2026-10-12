---
page_title: "homerun_cron_job (Resource)"
description:
  "A scheduled job: a container, source code on a runtime image, or a host
  command."
---

# homerun_cron_job (Resource)

A scheduled job: a container, source code on a runtime image, or a host command.

## Example usage

```terraform
resource "homerun_cron_job" "example" {
  name     = "nightly-report"
  kind     = "image"
  schedule = "0 3 * * *"
  image    = "alpine"
  command  = "echo report"
  enabled  = true
}
```

## Schema

### Required

- `kind` (String) image (a container), script (source code on a runtime image)
  or exec (a host command, needs write access to System). Changing it replaces
  the resource.
- `name` (String)
- `schedule` (String)

### Optional

- `command` (String)
- `description` (String)
- `enabled` (Boolean) Defaults to `false`.
- `env_vars` (Map of String, Sensitive)
- `files` (List of Object) Text files written into the container before it
  starts. See the nested schema for `files` below.
- `image` (String)
- `registry_password` (String, Sensitive) Write-only: the API never returns it,
  so Terraform can't detect a change made outside it.
- `registry_url` (String)
- `registry_username` (String)
- `remote_host_id` (String)
- `runtime` (String) A script job's runtime: bun, node, deno, python or shell.
- `source` (String) A script job's source code.
- `tag` (String) Defaults to `"latest"`.
- `timeout_seconds` (Number) Defaults to `900`.

### Read-only

- `id` (String) The object's id.
- `registry_password_set` (Boolean)

### Nested schema for `files`

Required:

- `content` (String)
- `path` (String)

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_cron_job.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_cron_job.example "<id>"
```
