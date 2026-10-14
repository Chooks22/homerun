---
page_title: "homerun_oidc_app_environment (Resource)"
description:
  "One environment of a homerun_oidc_app, with its own callback URLs and
  authorized origins. A client secret only redeems codes sent to its own
  environment's callbacks."
---

# homerun_oidc_app_environment (Resource)

One environment of a homerun_oidc_app, with its own callback URLs and authorized
origins. A client secret only redeems codes sent to its own environment's
callbacks.

## Example usage

```terraform
resource "homerun_oidc_app_environment" "example" {
  app_id        = homerun_oidc_app.example.id
  name          = "production"
  redirect_uris = ["https://grafana.example.com/login/generic_oauth"]
}
```

## Schema

### Required

- `app_id` (String) Changing it replaces the resource.
- `name` (String) Up to 32 letters, digits, spaces, dots, dashes or underscores,
  unique per app: production, staging….
- `redirect_uris` (List of String) The callback URLs codes may be sent to, from
  the app's own OIDC settings: https, or http on localhost when allow_localhost
  is on.

### Optional

- `allow_localhost` (Boolean) Accept localhost callbacks and origins, for a
  development environment. Defaults to `false`.
- `allowed_origins` (List of String) Browser origins (scheme, host and port)
  allowed to call the token endpoint, for a SPA. Defaults to `[]`.

### Read-only

- `id` (String) The object's id.

## Import

Import an existing object by its `<app_id>/<id>`, with an `import` block:

```terraform
import {
  to = homerun_oidc_app_environment.example
  id = "<app_id>/<id>"
}
```

or the command line:

```shell
terraform import homerun_oidc_app_environment.example "<app_id>/<id>"
```
