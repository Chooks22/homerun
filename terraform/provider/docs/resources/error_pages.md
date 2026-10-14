---
page_title: "homerun_error_pages (Resource)"
description:
  "The branded pages Traefik shows instead of its own errors, and the login
  wall's branding. There's exactly one: creating the resource adopts it and
  applies the attributes set, attributes left out keep their current value, and
  destroying it only removes it from the Terraform state, the instance keeps its
  settings."
---

# homerun_error_pages (Resource)

The branded pages Traefik shows instead of its own errors, and the login wall's
branding. There's exactly one: creating the resource adopts it and applies the
attributes set, attributes left out keep their current value, and destroying it
only removes it from the Terraform state, the instance keeps its settings.

## Example usage

```terraform
resource "homerun_error_pages" "example" {
  brand_name   = "Acme"
  accent_color = "#8b2942"
  page_texts = {
    notFoundTitle = "Nothing to see here"
  }
}
```

## Schema

### Optional

- `accent_color` (String) Like #8b2942.
- `brand_name` (String)
- `logo_url` (String)
- `page_texts` (Map of String) Titles and messages by key: notReadyTitle,
  notReadyMessage, unavailableTitle, unavailableMessage, notFoundTitle,
  notFoundMessage, blockedTitle, blockedMessage. One left out shows the default.
- `show_powered_by` (Boolean)

### Read-only

- `id` (String) The object's id.

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_error_pages.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_error_pages.example "instance"
```
