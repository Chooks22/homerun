---
page_title: "homerun_authentication_settings (Resource)"
description:
  'How people sign in: the emailed code and link methods, the methods the
  sign-in page features, and the passkey and two-factor requirements. email_otp
  is what a service''s login wall needs to offer "email-otp" in auth_providers,
  and both emailed methods need SMTP configured (homerun_smtp_settings).
  There''s exactly one: creating the resource adopts it and applies the
  attributes set, attributes left out keep their current value, and destroying
  it only removes it from the Terraform state, the instance keeps its settings.'
---

# homerun_authentication_settings (Resource)

How people sign in: the emailed code and link methods, the methods the sign-in
page features, and the passkey and two-factor requirements. email_otp is what a
service's login wall needs to offer "email-otp" in auth_providers, and both
emailed methods need SMTP configured (homerun_smtp_settings). There's exactly
one: creating the resource adopts it and applies the attributes set, attributes
left out keep their current value, and destroying it only removes it from the
Terraform state, the instance keeps its settings.

## Example usage

```terraform
resource "homerun_authentication_settings" "example" {
  email_otp          = true
  magic_link         = false
  require_two_factor = true
}
```

## Schema

### Optional

- `email_otp` (Boolean) Sign in with a code sent by email.
- `magic_link` (Boolean) Sign in with a link sent by email.
- `preferred_sign_in_methods` (List of String) The methods the sign-in page
  features, in order: password, passkey, or oauth: followed by a provider name.
- `require_passkey` (Boolean)
- `require_two_factor` (Boolean)

### Read-only

- `id` (String) The object's id.
- `smtp_configured` (Boolean)

## Import

There's only one, so its import id is always `instance`. Import it with an
`import` block:

```terraform
import {
  to = homerun_authentication_settings.example
  id = "instance"
}
```

or the command line:

```shell
terraform import homerun_authentication_settings.example "instance"
```
