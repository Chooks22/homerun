---
page_title: "homerun_instance_settings (Resource)"
description:
  "The instance's General, Docker and Networking settings: base domain,
  dashboard URL, release channel, resource alerts, image scanning, orchestration
  mode and Traefik. There's exactly one: creating the resource adopts it and
  applies the attributes set, attributes left out keep their current value, and
  destroying it only removes it from the Terraform state, the instance keeps its
  settings."
---

# homerun_instance_settings (Resource)

The instance's General, Docker and Networking settings: base domain, dashboard
URL, release channel, resource alerts, image scanning, orchestration mode and
Traefik. There's exactly one: creating the resource adopts it and applies the
attributes set, attributes left out keep their current value, and destroying it
only removes it from the Terraform state, the instance keeps its settings.

## Example usage

```terraform
resource "homerun_instance_settings" "example" {
  base_domain        = "apps.example.com"
  update_channel     = "stable"
  traefik_acme_email = "ops@example.com"
}
```

## Schema

### Optional

- `auth_check_url` (String)
- `auth_cross_subdomain_cookies` (Boolean)
- `base_domain` (String) Each service gets a subdomain of it, named after its
  slug. A bare hostname.
- `cpu_hard_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `cpu_soft_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `dashboard_url` (String) The dashboard's URL, an origin with no path or
  trailing slash. Left unset, it's derived from base_domain.
- `default_ui_mode` (String) simple or advanced.
- `disk_hard_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `disk_soft_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `docker_network_name` (String)
- `docker_socket_path` (String)
- `gpu_hard_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `gpu_soft_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `image_scan_block_fixable_only` (Boolean)
- `image_scan_block_severity` (String) CRITICAL, HIGH, MEDIUM or LOW: refuse to
  deploy an image with a finding this severe or worse.
- `image_scan_enabled` (Boolean)
- `image_scan_required` (Boolean)
- `memory_hard_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `memory_soft_threshold` (Number) A usage percentage that alerts, 1 to 100.
- `orchestration_mode` (String) standalone or swarm. Changing it prepares the
  host (joins or leaves swarm mode).
- `resource_alert_reminder_minutes` (Number)
- `resource_alert_sustain_seconds` (Number)
- `retained_images_per_service` (Number)
- `service_subdomain` (String) One DNS label services' default hostnames go
  under, `slug.service_subdomain.base_domain`. Left unset, they're
  `slug.base_domain`.
- `traefik_acme_email` (String)
- `traefik_cert_resolver` (String)
- `traefik_dynamic_config_dir` (String)
- `traefik_entrypoint` (String)
- `traefik_http_cache` (Boolean)
- `update_channel` (String) stable, canary or nightly.

### Read-only

- `id` (String) The object's id.

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_instance_settings.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_instance_settings.example "instance"
```
