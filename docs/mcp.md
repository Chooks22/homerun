# MCP server for AI agents

Homerun serves an [MCP](https://modelcontextprotocol.io) server, so an AI agent
such as Claude can diagnose and fix your services for you: read their logs,
deploys and settings, change them, redeploy, roll back.

| What           | Value                                                                      |
| -------------- | -------------------------------------------------------------------------- |
| MCP URL        | `https://<your dashboard>/api/v1/mcp`                                      |
| Transport      | Streamable HTTP                                                            |
| Sign-in        | OAuth 2.1 with PKCE, or an API key in the `x-api-key` header               |
| Client sign-up | Client ID Metadata Documents, or a client an admin registered on **IDP**   |
| Acts as        | The account that signed in, or the API key's owner, with their permissions |

It only runs when the Dashboard URL is `https` (or plain HTTP on `localhost`),
since MCP clients refuse anything else; on any other address the endpoint
answers 404 saying so. The dashboard also has to be reachable from wherever the
agent runs: for claude.ai that's the public internet.

## Connecting an agent

An agent connects one of three ways: pick the first one it supports.

### Paste the URL (Client ID Metadata Documents)

An MCP client that supports
[Client ID Metadata Documents](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
(CIMD, the client registration method of the MCP authorization spec) needs
nothing more than the MCP URL. Add it as a connector or server in the agent, and
the agent sends you to Homerun's sign-in page. Sign in, then Homerun asks
whether to allow it, and from then on it acts as you.

The client identifies itself with an HTTPS URL instead of a client ID, and
Homerun reads its name and callback addresses from the document at that URL. A
document can claim any name, so the consent screen also shows the site it came
from: only allow it when that's the site of the agent you're connecting. Once
allowed, the client shows up on the **IDP** page like any other app.

### A client an admin registers (client ID and secret)

For an agent that asks for a client ID and secret instead, an admin registers
one first. On the **IDP** page (under Integrations), click **Register app**. For
claude.ai and Claude Desktop, click **Claude connector**: it fills in Claude's
callback URL, a confidential client with PKCE and the consent screen on. Then
click **Register app**, and the next screen shows the MCP URL, client ID and
secret. In Claude, open Settings → Connectors → Add custom connector, paste the
MCP URL, and the client ID and secret under Advanced settings.

The **Claude connector** button only shows once the Dashboard URL is `https` (or
plain HTTP on `localhost`).

### An API key (Claude Code and other headless agents)

No OAuth at all: create a key under **Profile → API Keys** and send it in the
`x-api-key` header. A key with read permissions only gives an agent that can
diagnose but not change anything.

```bash
claude mcp add --transport http homerun \
  https://<your dashboard>/api/v1/mcp --header "x-api-key: <key>"
```

## What it can do

| Area                    | Reads                                                                                                                                                                 | Changes                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services                | `list_services`, `get_service`, `get_service_config`, `service_logs`, `list_deployments` (each deploy attempt's error and log), `list_revisions`, `list_dependencies` | `create_service` (from scratch or a template), `update_service`, `set_dependencies`, `deploy_service`, `restart_service`, `start_service`, `stop_service`, `rollback_service`                                                                                                                             |
| Errors                  | `list_errors`, `get_error`                                                                                                                                            | `update_error` (resolve, ignore or reopen an issue)                                                                                                                                                                                                                                                       |
| Stacks and templates    | `list_stacks`, `get_stack`, `list_templates`, `get_template`                                                                                                          | `create_stack`, `update_stack`                                                                                                                                                                                                                                                                            |
| Environments and canary | `list_environments`, `get_release_channels`                                                                                                                           | `create_environment`, `update_environment`, `set_release_channels`                                                                                                                                                                                                                                        |
| Pull request previews   | `list_previews`, `get_preview`                                                                                                                                        | `promote_preview`                                                                                                                                                                                                                                                                                         |
| Image scans             | `list_scans`, `get_scan` (with its findings)                                                                                                                          | `scan_service`                                                                                                                                                                                                                                                                                            |
| Volumes and backups     | `list_volumes`, `list_volume_mounts`, `list_backups`, `list_backup_destinations`                                                                                      | `create_volume`, `update_volume` (its backup settings too), `mount_volume`, `update_volume_mount`, `unmount_volume`, `run_backup`                                                                                                                                                                         |
| Cron jobs               | `list_cron_jobs`, `get_cron_job`, `list_cron_job_runs`, `get_cron_job_run` (a run's output)                                                                           | `create_cron_job`, `update_cron_job` (`enabled` turns its schedule on or off), `delete_cron_job`, `run_cron_job`                                                                                                                                                                                          |
| Queue and instance      | `get_job`, `list_jobs`, `system_stats`, `instance_status`                                                                                                             |                                                                                                                                                                                                                                                                                                           |
| Redirects               | `list_redirects`                                                                                                                                                      | `create_redirect`, `update_redirect`, `delete_redirect`                                                                                                                                                                                                                                                   |
| Object storage          | `list_object_stores`, `list_buckets`, `get_bucket`                                                                                                                    | `create_bucket`, `update_bucket` (expiry and public access), `delete_bucket` (empty buckets only)                                                                                                                                                                                                         |
| Status pages            | `list_status_pages`                                                                                                                                                   | `create_status_page`, `update_status_page`, `delete_status_page`                                                                                                                                                                                                                                          |
| Notifications           | `list_notifications` (your own feed, the dashboard's bell), `list_notification_channels`                                                                              | `mark_notifications_read`, `create_notification_channel`, `update_notification_channel`, `delete_notification_channel`                                                                                                                                                                                    |
| Workstations            | `list_workstations`, `get_workstation`, `list_workstation_presets`, `get_workstation_preset`                                                                          | `create_workstation`, `update_workstation` (its login wall too), `start_workstation`, `stop_workstation`, `recreate_workstation`, `delete_workstation` (`deleteVolume` drops the home volume), `create_workstation_preset`, `update_workstation_preset` (its login wall too), `delete_workstation_preset` |
| Versions and updates    | `get_service_version` (an image service's pin and the update its last check found, with its trial run), `find_pin_tags`                                               | `pin_service`, `unpin_service`, `set_update_watch`, `check_service_updates`, `apply_service_update` (moves it onto the update and deploys)                                                                                                                                                                |
| Monitoring              | `get_monitoring` (the instance's traffic, availability and resources, per service), `get_service_monitoring` (with its latest uptime probe beats)                     |                                                                                                                                                                                                                                                                                                           |
| System                  | `list_system_logs` (Homerun's own warnings and errors), `list_system_containers`, `system_container_logs` (Traefik's included), `preview_docker_cleanup`              | `run_docker_cleanup` (every prune but volumes)                                                                                                                                                                                                                                                            |
| DNS                     | `list_domains`, `list_dns_records`, `list_dns_connections` (no credentials)                                                                                           | `create_dns_record`, `update_dns_record`, `delete_dns_record`                                                                                                                                                                                                                                             |
| Docker registry         | `list_registry_repositories` (images with their tags, digests and the services using them), `list_registry_tags`, `get_registry_settings`, `list_registry_tokens`     |                                                                                                                                                                                                                                                                                                           |
| Admin config            | `list_remote_hosts`, `list_users`, `list_git_providers`, all read only                                                                                                |                                                                                                                                                                                                                                                                                                           |

Deleting a service, a stack or an environment is deliberately not a tool: do it
from the dashboard. Neither are pruning volumes, deleting registry images, IaC
or updating Homerun. Workstations are the caller's own, like everywhere else,
and never come with their IDE password.

### Credentials and access stay on the dashboard

An agent reads admin config but never changes what holds a credential or grants
access: DNS connections, git providers, object stores, remote hosts, registry
tokens, users and sign-in. Those tools return metadata only (names, kinds,
endpoints, which secret fields are set), never a secret, and no tool creates,
changes or deletes them. Connecting one means pasting a secret into the
conversation, where it lands in the agent's context and its provider's logs; and
an agent able to swap DNS credentials, mint registry tokens or change a user's
role can widen its own reach, which a prompt injection in a log line or an error
it reads could ask for. Do those from the dashboard, the CLI, the REST API or
Terraform. DNS records are the one write here: they hold no secret, and creating
one is part of putting a service online.

Every tool goes through the REST API with the caller's own permissions, checked
per call: a read-only account, or an API key with read permissions, can diagnose
but not change anything. Any signed-in account can connect, so what an agent can
do is what its account can do; see [Users and roles](users-and-roles.md).

## Secrets

Secrets don't reach the agent, the rest stays readable:

- An env var of a service or a cron job marked secret by hand (see
  [Marking a variable secret](env-vars.md#marking-a-variable-secret)) shows as
  `[redacted]`, whatever its name or value.
- The same goes for an env var whose name has a secret-looking part (`PASSWORD`,
  `SECRET`, `TOKEN`, `KEY`, `AUTH`, `COOKIE`, `SIGNING`, `CREDENTIAL`,
  `PRIVATE`, `SALT`…), unless its last part only configures one
  (`OIDC_AUTH_URL`, `BASIC_AUTH_ENABLED`, `AUTH_PROVIDER`, `PRIVATE_KEY_FILE`)
  or its value is a plain boolean or number (`ENABLE_PASSWORD_FORM=false`).
- And so does a value that looks like a credential, whatever its name: a
  `user:token` pair with 16 or more letters and digits after the colon, or a
  standalone token of 24 or more characters mixing upper case, lower case and
  digits (not a URL, path, image, hostname or version).
- Any other value is shown as is, except its inline secrets: a URL's password
  (`postgres://app:[redacted]@db:5432/app`, `user:[redacted]@github.com`), a
  `--requirepass` or `--password` argument, a `Bearer` or `Basic` credential, a
  sensitive query parameter (`?code=`, `&state=`, `?token=`, `?api_key=`,
  `?X-Amz-Signature=`…) and a bare `token=`, `password=` or `api_key=`
  assignment. Logs get the same: service logs, deploy and job logs, the system
  log, a cron job's command and a cron job run's output.
- In a cron job's script source and its files, a line setting a secret-looking
  name (`API_TOKEN=…`, `export DB_PASSWORD=…`, `password: …`,
  `const apiKey = …`) has its value redacted, and every other line its inline
  secrets.
- An error event from [error tracking](error-tracking.md) has its request URL,
  query string and breadcrumb URLs and messages masked the same way, and its
  `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` and other
  credential-carrying headers and its cookies redacted.
- A service's uploaded icon shows as `uploaded` instead of its image data.

A workstation's and a workstation preset's `env` are redacted the same way, by
name and by value.

`update_service`, `update_cron_job`, `update_workstation` and
`update_workstation_preset` merge env changes into what's stored: send only the
vars to change, `null` deletes one. A var, a command, a cron job's source or one
of its files sent back exactly as the agent read it, a `[redacted]` value
included, stays unchanged, and so does an icon sent back as `uploaded`.

## Revoking access

Every OAuth client, registered by an admin or discovered from its URL, is on the
**IDP** page. From an app's page, revoke one person's tokens or everyone's, or
switch the app off: its tokens stop working and nobody can sign in through it
until it's back on. Switch off a discovered client rather than deleting it:
deleting one only lasts until it next signs someone in, since its URL is all it
needs to come back. An API key is revoked under **Profile → API Keys**.

## For client developers

Homerun follows the
[MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization):

- An unauthenticated call gets a `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://<your dashboard>/.well-known/oauth-protected-resource/api/v1/mcp"`.
- That protected resource metadata names the authorization server, whose
  metadata is at
  `https://<your dashboard>/.well-known/oauth-authorization-server/issuer`
  (issuer `https://<your dashboard>/issuer`). It advertises
  `client_id_metadata_document_supported: true` and no `registration_endpoint`:
  dynamic client registration (RFC 7591) is turned off, so a client can't create
  itself a stored client ID and secret.
- Authorization is the code flow with PKCE (`S256`). Pass the MCP URL as the
  `resource` parameter: the access token is a JWT whose audience is that URL,
  which is what the MCP endpoint checks. Scopes: `openid`, `profile`, `email`,
  `offline_access` (for a refresh token) and `groups`.
- A metadata document's URL must be `https`, resolve only to public addresses (a
  private, loopback or link-local address is refused with `invalid_client`
  before anything is fetched), and answer without a redirect. The document needs
  `client_id` equal to its own URL, `client_name` and `redirect_uris`, and its
  `token_endpoint_auth_method` must be `none` or `private_key_jwt`: a shared
  secret makes no sense in a public document. Homerun keeps a fetched document
  for up to an hour, honouring its cache headers, then fetches it again.

## Troubleshooting

- **The MCP URL answers 404**: the Dashboard URL isn't `https`. Set it under
  **Settings → General**.
- **A connector says it can't authenticate**: the agent doesn't support metadata
  documents. Register a client for it, as in
  [A client an admin registers](#a-client-an-admin-registers-client-id-and-secret),
  and give it the client ID and secret.
- **`invalid_client` with "must not target a private or reserved address"**: the
  client's metadata document URL points at a private network. Agents on your LAN
  need an API key instead.
- **Tools answer 403**: the account (or the API key) lacks the permission that
  tool needs. The agent can only do what that account can do.
