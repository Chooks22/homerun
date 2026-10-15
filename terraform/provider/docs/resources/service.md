---
page_title: "homerun_service (Resource)"
description:
  "A service: one container (or swarm service) and every setting the dashboard
  shows for it."
---

# homerun_service (Resource)

A service: one container (or swarm service) and every setting the dashboard
shows for it.

## Example usage

```terraform
resource "homerun_service" "example" {
  name           = "whoami"
  slug           = "whoami"
  stack_id       = homerun_stack.example.id
  image          = "traefik/whoami"
  container_port = 80
  env_vars = {
    LOG_LEVEL = "info"
  }
  deploy_on_change = true
}
```

## Schema

### Optional

- `auth_allowed_emails` (List of String) Addresses, or *@domain patterns, an
  account's email must match to get in. Empty lets any address through.
- `auth_allowed_groups` (List of String) OIDC groups (from a linked provider) or
  Homerun roles, one of which an account must have to get in. Empty skips the
  check.
- `auth_allowed_user_ids` (List of String) The only accounts let in, by id (a
  homerun_user or homerun_service_account id). Empty lets every account through
  the other rules; a service account only ever gets in when listed here.
- `auth_paths` (List of String)
- `auth_paths_mode` (String) Defaults to `"all"`.
- `auth_providers` (List of String) Sign-in methods the wall offers: "password",
  "email-otp" (an emailed code), "magic-link" (an emailed link) and "oauth:"
  followed by a homerun_oauth_provider's name (oauth:pocket-id). Each must be
  enabled on the instance (the emailed ones in homerun_authentication_settings,
  with SMTP set up) or the API refuses it, and auth_required needs at least one.
  An emailed method proves only the mailbox, so it lets any Homerun account
  through unless auth_allowed_emails or auth_allowed_user_ids narrow it.
- `auth_required` (Boolean) Put the login wall in front of the app. Defaults to
  `false`.
- `auto_deploy_on_push` (Boolean) Defaults to `false`.
- `auto_rollback` (Boolean) Defaults to `false`.
- `blocked_paths` (List of String)
- `build_cache_builtin` (Boolean) Use the built-in registry as the build cache.
  Defaults to `false`.
- `build_cache_registry_id` (String)
- `build_env_keys` (List of String)
- `build_server_remote_host_id` (String)
- `build_source` (String) image or git. Defaults to `"image"`.
- `cap_add` (List of String)
- `category` (String)
- `channel_branch` (String)
- `channel_canary_domain` (String)
- `channel_tag_pattern` (String) Defaults to `"v*"`.
- `channels_enabled` (Boolean) Release channels: a canary built from
  channel_branch. Defaults to `false`.
- `command` (List of String)
- `container_port` (Number) Required unless template_id is set.
- `cpu_limit` (String)
- `cron_enabled` (Boolean) Redeploy on cron_schedule. Defaults to `false`.
- `cron_schedule` (String)
- `custom_ssl_cert` (String, Sensitive) Write-only: the API never returns it, so
  Terraform can't detect a change made outside it.
- `custom_ssl_key` (String, Sensitive) Write-only: the API never returns it, so
  Terraform can't detect a change made outside it.
- `default_domain_enabled` (Boolean) Defaults to `true`.
- `deploy_on_change` (Boolean) Deploy after every create or change, and wait for
  the deploy to finish. Defaults to `false`.
- `devices` (List of String)
- `dns_resolvable` (Boolean) Public routing through Traefik. Defaults to `true`.
- `domain_ports` (Map of Number)
- `domains` (List of String) Custom domains. One may carry a path
  (example.com/api) to route only that path and what's under it.
- `entrypoint` (List of String)
- `env_files` (List of String)
- `env_vars` (Map of String, Sensitive)
- `environment_name` (String)
- `git_bake_file` (String)
- `git_build_context` (String)
- `git_build_method` (String) Defaults to `"dockerfile"`.
- `git_build_target` (String)
- `git_dockerfile_path` (String)
- `git_ignore_paths` (List of String) Repo path globs whose changes alone never
  deploy on push.
- `git_poll_enabled` (Boolean) Defaults to `false`.
- `git_provider_id` (String)
- `git_ref` (String)
- `git_repo` (String)
- `git_url` (String)
- `git_watch_paths` (List of String) Repo path globs a push has to change a file
  under to deploy. Empty lets every file through.
