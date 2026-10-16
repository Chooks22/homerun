---
page_title: "homerun_volume (Resource)"
description: "A storage volume and its backup settings."
---

# homerun_volume (Resource)

A storage volume and its backup settings.

## Example usage

```terraform
resource "homerun_volume" "example" {
  name              = "postgres-data"
  kind              = "volume"
  source            = "postgres-data"
  backup_enabled    = true
  backup_schedule   = "0 2 * * *"
  s3_destination_id = homerun_backup_destination.example.id
}
```

## Schema

### Required

- `kind` (String) bind (a host path) or volume (a Docker volume). Changing it
  replaces the resource.
- `name` (String)
- `source` (String) The host path, or the Docker volume's name. Changing it
  replaces the resource.

### Optional

- `backup_enabled` (Boolean) Defaults to `false`.
- `backup_pre_command` (String)
- `backup_pre_command_service_id` (String)
- `backup_prefix` (String)
- `backup_schedule` (String)
- `backup_stop_services` (Boolean) Defaults to `false`.
- `description` (String)
- `s3_destination_id` (String)

### Read-only

- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_volume.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_volume.example "<id>"
```
