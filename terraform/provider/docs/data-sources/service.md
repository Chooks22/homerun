---
page_title: "homerun_service (Data Source)"
description: "A service, by id or slug."
---

# homerun_service (Data Source)

A service, by id or slug.

## Example usage

```terraform
data "homerun_service" "example" {
  slug = "whoami"
}
```

## Schema

### Optional

- `id` (String) The object's id. Set it, or `slug`, to pick the object.
- `slug` (String) Subdomain and container name, unique. Required unless
  template_id is set.

### Read-only

- `auth_allowed_emails` (List of String) Addresses, or *@domain patterns, an
  account's email must match to get in. Empty lets any address through.
- `auth_allowed_groups` (List of String) OIDC groups (from a linked provider) or
  Homerun roles, one of which an account must have to get in. Empty skips the
  check.
- `auth_allowed_user_ids` (List of String) The only accounts let in, by id (a
  homerun_user or homerun_service_account id). Empty lets every account through
  the other rules; a service account only ever gets in when listed here.
- `auth_paths` (List of String)
- `auth_paths_mode` (String)
- `auth_providers` (List of String) Sign-in methods the wall offers: "password",
  "email-otp" (an emailed code), "magic-link" (an emailed link) and "oauth:"
  followed by a homerun_oauth_provider's name (oauth:pocket-id). Each must be
  enabled on the instance (the emailed ones in homerun_authentication_settings,
  with SMTP set up) or the API refuses it, and auth_required needs at least one.
  An emailed method proves only the mailbox, so it lets any Homerun account
  through unless auth_allowed_emails or auth_allowed_user_ids narrow it.
- `auth_required` (Boolean) Put the login wall in front of the app.
- `auto_deploy_on_push` (Boolean)
- `auto_rollback` (Boolean)
- `blocked_paths` (List of String)
- `build_cache_builtin` (Boolean) Use the built-in registry as the build cache.
- `build_cache_registry_id` (String)
- `build_server_remote_host_id` (String)
- `build_source` (String) image or git.
- `cap_add` (List of String)
- `category` (String)
- `channel_branch` (String)
- `channel_canary_domain` (String)
- `channel_tag_pattern` (String)
- `channels_enabled` (Boolean) Release channels: a canary built from
  channel_branch.
- `command` (List of String)
- `container_port` (Number) Required unless template_id is set.
- `cpu_limit` (String)
- `cron_enabled` (Boolean) Redeploy on cron_schedule.
- `cron_schedule` (String)
- `custom_ssl_set` (Boolean)
- `default_domain_enabled` (Boolean)
- `devices` (List of String)
- `dns_resolvable` (Boolean) Public routing through Traefik.
- `domain_ports` (Map of Number)
- `domains` (List of String) Custom domains. One may carry a path
  (example.com/api) to route only that path and what's under it.
- `entrypoint` (List of String)
- `env_files` (List of String)
- `env_vars` (Map of String, Sensitive)
- `environment_name` (String)
- `git_bake_file` (String)
- `git_build_context` (String)
- `git_build_method` (String)
- `git_build_target` (String)
- `git_dockerfile_path` (String)
- `git_ignore_paths` (List of String) Repo path globs whose changes alone never
  deploy on push.
- `git_poll_enabled` (Boolean)
- `git_provider_id` (String)
- `git_ref` (String)
- `git_repo` (String)
- `git_url` (String)
- `git_watch_paths` (List of String) Repo path globs a push has to change a file
  under to deploy. Empty lets every file through.
- `healthcheck_command` (String)
- `healthcheck_disabled` (Boolean)
- `healthcheck_interval_seconds` (Number)
- `healthcheck_retries` (Number)
- `healthcheck_start_period_seconds` (Number)
- `healthcheck_timeout_seconds` (Number)
- `http_cache_ttl` (Number)
- `icon` (String)
- `image` (String)
- `image_scan_enabled` (Boolean)
- `labels` (Map of String)
- `memory_limit_mb` (Number)
- `name` (String) Required unless template_id is set.
- `network_mode` (String)
- `port_protocol` (String)
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
- `preview_auth_required` (Boolean)
- `preview_branch_exclude` (List of String)
- `preview_branch_include` (List of String)
- `preview_copy_volumes` (Boolean)
- `preview_default_domain` (Boolean)
- `preview_domain_template` (String)
- `preview_env_overrides` (Map of String)
- `preview_inherit_env` (Boolean)
- `preview_report_github` (Boolean)
- `previews_enabled` (Boolean)
- `primary_domain` (String)
- `privileged` (Boolean)
- `published_ports` (List of Object) See the nested schema for `published_ports`
  below.
- `pull_policy` (String)
- `registry_password_set` (Boolean)
- `registry_url` (String)
- `registry_username` (String)
- `replicas` (Number)
- `require_status_checks` (Boolean)
- `required_status_checks` (List of String)
- `restart_policy` (String)
- `run_as_user` (String)
- `secret_env_keys` (List of String)
- `stack_id` (String)
- `strip_path_domains` (List of String) Domains with a path whose prefix is
  stripped before the request reaches the container (/api/v2 arrives as /v2).
- `tag` (String)
- `traces_enabled` (Boolean)
- `uptime_enabled` (Boolean)

### Nested schema for `published_ports`

Required:

- `container_port` (Number)
- `host_port` (Number)

Optional:

- `protocol` (String) Defaults to `"tcp"`.
