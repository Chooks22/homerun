---
page_title: "homerun_dns_record (Resource)"
description:
  "A DNS record at a domain's provider. Every change replaces it, since some
  providers derive a record's id from its value."
---

# homerun_dns_record (Resource)

A DNS record at a domain's provider. Every change replaces it, since some
providers derive a record's id from its value.

## Example usage

```terraform
resource "homerun_dns_record" "example" {
  domain_id = homerun_domain.example.id
  name      = "mail.example.com"
  type      = "MX"
  content   = "mx.mailprovider.com"
  priority  = 10
}
```

## Schema

### Required

- `content` (String) The value: an address, a hostname without the trailing dot,
  or unquoted text. Changing it replaces the resource.
- `domain_id` (String) Changing it replaces the resource.
- `name` (String) The full name, like `www.example.com`, or the domain itself
  for its apex: what the provider answers with. Changing it replaces the
  resource.
- `type` (String) A, AAAA, CNAME, TXT, MX or CAA. Changing it replaces the
  resource.

### Optional

- `priority` (Number) MX only, 10 when unset. Changing it replaces the resource.
- `ttl` (Number) Seconds from 60 to 86400, automatic when unset. Changing it
  replaces the resource.

### Read-only

- `id` (String) The object's id.
- `managed` (Boolean)
- `record_id` (String)

## Import

Import an existing object by its `<domain_id>/<record_id>`, with an `import`
block:

```terraform
import {
  to = homerun_dns_record.example
  id = "<domain_id>/<record_id>"
}
```

or the command line:

```shell
terraform import homerun_dns_record.example "<domain_id>/<record_id>"
```
