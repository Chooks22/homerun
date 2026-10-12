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

It reads: `list_services`, `get_service`, `get_service_config`, `service_logs`,
`list_deployments` (each deploy attempt's error and log), `list_revisions`,
`list_errors`, `get_error`, `list_dependencies`, `list_stacks`, `system_stats`,
`instance_status`, `list_volumes`, `list_backups`, `get_job`, `list_jobs`,
`list_redirects`, `list_object_stores`, `list_buckets` and `get_bucket`.

It changes: `update_service`, `set_dependencies`, `deploy_service`,
`restart_service`, `start_service`, `stop_service`, `rollback_service`,
`run_backup`, `create_redirect`, `update_redirect`, `delete_redirect`,
`create_bucket`, `update_bucket` (expiry and public access) and `delete_bucket`
(empty buckets only). Deleting a service is deliberately not a tool.

Every tool goes through the REST API with the caller's own permissions, checked
per call: a read-only account, or an API key with read permissions, can diagnose
but not change anything. Any signed-in account can connect, so what an agent can
do is what its account can do; see [Users and roles](users-and-roles.md).

## Secrets

Secrets don't reach the agent, the rest stays readable:

- An env var whose name has a secret-looking part (`PASSWORD`, `SECRET`,
  `TOKEN`, `KEY`, `CREDENTIAL`, `PRIVATE`, `SALT`…), or one marked secret by
  hand (see [Marking a variable secret](env-vars.md#marking-a-variable-secret)),
  shows as `[redacted]` regardless of its name.
- Any other value is shown as is, except a URL's password
  (`postgres://app:[redacted]@db:5432/app`).
- A `--requirepass` or `--password` argument in a command is also redacted, in
  logs too.

`update_service` merges env changes into what's stored: send only the vars to
change, `null` deletes one. A var sent back exactly as the agent read it, a
`[redacted]` value included, stays unchanged.

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
