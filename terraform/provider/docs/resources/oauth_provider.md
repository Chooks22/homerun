---
page_title: "homerun_oauth_provider (Resource)"
description:
  "An OAuth/OIDC provider people sign in with (Authentication → Providers).
  Applied as soon as it's saved. A login wall offers it as the method oauth:
  followed by its name."
---

# homerun_oauth_provider (Resource)

An OAuth/OIDC provider people sign in with (Authentication → Providers). Applied
as soon as it's saved. A login wall offers it as the method oauth: followed by
its name.

## Example usage

```terraform
resource "homerun_oauth_provider" "example" {
  name          = "pocket-id"
  label         = "Pocket ID"
  client_id     = var.pocket_id_client_id
  client_secret = var.pocket_id_client_secret
  discovery_url = "https://id.example.com/.well-known/openid-configuration"
}
```

## Schema

### Required

- `client_id` (String)
- `discovery_url` (String) The provider's OpenID discovery document
  (…/.well-known/openid-configuration). Every save fetches it, and refuses one
  that doesn't answer with an issuer.
- `name` (String) Lowercase letters, digits and hyphens. It ends the redirect
  URI to register with the provider (the dashboard URL, then
  /api/v1/auth/callback/ and the name) and makes the login wall method "oauth:"
  followed by the name. Changing it replaces the provider. Changing it replaces
  the resource.

### Optional

- `client_secret` (String, Sensitive) Write-only: the API never returns it, so
  Terraform can't detect a change made outside it.
- `enabled` (Boolean) Defaults to `true`.
- `label` (String) Shown on the "Continue with" button. Defaults to name.
- `pkce` (Boolean) Defaults to `true`.
- `scopes` (List of String) Defaults to `["openid","profile","email"]`.
- `sign_out_of_provider` (Boolean) Signing out of Homerun also signs out of the
  provider (RP-initiated logout). Defaults to `false`.
- `token_auth_method` (String) How the client secret reaches the token endpoint:
  auto (HTTP Basic when the provider advertises it, else the request body),
  basic or post. Defaults to `"auto"`.

### Read-only

- `client_secret_set` (Boolean)
- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_oauth_provider.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_oauth_provider.example "<id>"
```
