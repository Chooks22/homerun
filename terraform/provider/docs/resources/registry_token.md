---
page_title: "homerun_registry_token (Resource)"
description:
  "A token that can push to and pull from the built-in Docker registry, once its
  auth is on (homerun_registry_settings). Its secret is generated on create and
  kept in the state, so treat the state as a secret."
---

# homerun_registry_token (Resource)

A token that can push to and pull from the built-in Docker registry, once its
auth is on (homerun_registry_settings). Its secret is generated on create and
kept in the state, so treat the state as a secret.

## Example usage

```terraform
resource "homerun_registry_token" "example" {
  username = "ci"
}
```

## Schema

### Required

- `username` (String) The docker login user: 3 to 32 lowercase letters, digits,
  dashes or underscores. Changing it replaces the resource.

### Read-only

- `id` (String) The object's id.
- `secret` (String, Sensitive) The docker login password, only known to a token
  Terraform created: an imported one has none.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_registry_token.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_registry_token.example "<id>"
```
