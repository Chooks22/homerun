---
page_title: "homerun_service_version (Data Source)"
description:
  "An image service's version pin and its last update check, by the service's
  id."
---

# homerun_service_version (Data Source)

An image service's version pin and its last update check, by the service's id.

## Example usage

```terraform
data "homerun_service_version" "example" {
  id = homerun_service.whoami.id
}
```

## Schema

### Optional

- `id` (String) The object's id, which picks it. Required.

### Read-only

- `available_digest` (String)
- `available_found_at` (String)
- `available_tag` (String) The update the last check found, null when it's up to
  date. Set the service's tag to it to apply it.
- `check_error` (String)
- `checked_at` (String)
- `image` (String)
- `pinned` (Boolean)
- `pinned_from_tag` (String)
- `pinned_locally` (Boolean)
- `tag` (String)
- `trial_at` (String)
- `trial_message` (String)
- `trial_status` (String) The update's trial run: running, passed or failed.
- `trial_tag` (String)
- `update_check_enabled` (Boolean)
- `update_trial_enabled` (Boolean)