- `healthcheck_command` (String)
- `healthcheck_disabled` (Boolean) Defaults to `false`.
- `healthcheck_interval_seconds` (Number)
- `healthcheck_retries` (Number)
- `healthcheck_start_period_seconds` (Number)
- `healthcheck_timeout_seconds` (Number)
- `http_cache_ttl` (Number)
- `icon` (String)
- `image` (String)
- `image_scan_enabled` (Boolean) Defaults to `true`.
- `labels` (Map of String)
- `memory_limit_mb` (Number)
- `name` (String) Required unless template_id is set.
- `network_mode` (String) Defaults to `"bridge"`.
- `port_protocol` (String) Defaults to `"tcp"`.
- `preview_auth_allowed_emails` (List of String) Addresses, or *@domain
  patterns, an account's email must match to get in. Empty lets any address
  through.
- `preview_auth_allowed_groups` (List of String) OIDC groups (from a linked
  provider) or Homerun roles, one of which an account must have to get in. Empty
  skips the check.
- `preview_auth_allowed_user_ids` (List of String) The only accounts let in, by
  id (a homerun_user or homerun_service_account id). Empty lets every account
  through the other rules; a service account only ever gets in when listed here.
- `preview_auth_providers` (List of String) Sign-in methods the wall offers:
  "password", "email-otp" (an emailed code), "magic-link" (an emailed link) and
  "oauth:" followed by a homerun_oauth_provider's name (oauth:pocket-id). Each
  must be enabled on the instance (the emailed ones in
  homerun_authentication_settings, with SMTP set up) or the API refuses it, and
  preview_auth_required needs at least one. An emailed method proves only the
  mailbox, so it lets any Homerun account through unless
  preview_auth_allowed_emails or preview_auth_allowed_user_ids narrow it.
- `preview_auth_required` (Boolean) Defaults to `false`.
- `preview_branch_exclude` (List of String)
- `preview_branch_include` (List of String)
- `preview_copy_volumes` (Boolean) Defaults to `false`.
- `preview_default_domain` (Boolean) Defaults to `true`.
- `preview_domain_template` (String)
- `preview_env_overrides` (Map of String)
- `preview_inherit_env` (Boolean) Defaults to `true`.
- `preview_report_github` (Boolean) Defaults to `true`.
- `preview_uptime_enabled` (Boolean) Probe each pull request preview's uptime.
  Applied when a preview is created or redeployed. Defaults to `false`.
- `previews_enabled` (Boolean) Defaults to `false`.
- `primary_domain` (String)
- `privileged` (Boolean) Defaults to `false`.
- `published_ports` (List of Object) See the nested schema for `published_ports`
  below.
- `pull_policy` (String) Defaults to `"always"`.
- `registry_password` (String, Sensitive) Write-only: the API never returns it,
  so Terraform can't detect a change made outside it.
- `registry_url` (String)
- `registry_username` (String)
- `replicas` (Number) Defaults to `1`.
- `require_status_checks` (Boolean) Defaults to `false`.
- `required_status_checks` (List of String)
- `restart_policy` (String) Defaults to `"unless-stopped"`.
- `run_as_user` (String)
- `scale_to_zero_minutes` (Number)
- `secret_env_keys` (List of String)
- `slug` (String) Subdomain and container name, unique. Required unless
  template_id is set.
- `stack_id` (String)
- `strip_path_domains` (List of String) Domains with a path whose prefix is
  stripped before the request reaches the container (/api/v2 arrives as /v2).
- `tag` (String) Defaults to `"latest"`.
- `template_id` (String) Create the service from this template (its image,
  variables, volumes and linked services), then apply the other attributes.
  Changing it replaces the service, unless it was imported without one. Sent on
  create only and never read back: changing it replaces the resource, unless it
  was imported without one.
- `traces_enabled` (Boolean) Defaults to `false`.
- `update_check_enabled` (Boolean) Image services: watch the registry for a
  newer release of tag, or a new image behind a floating tag. The
  homerun_service_version data source reads what it found. Defaults to `false`.
- `update_trial_enabled` (Boolean) Image services: try each update in a
  throwaway container before notifying it. Defaults to `true`.
- `uptime_enabled` (Boolean)

### Read-only

- `custom_ssl_set` (Boolean)
- `id` (String) The object's id.
- `pinned_from_tag` (String) The floating tag the service was pinned from on the
  dashboard, the API or the CLI. Pinning here is setting tag.
- `pinned_locally` (Boolean)
- `registry_password_set` (Boolean)

### Nested schema for `published_ports`

Required:

- `container_port` (Number)
- `host_port` (Number)

Optional:

- `protocol` (String) Defaults to `"tcp"`.

## Import

Import an existing object by its id, with an `import` block:

```terraform
import {
  to = homerun_service.example
  id = "<id>"
}
```

or the command line:

```shell
terraform import homerun_service.example "<id>"
```
