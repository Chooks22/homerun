---
page_title: "homerun_notification_channel (Resource)"
description: "Where notifications are sent."
---

# homerun_notification_channel (Resource)

Where notifications are sent.

## Example usage

```terraform
resource "homerun_notification_channel" "example" {
  name   = "ops"
  kind   = "discord"
  target = var.discord_webhook_url
}
```

## Schema

### Required

- `kind` (String) webhook, discord, slack, telegram or email. Changing it
  replaces the resource.
- `name` (String)
- `target` (String, Sensitive) The webhook URL, email address, or Telegram
  bot_token:chat_id. Write-only: the API never returns it, so Terraform can't
  detect a change made outside it.

### Optional

- `enabled` (Boolean) Defaults to `true`.
- `events` (List of String)
- `group_messages` (Boolean) Defaults to `false`.

### Read-only

- `id` (String) The object's id.
- `target_label` (String)

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_notification_channel.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_notification_channel.example "<id>"
```
