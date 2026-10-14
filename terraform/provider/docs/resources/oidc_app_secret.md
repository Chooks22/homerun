---
page_title: "homerun_oidc_app_secret (Resource)"
description:
  "A client secret of a confidential homerun_oidc_app, for one of its
  environments. It's generated on create and kept in the state, so treat the
  state as a secret; rotate it by creating the new one before destroying the
  old."
---

# homerun_oidc_app_secret (Resource)

A client secret of a confidential homerun_oidc_app, for one of its environments.
It's generated on create and kept in the state, so treat the state as a secret;
rotate it by creating the new one before destroying the old.

## Example usage

```terraform
resource "homerun_oidc_app_secret" "example" {
  app_id         = homerun_oidc_app.example.id
  environment_id = homerun_oidc_app_environment.example.id
  label          = "grafana"
}
```

## Schema

### Required

- `app_id` (String) Changing it replaces the resource.
- `environment_id` (String) Changing it replaces the resource.

### Optional

- `label` (String) What the secret is for. Defaults to "Client secret". Changing
  it replaces the resource.

### Read-only

- `hint` (String) The secret's last four characters.
- `id` (String) The object's id.
- `secret` (String, Sensitive) The client secret, only known to a secret
  Terraform created: an imported one has none.

## Import

Import an existing object by its `<app_id>/<id>`, with an `import` block:

```terraform
import {
  to = homerun_oidc_app_secret.example
  id = "<app_id>/<id>"
}
```

or the command line:

```shell
terraform import homerun_oidc_app_secret.example "<app_id>/<id>"
```
