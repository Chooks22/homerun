---
page_title: "homerun_ip_ban_settings (Resource)"
description:
  "When a client address hitting services' blocked paths gets banned, and the
  CrowdSec LAPI bans are pushed to. There's exactly one: creating the resource
  adopts it and applies the attributes set, attributes left out keep their
  current value, and destroying it only removes it from the Terraform state, the
  instance keeps its settings."
---

# homerun_ip_ban_settings (Resource)

When a client address hitting services' blocked paths gets banned, and the
CrowdSec LAPI bans are pushed to. There's exactly one: creating the resource
adopts it and applies the attributes set, attributes left out keep their current
value, and destroying it only removes it from the Terraform state, the instance
keeps its settings.

## Example usage

```terraform
resource "homerun_ip_ban_settings" "example" {
  enabled        = true
  threshold      = 10
  duration_hours = 24
}
```

## Schema

### Optional

- `crowdsec_machine_id` (String)
- `crowdsec_password` (String, Sensitive) Left unset, the stored password stays.
  Write-only: the API never returns it, so Terraform can't detect a change made
  outside it.
- `crowdsec_url` (String)
- `disrespect_mode` (Boolean)
- `duration_hours` (Number) How long a ban lasts, 0 for forever.
- `enabled` (Boolean)
- `mean_mode` (Boolean)
- `threshold` (Number) Blocked requests before a ban, 1 to 1000.
- `window_minutes` (Number)

### Read-only

- `crowdsec_password_set` (Boolean)
- `id` (String) The object's id.

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_ip_ban_settings.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_ip_ban_settings.example "instance"
```
