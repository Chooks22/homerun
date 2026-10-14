---
page_title: "homerun_registry_settings (Resource)"
description:
  "The built-in Docker registry's auth and public hostname. Each change
  recreates the registry container and waits for it. There's exactly one:
  creating the resource adopts it and applies the attributes set, attributes
  left out keep their current value, and destroying it only removes it from the
  Terraform state, the instance keeps its settings."
---

# homerun_registry_settings (Resource)

The built-in Docker registry's auth and public hostname. Each change recreates
the registry container and waits for it. There's exactly one: creating the
resource adopts it and applies the attributes set, attributes left out keep
their current value, and destroying it only removes it from the Terraform state,
the instance keeps its settings.

## Example usage

```terraform
resource "homerun_registry_settings" "example" {
  auth_enabled = true
  public_host  = "registry.example.com"
}
```

## Schema

### Optional

- `auth_enabled` (Boolean) Require a token to push or pull.
- `public_host` (String) Publish the registry at this hostname through Traefik.
  Needs auth_enabled.

### Read-only

- `id` (String) The object's id.

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_registry_settings.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_registry_settings.example "instance"
```
