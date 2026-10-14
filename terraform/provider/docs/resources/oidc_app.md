---
page_title: "homerun_oidc_app (Resource)"
description:
  'An app that signs people in with their Homerun account ("Sign in with
  Homerun", Authentication → Sign in with Homerun). Nobody can sign in until it
  has a homerun_oidc_app_environment with its callback URLs; a confidential app
  also needs a homerun_oidc_app_secret.'
---

# homerun_oidc_app (Resource)

An app that signs people in with their Homerun account ("Sign in with Homerun",
Authentication → Sign in with Homerun). Nobody can sign in until it has a
homerun_oidc_app_environment with its callback URLs; a confidential app also
needs a homerun_oidc_app_secret.

## Example usage

```terraform
resource "homerun_oidc_app" "example" {
  name              = "Grafana"
  confidential      = true
  token_auth_method = "client_secret_basic"
}
```

## Schema

### Required

- `name` (String)

### Optional

- `confidential` (Boolean) A confidential app (a server) authenticates with a
  client secret (homerun_oidc_app_secret); a public one (a SPA or mobile app)
  has none and always uses PKCE. Changing it replaces the app, and with it the
  client id. Changing it replaces the resource. Defaults to `true`.
- `disabled` (Boolean) Refuse new sign-ins without deleting the app. Defaults to
  `false`.
- `enable_end_session` (Boolean) Let the app sign people out of Homerun
  (RP-initiated logout). Defaults to `false`.
- `require_pkce` (Boolean) Require a PKCE challenge on every sign-in. A public
  app can't turn it off. Defaults to `true`.
- `skip_consent` (Boolean) Sign people in without asking them to share their
  profile. Defaults to `false`.
- `token_auth_method` (String) How a confidential app sends its secret to the
  token endpoint: client_secret_basic (HTTP Basic, the default) or
  client_secret_post (request body, what Claude's connector uses). Leave it
  unset on a public app.

### Read-only

- `client_id` (String) The client id to configure the app with.
- `discovery_url` (String) The OpenID discovery document to point the app at,
  empty until the Dashboard URL is set.
- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_oidc_app.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_oidc_app.example "<id>"
```
