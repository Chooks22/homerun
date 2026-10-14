---
page_title: "homerun_user (Resource)"
description:
  "A person's account. It's created without a password, like Users → Add user:
  its owner picks one at their first sign-in, after an emailed code when SMTP is
  configured (without SMTP, anyone who knows the address can claim it first).
  Destroying it hands what the user created over to the provider's own account;
  the last admin and the provider's own account can't be destroyed. Service
  accounts are homerun_service_account."
---

# homerun_user (Resource)

A person's account. It's created without a password, like Users → Add user: its
owner picks one at their first sign-in, after an emailed code when SMTP is
configured (without SMTP, anyone who knows the address can claim it first).
Destroying it hands what the user created over to the provider's own account;
the last admin and the provider's own account can't be destroyed. Service
accounts are homerun_service_account.

## Example usage

```terraform
resource "homerun_user" "example" {
  email = "jane@example.com"
  name  = "Jane"
  role  = "custom"
  permissions = {
    services = "write"
    stacks   = "read"
  }
}
```

## Schema

### Required

- `email` (String)
- `name` (String)

### Optional

- `permissions` (Map of String) Only with role custom: the areas the user may
  use, each set to read or write. Areas: services, workstations, stacks,
  templates, cron-jobs, redirects, status-pages, storage, object-storage,
  registry, build-cache, git-providers, notifications, dns, remote-hosts,
  system, iac, users, settings. Switching to custom without it starts from the
  previous role's permissions.
- `role` (String) One of admin, developer, viewer, app-user, custom. viewer is
  read-only, app-user only gets through the login walls that let them in, custom
  holds the permissions set here. The last admin can't be demoted. Defaults to
  `"developer"`.

### Read-only

- `email_verified` (Boolean)
- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_user.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_user.example "<id>"
```
