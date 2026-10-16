---
page_title: "homerun_backup_destination (Resource)"
description: "Where volume backups are written."
---

# homerun_backup_destination (Resource)

Where volume backups are written.

## Example usage

```terraform
resource "homerun_backup_destination" "example" {
  name              = "offsite"
  endpoint          = "https://s3.eu-central-1.amazonaws.com"
  bucket            = "homerun-backups"
  access_key_id     = var.backup_access_key_id
  secret_access_key = var.backup_secret_access_key
}
```

## Schema

### Required

- `access_key_id` (String)
- `endpoint` (String)
- `name` (String)
- `secret_access_key` (String, Sensitive) Write-only: the API never returns it,
  so Terraform can't detect a change made outside it.

### Optional

- `backup_keep` (Number)
- `bucket` (String)
- `region` (String)
- `type` (String) s3, sftp, smb or webdav. Changing it replaces the resource.
  Defaults to `"s3"`.

### Read-only

- `id` (String) The object's id.
- `secret_access_key_set` (Boolean)

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_backup_destination.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_backup_destination.example "<id>"
```
