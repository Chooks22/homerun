---
page_title: "homerun_domain (Resource)"
description:
  "A domain Homerun manages, optionally linked to a DNS connection's zone."
---

# homerun_domain (Resource)

A domain Homerun manages, optionally linked to a DNS connection's zone.

## Example usage

```terraform
resource "homerun_domain" "example" {
  name          = "example.com"
  connection_id = homerun_dns_connection.example.id
  zone_id       = "023e105f4ecef8ad9ca31a8372d0c353"
  target        = "203.0.113.10"
}
```

## Schema

### Required

- `name` (String) Changing it replaces the resource.

### Optional

- `auto_records` (Boolean) Create and remove the records of services' hostnames
  under it. Defaults to `true`.
- `connection_id` (String) The DNS connection the domain's zone lives in.
- `dns_challenge` (Boolean) Issue its certificates through an ACME DNS-01
  challenge, one wildcard for the domain, instead of HTTP-01. Defaults to
  `false`.
- `target` (String) What its services' records point at, an IP or a hostname.
  Unset points them at the base domain.
- `zone_id` (String) The provider's zone id. Required with connection_id.
- `zone_name` (String) Looked up from the connection when left out.

### Read-only

- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_domain.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_domain.example "<id>"
```
