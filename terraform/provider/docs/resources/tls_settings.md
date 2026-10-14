---
page_title: "homerun_tls_settings (Resource)"
description:
  "The instance certificate Traefik serves for every hostname it covers, instead
  of asking Let's Encrypt. Removing it is done from the dashboard. There's
  exactly one: creating the resource adopts it and applies the attributes set,
  attributes left out keep their current value, and destroying it only removes
  it from the Terraform state, the instance keeps its settings."
---

# homerun_tls_settings (Resource)

The instance certificate Traefik serves for every hostname it covers, instead of
asking Let's Encrypt. Removing it is done from the dashboard. There's exactly
one: creating the resource adopts it and applies the attributes set, attributes
left out keep their current value, and destroying it only removes it from the
Terraform state, the instance keeps its settings.

## Example usage

```terraform
resource "homerun_tls_settings" "example" {
  certificate = file("wildcard.example.com.pem")
  private_key = var.wildcard_private_key
}
```

## Schema

### Optional

- `certificate` (String, Sensitive) The certificate PEM, chain included.
  Write-only: the API never returns it, so Terraform can't detect a change made
  outside it.
- `private_key` (String, Sensitive) The private key PEM. Write-only: the API
  never returns it, so Terraform can't detect a change made outside it.

### Read-only

- `expires_at` (String)
- `id` (String) The object's id.
- `installed` (Boolean)
- `issuer` (String)
- `names` (List of String)

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_tls_settings.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_tls_settings.example "instance"
```
