---
page_title: "homerun_smtp_settings (Resource)"
description:
  "The SMTP server Homerun sends email through: sign-in codes and links,
  invites, notifications. There's exactly one: creating the resource adopts it
  and applies the attributes set, attributes left out keep their current value,
  and destroying it only removes it from the Terraform state, the instance keeps
  its settings."
---

# homerun_smtp_settings (Resource)

The SMTP server Homerun sends email through: sign-in codes and links, invites,
notifications. There's exactly one: creating the resource adopts it and applies
the attributes set, attributes left out keep their current value, and destroying
it only removes it from the Terraform state, the instance keeps its settings.

## Example usage

```terraform
resource "homerun_smtp_settings" "example" {
  enabled  = true
  host     = "smtp.example.com"
  port     = 587
  username = "homerun@example.com"
  password = var.smtp_password
  from     = "Homerun <homerun@example.com>"
}
```

## Schema

### Optional

- `enabled` (Boolean)
- `from` (String) The sender address.
- `host` (String)
- `password` (String, Sensitive) Left unset, the stored password stays.
  Write-only: the API never returns it, so Terraform can't detect a change made
  outside it.
- `port` (Number)
- `secure` (Boolean) Implicit TLS (port 465).
- `username` (String)

### Read-only

- `id` (String) The object's id.
- `password_set` (Boolean)

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_smtp_settings.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_smtp_settings.example "instance"
```
