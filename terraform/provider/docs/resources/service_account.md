---
page_title: "homerun_service_account (Resource)"
description:
  "A service account: a non-human user with no sign-in method. Put its id in a
  service's auth_allowed_user_ids or preview_auth_allowed_user_ids to let its
  API keys through that login wall. Its keys are minted from the dashboard or
  the API, never here, so no secret lands in the state."
---

# homerun_service_account (Resource)

A service account: a non-human user with no sign-in method. Put its id in a
service's auth_allowed_user_ids or preview_auth_allowed_user_ids to let its API
keys through that login wall. Its keys are minted from the dashboard or the API,
never here, so no secret lands in the state.

## Example usage

```terraform
resource "homerun_service_account" "example" {
  name = "ci-smoke-tests"
  permissions = {
    services = "read"
  }
}
```

## Schema

### Required

- `name` (String)

### Optional

- `disabled` (Boolean) Refuse the account's API keys without deleting it.
  Defaults to `false`.
- `permissions` (Map of String) The areas the account may use, each set to read
  or write. Areas: services, workstations, stacks, templates, cron-jobs,
  redirects, status-pages, storage, object-storage, registry, build-cache,
  git-providers, notifications, dns, remote-hosts, system, iac, users, settings.
  The API cuts them down to what the provider's own API key holds. Defaults to
  `{}`.

### Read-only

- `id` (String) The object's id.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_service_account.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_service_account.example "<id>"
```
