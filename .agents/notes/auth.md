# Auth, users, login wall

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Auth (`src/lib/services/auth.ts`)

better-auth at `basePath: "/api/v1/auth"`, `drizzleAdapter` over the same
Postgres `db`. `src/hooks.server.ts` populates `event.locals.user`/`session`
from the cookie session, falling back to manual
`x-api-key`/`Authorization: Bearer` verification when no cookie is present:
`auth.api.verifyApiKey()` confirms the key, then the owning user is looked up
**directly by `result.key.referenceId`** via a plain drizzle query, deliberately
_not_ through `getSession()`'s API-key session-mocking, which is gated behind
the `apiKey()` plugin's `enableSessionForAPIKeys` option (default `false`, and
better-auth's own docs advise against enabling it in production). This is what
makes `x-api-key`/`Bearer` auth work for `src/routes/api/v1/*` (see REST API
above).

## Permissions, roles and API keys (`src/lib/permissions.ts`, `src/lib/server/access-gate.ts`)

Access is a `Permissions` map: 18 areas (`PERMISSION_AREAS`, each with its
label, description and the dashboard/API route prefixes it owns), each `read` or
`write` (write includes read, `can()`). Roles (`USER_ROLES`: `admin`,
`developer`, `viewer` labelled "Read-only", `app-user`, `custom`, see
`ROLE_OPTIONS`) are presets: `permissionsForRole(role, stored)` returns
all-write, the developer preset (`DEVELOPER_PERMISSIONS`), the same areas at
read, nothing, or for `custom` the user's own `user.permissions` jsonb (added in
migration 0109, parsed through `parsePermissions`, which drops unknown areas and
levels). `/users` validates roles against that list; invites and direct-create
only offer the presets, the Permissions button on a custom user's row posts
`?/setPermissions` with one `permission.<area>` field per area
(`permissionsFromForm`, the `PermissionPicker` component), and switching to
custom seeds from the previous role's permissions. Write on `users` can grant
anything, itself included, which is deliberate and documented as
admin-equivalent. `system` is the host-level area: the host terminal, system
logs, Docker cleanup, host-command cron jobs and the
privileged/devices/capabilities/env-file service options (and templates and
compose imports needing them).

**Where it's enforced, outermost first.**

- **`hooks.server.ts`'s `authHandler` sets `locals.permissions`** (the role's
  permissions, or for an API key those intersected with the key's own, see
  below) and runs `permissionRejection` (`access-gate.ts`) before resolving.
  `requiredPermission(method, routeId)` maps SvelteKit's matched route id to an
  area from `PERMISSION_AREAS[].routes` and a level (read for GET/HEAD/OPTIONS,
  write otherwise); `OPEN_ROUTES` (overview, `/profile`, `/cli-auth`,
  `/api-docs`, better-auth, `/api/v1/mcp`, webhooks, readiness and a few more)
  need nothing, and a route no area claims comes back `"unmapped"`, which only a
  holder of every permission gets through. **A new route under `(protected)` or
  `/api/v1` must be added to an area's `routes` (or `OPEN_ROUTES`), or it's
  admin-only.** That one gate covers form actions, remote commands
  (`/_app/remote/...` POSTs) and the REST API. The response is shaped per caller
  (`forbidden()`): a devalue `ActionResult` failure for a `use:enhance` post, a
  remote-function error body, `{error}` JSON for `/api/`, plain text otherwise,
  with `permissionDeniedMessage(area, level)`.
- **Dashboard page reads are not refused by the hook**: `permissionRejection`
  lets a plain page GET through, and the `(protected)` layout load does the
  check for the matched route and renders the 403 as an error page. The sidebar
  and global search filter with `mayVisit(permissions, href)`.
- **`requirePermission(area, level)` (`remote-auth.ts`)** in remote functions
  under `src/lib/remote/`, replacing the old `requireWriter()`: it throws a 403
  error and returns the user, so queries and commands whose route the hook can't
  attribute to the right area name theirs explicitly.
- **`can(locals.permissions, area, level)`** inside a route, for a sub-concern
  of a page that spans areas: host access (`src/lib/host-access.ts`, the
  privileged/devices/capabilities/env-file options, needs write on `system`),
  host-command cron jobs, and similar.

**API keys** store their permissions in better-auth's `apikey.permissions`
(`toApiKeyPermissions` shape: area to `[level]`). A key created with "Allow all
permissions" stores none, and `applyApiKeyAuth` then gives it whatever the owner
holds, later grants included; otherwise `intersectPermissions(owner, key)`, so a
key never outlives a demotion. Profile → API Keys (`profile/api-keys/`) refuses
a key requesting more than its creator holds and takes an expiry from
`API_KEY_EXPIRY_OPTIONS` (7, 30, 90 (default), 365 days or never, with a warning
in the form); better-auth refuses an expired key. `homerun login` (CLI device
flow) keys are all-permissions with no expiry. Migration 0109 turned the old
`metadata.scope = "read"` keys into read on every area, and keys without a scope
had no permissions stored, so they became "all permissions". The OpenAPI
document (`src/lib/openapi/build.ts`) declares a 403 on every route.

`user.deleteUser` is enabled with a `beforeDelete` hook (thin wrapper around
`src/lib/services/user.service.ts`'s `UserService.cleanupUserResources()`, see
User roles & invitations below), don't assume better-auth's default
account-deletion behavior is sufficient; it isn't, by design of this app's extra
tables (see Data model above).

`config.auth.crossSubdomainCookies` (`auth.crossSubdomainCookies` in
`homerun.yaml`, default off, also DB-editable, see Instance settings above) sets
better-auth's `advanced.crossSubDomainCookies` to scope the session cookie to
`.{baseDomain}` instead of the exact host, see the per-service auth gate below
for why, and its documented, tested limitation.

**`advanced.useSecureCookies` is set explicitly from the `ORIGIN` env var's
scheme, and it has to be.** Real, reproduced bug, not a precaution: sign-in on
an instance reached over plain HTTP at a bare IP (`http://<ip>:3000`, exactly
what the installer's `--mode=full` produces) returned 200 and toasted "Signed in
successfully", but the button stayed stuck on "Signing in…" forever and the user
never reached the dashboard. better-auth derives the secure-cookie flag through
a fallback chain (`cookies/index.mjs`'s `createCookieGetter`): explicit
`useSecureCookies`, else `baseURL`'s protocol, else **`isProduction`**. This app
deliberately never pins `baseURL` (see the long comment in `auth.ts` for the
lockout that causes), so a deployed container (`NODE_ENV=production`) fell
through to `isProduction` and issued
`__Secure-better-auth.session_token; Secure`. A browser on plain HTTP at a bare
IP silently **discards** that cookie twice over : `Secure` requires a secure
context (only `localhost`/`127.0.0.1` are exempt, an IP is not), and the
`__Secure-` prefix independently requires both. So the POST succeeded, no cookie
was ever stored, `locals.user` stayed empty on the next request, the sign-in
page's `load` never threw its `redirect(302, resolve(""))`, `refreshAll()` had
no redirect to act on, and `loading` is only ever reset in `catch` or
`onNavigate` : hence a success toast over a permanently spinning button.
**Verified by A/B against a real production build on a real LAN IP**, reading
the actual `Set-Cookie`: pre-fix + `ORIGIN=http://<ip>:3000` →
`__Secure-…; Secure`; fixed → `better-auth.session_token` with no `Secure`;
fixed + `ORIGIN=https://…` → `__Secure-…; Secure` again, so an HTTPS deployment
is not downgraded. The full chain was then driven end to end: sign-in stores the
cookie, `get-session` returns the session, and `/auth/sign-in`'s data request
answers `{"type":"redirect","location":"../../"}`, which is what `client.js`'s
`_invalidate` turns into the `_goto` that un-sticks the button. The branch is
skipped entirely when `ORIGIN` is unset, leaving better-auth's own
`isProduction` default rather than guessing.

**It reads `process.env.ORIGIN`, never `config.auth.origin`, and that
distinction is load-bearing.** The first version of this fix derived the flag
from `config.auth.origin`, which is a _mutable, user-editable setting_ : saving
it calls `applyInstanceSettings()` + `rebuildAuth()`, and flipping
`useSecureCookies` renames the cookie (`better-auth.session_token` ↔
`__Secure-better-auth.session_token`), so every live session is instantly
unreadable. Concretely, and caught by e2e rather than by reading the code :
onboarding's "Use HTTPS" checkbox defaults to **on** whenever
`settings.authOrigin` is still null (a fresh instance), so clicking through the
wizard with defaults saved `https://…`, flipped the flag, renamed the cookie,
and **signed the admin out onto `/auth/sign-in` at the exact moment they
finished setting the instance up**. `ORIGIN` is the right source because it is
how the app is actually _served_ (compose.prod.yaml requires it, the installer
sets it, the e2e harness sets it) and is immutable for the process lifetime, so
no settings save can ever rename a cookie out from under a signed-in user. If a
deployment genuinely changes scheme, that's a restart, which is the correct
blast radius for a cookie-security change.

**Direct access on an IP or `localhost` gets its own auth instance.** With
`ORIGIN=https://…` (or cross-subdomain cookies on), signing in at
`http://<ip>:3000` failed at the 2FA step with "Invalid two factor cookie": the
`two_factor` challenge cookie came out `__Secure-…; Secure` (or
`Domain=.<baseDomain>`), which the browser drops on that origin. The exported
`auth` is a proxy that picks, per request (`getRequestEvent()`), a variant built
by `buildAuth(directAccessScheme(host, x-forwarded-proto))` : `Secure` only over
HTTPS, never scoped to the base domain. Named hosts keep the configured
instance, so the rule above is unchanged for them.

Rate limiting is on outside `vite dev`: 100 requests per IP per 15 minutes
overall, plus the `apiKey()` plugin's own 3000/minute per key. A key over it
gets a 429 with `Retry-After`: `verifyApiKey` reports the refusal as
`{ valid: false, error: { code: "RATE_LIMITED" } }` instead of throwing, which
`hooks.server.ts` used to turn into a 401, so a growing integration suite on one
key failed at random with "Unauthorized". **Real, tested finding**: better-auth
also applies an undocumented-in-config "special rule" (its
`rate-limiter/index.mjs`'s `getDefaultSpecialRules`) capping any
`/sign-in`/`/sign-up`-prefixed path at 3 requests per 10 seconds, well below
that `max`/`window` and unaffected by them, which a handful of `tests/e2e/`
specs signing in and out against a real production build tripped immediately.
`HOMERUN_DISABLE_AUTH_RATE_LIMIT=1` turns rate limiting off for that reason
(better-auth's and `sign-in.remote.ts`'s own per-IP `throttle`, which the E2E
suite's ~60 sign-ins as one user also trip), set only by
`tests/e2e/support/bootstrap-runtime.ts`'s spawned app, never in production,
same test-only-escape-hatch shape as `HOMERUN_SKIP_INTEGRATION_SETUP`.

`user.changeEmail` is enabled (`enabled: true`,
`updateEmailWithoutVerification: true`) so `/profile`'s email field is editable,
and the two account states take genuinely different paths through better-auth's
`changeEmail` endpoint (`update-user.mjs`): an **unverified** address writes the
new email (and re-sets the session cookie) immediately, synchronously, no
confirmation step, because `updateEmailWithoutVerification: true` only ever
applies when `session.user.emailVerified !== true`. A **verified** address is
untouched in the DB at request time regardless of that flag, better-auth only
creates a verification token and calls `sendChangeEmailConfirmation` (mailed via
`EmailService` to the _current_ address, not the new one); the row only changes
once the user follows that link to `/verify-email`. Both mail callbacks
(`emailVerification.sendVerificationEmail` and `changeEmail`'s
`sendChangeEmailConfirmation`) return early with a warn log when
`!isSmtpEnabled()`, rather than letting `EmailService`'s constructor throw the
way it does everywhere else. `sendOnSignUp` already gates the sign-up case, but
`changeEmail` reaches both callbacks off the mere _presence_ of
`sendVerificationEmail` (`canSendVerification`), whatever the SMTP settings say.
Two different things happen to a throw from there, and neither is useful: inside
`changeEmail` both callbacks go through `runInBackgroundOrAwait`, which catches
and logs (`create-context.mjs`), so the endpoint still answers
`{ status: true }` and the failure is invisible to the caller; but
`/send-verification-email` calls `sendVerificationEmailFn` which awaits the
callback directly, where the same throw is a 500. Returning early makes the skip
explicit in the log in both cases.

What actually keeps a user out of the resulting dead end is the page, not the
server: `src/routes/(protected)/profile/+page.server.ts` exposes `smtpEnabled`
(`isSmtpEnabled()`), and `/profile` disables the email field, with an
explanation, for a **verified** account while SMTP is off — that account's
address can't be changed at all without a confirmation link, and better-auth
would otherwise report success while doing nothing.

The `betterAuth({...})` call is wrapped in `buildAuth()` rather than assigned
once to a `const`, `export let auth = buildAuth()`, plus
`export function rebuildAuth()` which reassigns `auth = buildAuth()`. This is
what makes OAuth provider changes saved on `/settings` apply live: every
consumer (`hooks.server.ts`'s
`auth.api.getSession`/`svelteKitHandler({ auth, ... })`) reads `auth.*`
per-request rather than destructuring it at import time, so ES module
live-bindings mean a reassignment inside `auth.ts` is immediately visible
everywhere without a restart. `rebuildAuth()` is called at the end of
`hooks.server.ts`'s `init()` and every `/settings` action.

## App-access-only role (`app-user`, `/my-apps`)

`app-user` (labelled "App access only", `APP_ONLY_ROLE`) is for people who
should only get through chosen apps' login walls, typically a client reviewing a
pull request preview. Roles are a plain `text` column, so the value needed no
migration; `schema.ts`'s `UserRole` type alias (used only by the invitation row)
still lists three roles, so `InvitationDTO.create` casts. **Enforcement is one
gate in `hooks.server.ts`, like permissions, but it covers reads too.**
`authHandler` sets `locals.appOnly` and runs `appOnlyRejection`
(`access-gate.ts`) before resolving; `appOnlyMayRequest` (`permissions.ts`)
decides from the path and SvelteKit's matched `event.route.id` (already set when
`handle` runs): any route under `/(protected)` or `/onboarding` is refused,
every other page (`/auth/*`, `/app-auth`, `/security-setup`, `/my-apps`, public
status pages) is allowed; under `/api/` only `/api/v1/auth/*` (minus `api-key/`,
`admin/` and `cli/`), `/api/health` and `/api/v1/ready`; remote functions only
the sign-in page's three commands, by export name. A refused page GET is a 303
to `/my-apps`, and a refused `__data.json` gets SvelteKit's own
`{"type":"redirect"}` JSON so client-side navigation (sign-in's `goto("/")`)
follows it instead of choking on a 303; everything else gets the same 403 shapes
with `APP_ONLY_MESSAGE`. Belt and braces: the `(protected)` layout load
redirects to `/my-apps`, `requireUser()` throws 403, and
`applyApiKeyAuth`/`applyMcpTokenAuth` refuse a key or MCP token owned by an
app-only user outright (so a key minted under an earlier role dies with the role
change); a banned user's key or token is refused too (`isBanned`, which respects
`banExpires`) until the ban is lifted or runs out. Homerun as an OIDC provider
stays open to app-only users (`/api/v1/auth/oauth2/*`, `/auth/consent`): that's
an app login, the point of the role; its client-management endpoints are
admin-checked by better-auth.

`/my-apps` is a top-level `AuthShell` page (outside `(protected)`): the apps
from `AppAccessService.sharedApps(userId)` (every `authRequired` service whose
full `evaluate()` passes, one evaluate per gated service, turned into links by
the pure `sharedAppLinks`: primary hostname over https, previews with PR
number/title), plus `TwoFactorPanel`/`PasskeyPanel` and sign-out. It enforces
the instance's 2FA/passkey requirement itself via
`/security-setup?next=/my-apps`. An account without a password gets **Set a
password** there (see Emailed codes and links); password change and session
management are not on it (better-auth's endpoints would allow them, there's just
no UI). The Security tab's user picker lists every account with its role label.
**Preview access policy**: `service.previewAuth*` (required, providers, allowed
user ids/emails/groups, `ServiceDTO.previewAccessPolicy`) is the wall every pull
request preview of a service gets, independent of the service's own `auth*`.
`PreviewService#create`/`#refresh` apply it on top of `mirroredSettings` (which
still carries the parent's own wall, deliberately: the release-channel canary
mirrors that one), and `applyAccessPolicy` re-applies it to open previews when
Environments & Deployments → Previews saves it, invalidating the gate cache and
redeploying only the ones whose wall flipped (`redeployIfLoginWallChanged`). The
form and its validation are shared with the Security tab:
`src/lib/components/login-wall-section.svelte` (`action`/`subject`/`title`
props) and `src/lib/server/login-wall-form.ts` (`parseLoginWallForm`,
`loginWallAvailability`, `loginWallOptions`). Migration 0074 copies each
service's own wall into its preview policy so previews that were gated through
the old mirroring stay gated.

## Service accounts (`user.type`, `ServiceAccountService`, `audit_log`)

A service account is a `user` row with `type = 'service-account'` (migration
0130, default `'human'`; `#lib/user-types.ts`), role `custom` and
`user.permissions` `{}` unless an admin grants areas. Its email is a
placeholder, `<id>@service-account.homerun.invalid`, because the column is
unique and not null. **The one thing that keeps it from signing in is auth.ts's
`databaseHooks.session.create.before`**, which returns `false` for it, so
better-auth refuses every path that ends in a session (password, emailed code or
link, passkey, OAuth, admin impersonation) with `FAILED_TO_CREATE_SESSION`. The
integration suite proves it by having an admin set the account a password and
watching sign-in fail. `email-sign-in.ts` also never mails a code or link to a
placeholder address.

`hooks.server.ts`: `applyApiKeyAuth` refuses a disabled (banned) service
account's key with a 403 before setting `locals.user` (a banned human's key too,
with its own message; a service account's refusal is also audited);
`authHandler` then runs `serviceAccountRejection` (`access-gate.ts`), which lets
it reach `/app-auth` and only the routes owned by an area it was granted, so
`OPEN_ROUTES` (overview, profile, MCP, notifications…) are closed to it;
`permissionRejection` still does the level. `serviceAccountAuditHandler`,
sequenced before `authHandler`, writes every request its key makes to
`audit_log` (`AuditLogDTO`, amortized prune at 20000 rows, `actorId` set null on
delete, `actorName` kept); `/app-auth` writes its own `gate.handshake` entry
naming the app instead. `AppAccessService.evaluate` lets a service account
through only when the wall lists its id, skipping the email, provider and group
rules (its key is the method), and `/app-auth` skips the "no usable method"
screen for it. `UserService.listUsersPaged`, `searchUsers`, `#successorFor` and
`NotificationDTO.broadcast` leave service accounts out; `listUsers` keeps them
so login-wall pickers offer them. API keys have no FK to `user`, so
`ServiceAccountService.delete` deletes the account's keys itself. The CLI's
`homerun gate session` never follows redirects and only sends the key once the
challenge points at its own configured server.

## Base domain vs. Dashboard URL, and why they're two things

`instance_settings.baseDomain` and `auth.origin` answer different questions, and
collapsing them caused a real, reported breakage. **Base domain is the DNS
suffix deployed services are routed under** : `labels.ts` interpolates it into a
Traefik `Host()` rule as `<slug>` dot `<baseDomain>`, and a host rule cannot
contain a port. **Dashboard URL (`auth.origin`) is where this app itself is
reached**, scheme and port included, and it's what the OAuth redirect URI and
the login wall's redirects are built from. In production the two coincide
(`example.com`→`<https://example.com`>); **in development they diverge**,
because the dashboard runs on `http://localhost:5173` while services are routed
by Traefik on 443 as `<slug>.localhost`.

Origin used to be derived as `scheme://baseDomain` with no separate field, and
`normalizeBaseDomain` explicitly permitted an optional `:port`. So getting the
origin right for dev forced `localhost:5173` into Base domain, which then became
the routing suffix : every service rendered as `<slug>.localhost:5173`, a URL
that hits the **Vite dev server** rather than Traefik, which served the
dashboard under that hostname, found no session cookie for it, and bounced to
`/auth/sign-in`. That's the bug, and nothing about it looked like a domain
problem from the outside.

Now: `normalizeBaseDomain` returns `{domain, port}` and **the port is moved to
the origin instead of the routing name**, so pasting `localhost:5173` (or a full
URL) into Base domain does the right thing silently rather than corrupting
routing. `applyCoreOverride` also strips any port from `config.baseDomain` at
boot, so an instance that already stored one is correct without needing a
re-save. Settings gained an explicit optional **Dashboard URL** field for the
cases derivation can't express. **A blank Dashboard URL means "derive it"**, and
that is load-bearing : `authOrigin` is always persisted, derived or not, so a
naive `value={settings.authOrigin}` pre-fills the field and then silently
overrides a later Base domain edit — caught by a browser test, not by reading
the code. The field renders blank whenever the stored origin equals
`scheme://baseDomain`, and shows the placeholder as a hint.

**Auth-check URL default**: when the app itself runs in a container attached to
the Docker network (installer `--mode=full`), `hooks.server.ts`'s `init()`
resolves it via `DockerService.selfContainer()` to
`http://homerun-auth:<PORT>/api/v1/auth-check` when the app's endpoint on the
Homerun network carries the `homerun-auth` alias (the installer's and
`compose.prod.yaml`'s app service both declare it), else
`http://<container name>:<PORT>/api/v1/auth-check`, through
`setDetectedAuthCheckUrl` (a `homerun.yaml` `authCheckUrl` still wins, a DB
override still wins over both). Real bug this fixes: the old
`host.docker.internal` default doesn't resolve inside a Linux Traefik container
(`lookup host.docker.internal on 127.0.0.11:53: no such host`), so every login
wall 500'd on a real install. The dev compose files also give Traefik
`extra_hosts: host.docker.internal:host-gateway` for the bare-metal case.
Services deployed before the fix keep the old URL in their labels until
redeployed.

**Dev-mode port**: outside a container, `config.authCheckUrl` defaults to
`http://host.docker.internal:${PORT}/api/v1/auth-check` with `PORT` defaulting
to 3000. `vite dev` serves on 5173 (or the next free port) and doesn't set
`PORT`, so `vite.config.ts`'s `listeningPortPlugin` hooks the dev and preview
servers' `listening` event and writes the bound port into `process.env.PORT`.
That works because SvelteKit's dev middleware only loads the server modules (and
so evaluates `src/lib/config.ts`) on the first request, which is always after
`listening`. **Don't "fix" this by deriving the port from `auth.origin`**
instead: that is only the same port in dev. Behind a reverse proxy the origin is
443 while the app listens on 3000, so deriving would break production to fix
development.

## Authentication pages (`/authentication`, `src/lib/auth-providers.ts`)

Admin-only, its own sidebar item under Administration. It **replaced** the old
`/settings/authentication` tab (that route is gone; `/settings` is down to four
tabs), so there's one place editing `instance_settings.oauthProviders`.

**It follows the list + `new/` + `[id]` shape every other entity uses**
(services, stacks, storage), not a single page of inline expanding forms. The
first cut was that inline page and it was wrong on every axis the user cared
about : one provider looked like _the_ provider, deleting had no confirmation,
and the whole thing lived in one whole-array `updateOauth` action whose seven
parallel `formData.getAll()` arrays had to stay index-aligned between collapsed
and expanded rows. The route split deleted that fragility outright : each page
edits exactly one provider through `addOauthProvider`/`updateOauthProvider`/
`deleteOauthProvider` on the DTO, and `src/lib/server/oauth-provider-form.ts`
parses one provider from one form. Providers still live in the
`instance_settings.oauthProviders` jsonb array rather than their own table, so
the route param is the provider **name**, which is why the name is immutable
once created (it's in the redirect URI and in every service's `oauth:<name>`
method reference). Deletion goes through `ConfirmDialog` with the provider name
as the typed phrase, same as the service danger zone.

**`label` vs `name`.** `name` is the machine id (lowercase, hyphens, part of the
redirect URI and of `oauth:<name>`); `label` is the human name shown on the
"Continue with …" button, the per-service Access checkbox list and the provider
list. `label` falls back to `name` everywhere it's read, so providers stored
before it existed keep working.

**Signing out of the provider is opt-in, off by default** (`signOutOfProvider`).
better-auth picks `end_session_endpoint` straight out of the discovery document
(`endSessionEndpoint ??= discovered.end_session_endpoint`) and performs
RP-initiated logout by default, so signing out of Homerun bounced the user to
their IdP's logout page without anyone having configured it. The provider config
now always passes `disableProviderLogout: !signOutOfProvider`, so the default is
a local sign-out and the redirect only happens when an admin ticks the box.

- **One save path.** `OauthProviderConfigService` (add/update/remove) runs
  `checkOauthProvider` (the discovery fetch included) then `applyAndRebuild`,
  for both the Authentication pages and `/api/v1/oauth-providers`.
- **Presets.** `OAUTH_PRESETS` (`src/lib/auth-providers.ts`, a pure module, also
  home to the method-id encoding and the email matcher) carries a discovery-URL
  template, default scopes and PKCE default for Pocket ID, Keycloak, Authelia,
  Logto, Authentik, Zitadel and Kanidm. Clicking one appends a prefilled
  provider row with `{host}`/`{realm}`/`{slug}`/`{clientId}` placeholders left
  in for the admin to replace; "Blank" is still there for anything else. The
  templates are the products' own documented discovery paths, which differ more
  than you'd guess (Logto nests under `/oidc`, Authentik under
  `/application/o/<slug>`, Kanidm under `/oauth2/openid/<client id>`).
- The page prints the exact redirect URI to register with the provider
  (`<origin>/api/v1/auth/callback/<provider id>`), and says so explicitly when
  `config.auth.origin` isn't set yet rather than printing a broken URL.
- Provider **names must be unique** and renaming one silently drops it from any
  service that referenced it as `oauth:<name>`, so the save action rejects
  duplicates and the UI shows a per-provider "used by N apps" count.
- A "Protected apps" panel lists services with the wall on, flagging any with no
  sign-in method picked, and deep-links to each one's Security tab.

**The OAuth redirect URI comes from the request, and both halves of the exchange
must agree.** better-auth builds the authorize step's `redirect_uri` from the
provider's optional `redirectURI`, but the **token exchange ignores it
entirely** and rebuilds the URI from `context.baseURL` (see
`api/routes/callback.mjs`, which interpolates `c.context.baseURL` with the
callback path), and that is derived per-request because `auth.ts` deliberately
leaves `baseURL` undefined — see Auth above for the lockout that causes. **Real
bug, introduced and reverted in one session**: pinning only `redirectURI` to
`config.auth.origin` made the authorize step stable but desynced it from the
token step, turning a `redirect_uri ... is not registered` error into
`invalid_code`, since OAuth requires the two to match byte for byte. Don't pin
one half. The request origin is the single source of truth for both, and the fix
for "it points at the wrong hostname" is to make the user reach Homerun at the
right one : that's what the Base domain / Dashboard URL split above and the
canonicalization below are for. The original report (a `dashy.localhost:5173`
callback not being registered) turned out to be the _same_ root cause as the
layout bug — a port in Base domain sending the browser to the dev server under a
service hostname — and fixing that fixes the redirect URI without pinning
anything.

**Client authentication on the token exchange is selectable per provider**
(`instance_settings.oauthProviders[].tokenAuthMethod`,
`"auto" | "post" | "basic"`, Authentication page). better-auth's default
(`getDefaultTokenEndpointAuth`) is `client_secret_post` whenever a client secret
is configured, and `none` when it isn't — and `none` sends **no client
credentials at all**, which an IdP reports as `invalid_client`,
indistinguishable from a wrong secret. A discovery document's
`token_endpoint_auth_methods_supported` lists what the _server_ accepts, but
each registered client has its own configured method, so a client set to
`client_secret_basic` rejects the default POST-body request. **Automatic is not
"let better-auth decide"** : it reads the provider's own
`token_endpoint_auth_methods_supported`, captured into `discoveredTokenAuth` by
the same discovery fetch that already validates the URL on save, and prefers
`client_secret_basic` when offered — which is what RFC 6749 §2.3.1 requires
servers to support and calls body credentials "NOT RECOMMENDED", and what OIDC
Core defaults `token_endpoint_auth_method` to. better-auth's POST-body default
is the outlier, and following it is what made a correctly configured Pocket ID
client fail. Falls back to `post` when Basic isn't advertised, and to
better-auth's own default when neither is (`resolveAdvertisedTokenAuth`, a pure
function in `src/lib/auth-providers.ts`, covered by
`tests/unit/app/token-auth.test.ts`). Because the list is captured at save time,
a provider stored before this exists has an empty `discoveredTokenAuth` and
behaves as before until it's saved again. `"basic"` maps to better-auth's
`authentication: "basic"`, `"post"` to an explicit
`tokenEndpointAuth: { method: "client_secret_post" }`, and all of it is only
applied when a secret is actually present : passing a secret-based method with
no secret makes the plugin **throw during init**, which would take the whole
auth context down (the lockout shape described under Auth above). **Verified by
observing the real request** against a stub IdP that logs what arrives —
`auto`/`post` put the secret in the body, `basic` sends an
`Authorization: Basic` header and no body secret. That stub is the tool to reach
for here : two earlier guesses at this bug (a pinned `redirectURI`, then a
suspected empty secret) were both wrong, and only watching the actual outgoing
request settled it.

**The flow still has to start and finish on one origin.** The PKCE code-verifier
cookie is set on whichever origin began the exchange, so beginning on host A and
finishing on host B fails on the verifier even when the URIs line up.
`src/lib/server/canonical-origin.ts`'s `offCanonicalOrigin()` is what closes
that: `/app-auth` 302s to the canonical origin (lossless, its state is the
signed `rd` param), and the dashboard sign-in page swaps its provider buttons
for a link to the canonical sign-in URL rather than offering a button that
cannot work. **The load-bearing detail is that it reads the `Host` (or
`X-Forwarded-Host`) header, not `url.origin`** : with `ORIGIN` set, the adapter
pins `event.url` to the configured origin, so a `url.origin` comparison can
never detect the mismatch and the guard is silently dead code, which is exactly
how the first attempt at it was written. The header is attacker-controllable,
which is safe here because it only ever decides _whether_ to redirect; the
target is always `config.auth.origin`, never derived from the request.

**Linking a provider to an existing account is explicit, and it has to be.**
better-auth refuses implicit linking when the **local** user row has
`emailVerified: false`, even for a trusted provider (`link-account.mjs`'s single
condition, which also covers `accountLinking.enabled`/`disableImplicitLinking`).
Homerun's bootstrap admin signs up with email and password while SMTP is
typically disabled, so `emailVerified` is false and can never become true : that
account could **never** link an OIDC provider, and the failure surfaced as a raw
`account_not_linked` code. The escape hatch (`requireLocalEmailVerified: false`)
is marked deprecated upstream — "the gate will become unconditional" — so
disabling it buys months and then breaks. The fix is therefore the explicit
path, not the loophole: `/profile/security` has a **Connected accounts** section
listing every enabled provider with Connect/Disconnect, driven by better-auth's
authenticated `linkSocial()`/`unlinkAccount()` (which bypass the gate entirely,
since being signed in is itself the proof both accounts are yours). Disconnect
is disabled while the user has no `credential` account, so nobody can strip
their own last sign-in method. **`unlinkAccount` takes `accountId`, not
`providerId`**, in this version, so the load returns each provider's
`account.accountId` alongside its linked flag.

**better-auth's own error UI is replaced by `/auth/error`** via
`onAPIError.errorURL`. Without it, a failed OAuth callback renders better-auth's
branded "Something went wrong" page with a raw code and an "Ask AI" button,
which is jarring in a self-hosted dashboard. The page maps the codes that
actually occur (`account_not_linked`, `state_mismatch`, `email_not_verified`,
`email_not_found`, `invalid_callback_request`) to plain language, and falls back
to a sane message for anything else. **It normalizes the incoming code**
(lowercase, spaces and hyphens to underscores) because better-auth emits
`"account not linked"` with spaces and it arrives slugified.

**The page performs the fix rather than describing it.** A first cut told the
user to go to Profile → Security themselves, which the user rightly rejected :
the page already knows everything needed to do it. For `account_not_linked` it
now renders a real **Link \<provider\> to this account** button (calling
`linkSocial()` inline) plus **Sign out**, when `locals.user` is set — and the
sign-in prompt only when nobody is signed in, since linking requires an
authenticated session. Which provider failed isn't in better-auth's redirect (it
only appends `error=`), so the two places that start an OAuth flow stash the
provider name in `sessionStorage` first (`src/lib/oauth-attempt.ts`); the page
falls back to the only enabled provider when there's exactly one, and to a
button per provider otherwise, so it degrades instead of guessing wrong.

**Enabled providers now actually appear on the dashboard's own sign-in page**
too, as "Continue with …" buttons. They never did before: providers could be
configured but nothing rendered a button, and `/api/v1/auth/providers` was in
`hooks.server.ts`'s `customAuthPaths` allowlist while the route itself didn't
exist. **In this better-auth version `genericOAuth` registers its providers as
ordinary social providers** ("used through the standard `signIn.social` and
`callback/:id` core endpoints — no plugin-specific endpoints needed", from the
plugin's own types), so the client calls
`signIn.social({ provider, callbackURL })` and needs no extra client plugin —
there is no `genericOAuthClient` export in this version to add. `provider` is
typed as a union of the built-in social providers, so a custom provider id needs
a cast at that one call site.

**OIDC provider requests are rebased onto the Dashboard URL.** The server
adapter (adapter-bun, patched) builds every request URL from the `ORIGIN` env
var when it's set, and the installer sets it to the host's IP. better-auth
builds the discovery document's `authorization_endpoint`/`token_endpoint`/...
from the request URL while the issuer comes from `config.auth.origin`, so after
onboarding set a domain an app signing in was sent to the IP. `authHandler` in
`hooks.server.ts` hands OIDC provider paths to `auth.handler` with
`rebaseOnOrigin(request, config.auth.origin)` instead of going through
`svelteKitHandler`. The same pinning reaches every URL built from `url.origin`:
better-auth's verification and change-email links go through
`withDashboardOrigin` (`canonical-origin.ts`), and the git provider OAuth
`redirect_uri`, the CLI device-login URLs and the OpenAPI server URL use
`browserOrigin(request, url)`, the `Host`/`X-Forwarded-*` the caller actually
used, which is also what the Git Providers page shows as the callback to
register.

## Per-app login wall (`service.authRequired` + policy columns, `/api/v1/auth-check`, `/app-auth`, `src/lib/server/app-gate.ts`)

The gap this document used to describe at length — `authRequired` blocked
_everyone_ because there was no login page on the gated hostname and
`AUTH_CROSS_SUBDOMAIN` didn't rescue it — is closed. `authRequired` is now a
real login wall, and `crossSubdomainCookies` is unrelated to it (still a
supported setting, just not part of this flow).

**The mechanism, and the Traefik behaviour it rests on.** Traefik returns a
non-2xx forwardAuth response to the client _verbatim_, headers and all. So
`/api/v1/auth-check` can answer with a `302` **and** a `Set-Cookie`, and because
the browser sees that response as coming from the gated app's own hostname, the
cookie lands host-scoped there. That's the whole trick: no cross-subdomain
cookies, no second Traefik router, no extra container. **Verified directly
against Traefik v3** before any of this was built (a throwaway auth server and
backend behind the real dev Traefik): a 302 passes through with its `Location`,
custom headers and `Set-Cookie` intact; `X-Forwarded-Uri` carries the query
string; the original request's `Cookie` header reaches the auth server; and
`authResponseHeaders` injects identity headers into the backend request on a
2xx. Re-verify these if the middleware is ever reworked, the design has no
fallback if any of them stops holding.

The round trip, all of it through the one forwardAuth channel:

1. Anonymous request to `app.example.com/page` → auth-check → `302` to
   `<config.auth.origin>/app-auth?rd=<signed token>`. `rd` carries the original
   URL, the host and the service id, HMAC-signed with a 10-minute TTL, so it
   can't be used as an open redirect.
2. `/app-auth` (its own top-level route, outside `(protected)/` — it has to
   render for signed-out visitors) resolves the service. A signed-out visitor is
   `302`ed to the real `/auth/sign-in?redirectTo=/app-auth?rd=…`
   (`src/lib/redirect-target.ts` keeps `redirectTo` same-origin), so passkeys,
   2FA and the instance's preferred and enforced sign-in methods all apply
   exactly as for the dashboard; the sign-in page names the app
   (`src/lib/server/app-gate-return.ts`), and once signed in shows a two-second
   "taking you to X" screen and returns with `window.location.assign`. It has to
   be a full page load: `/app-auth` answers an allowed user with a `302` to the
   app's own host, and a client-side `refreshAll`/`goto` can't follow a
   cross-origin redirect, which is the real bug the old in-page form had (sign
   in, "redirecting…" toast, then nothing, fields disabled). An allowed user
   gets `302`ed to `app.example.com/__homerun_auth/callback?token=<60s grant>`;
   a signed-in user the app's policy refuses (including one who signed in with a
   method the app doesn't allow) gets the denial screen with "Sign in as someone
   else".
3. That callback path is itself gated, so it lands back in auth-check, which
   verifies the grant and answers `302` + `Set-Cookie` for the session cookie
   (`homerun_app_session`, `HttpOnly`/`SameSite=Lax`/`Secure` over https, **no
   `Domain`** so it stays host-only, 8h).
4. The original URL is re-requested, now carrying the cookie → `200`, plus
   `X-Homerun-User`/`-Email`/`-Name` (declared in the middleware's
   `authResponseHeaders`) so a proxy-header-aware app gets the identity for
   free.

`/__homerun_auth/logout` clears the cookie the same way.

**On a path domain (`example.com/api`) all of it moves under the path.** The
service's routers only answer `/api` and below, so a callback at the host root
would land on whichever service owns `example.com`. `gatePrefix` (`app-gate.ts`)
finds the domain entry a request came in on, and auth-check, `/app-auth` and the
`_gate` router label all use `/api/__homerun_auth/callback` and `/logout`. The
session cookie gets `Path=/api`: two gated services on one host would otherwise
overwrite each other's `homerun_app_session` and bounce the visitor between
sign-ins. auth-check reads every cookie of that name (`readGateCookies`) and
keeps the one signed for its service, so the `/` service's cookie riding along
on `/api` requests is harmless.

**The hot path is DB-free.** The cookie is a self-contained signed token
(`src/lib/server/app-gate.ts`), so a request with a valid one costs an HMAC
verify plus a 10s-TTL in-memory lookup of the service row
(`src/lib/server/gated-service-cache.ts`, HMR-safe `globalThis` singleton, same
pattern as the db client). Every proxied request to a gated app goes through
this, so don't add a query to it.

**Revocation is immediate, and that's load-bearing.** The cookie embeds a
`policyVersion`, a short HMAC over the service's own auth policy; auth-check
recomputes it per request and challenges on a mismatch, and saving the policy
calls `invalidateGatedService()`. Without this, tightening an allowlist would
have left already-issued cookies working for up to 8 hours — observed for real
during live testing, which is what prompted adding it.

**User changes revoke too, through a cached re-check.** A cookie that passes the
signature/host/policy checks is also run through
`src/lib/server/gate-access-cache.ts`'s `cachedGateAccess`, keyed by service,
user and policy version, which calls `AppAccessService.recheck()` (the full
`evaluate()`, now also refusing a missing or banned user) at most once every
five minutes and shares one in-flight promise between concurrent requests. So
the hot path stays DB-free between re-checks. `auth.ts` registers
`databaseHooks` `after` hooks on `user` update/delete and `account`
create/update/delete that call `forgetGateAccess(userId)`, so deleting, banning,
re-roling or changing the email of a user, or linking/unlinking an account, is
seen on the very next request. Those hooks fire for every better-auth
`internalAdapter` write (`removeUser`, `setRole`, `banUser`, `updateUser`,
self-service delete), but **a raw Drizzle write to `user` or `account` bypasses
them**: call `forgetGateAccess(userId)` after one. A re-check that throws (DB
down) is logged, not cached, and honours the cookie, matching the old DB-free
behaviour. The user's Homerun role counts as a group for `authAllowedGroups`
(`groupsAcross(accounts, role)`), which is what makes a role change on `/users`
a re-grouping for gated apps. For a service with `authAllowedGroups`,
`recheck()` first calls `auth.api.refreshToken({ body: { accountId, userId } })`
(no headers, so better-auth treats it as a trusted server call) for each linked
OAuth account holding a refresh token, throttled to once per five minutes per
user, so a group removed at the provider lands in the stored `idToken` well
before the 8h cookie expiry. A failed refresh is logged and the stored token is
used. `auth` is imported dynamically there so the unit tests importing
`app-access.service.ts` don't build better-auth.

**Config prerequisite**: `config.auth.origin` must be set, since that's where
visitors get sent to sign in. `updateAppAuth` refuses to turn the wall on
without it, and auth-check falls back to an explanatory 500 rather than a
mystery redirect. **`config.auth.origin` now falls back to the `ORIGIN` env
var** — it previously read only `homerun.yaml`/`instance_settings`, even though
`compose.prod.yaml`, the installer's generated stack and the integration harness
all set `ORIGIN`, and `auth.ts` warned based on `process.env.ORIGIN` while
`config.auth.origin` never read it.

**Turning the wall on or off redeploys; the policy applies live.**
`buildContainerLabels` attaches the forwardAuth middleware only when
`authRequired` is on. It used to be on every publicly routed router so toggling
applied without a redeploy, and that was reverted on purpose: every request to
every public app then cost a round trip to Homerun (auth-check was most of the
dashboard's traffic), and an auth layer that failed to build took down every
site, gated or not. Now saving a change of `authRequired` (Security tab, or
`PATCH /api/v1/services/:id`) calls
`DeploymentService.redeployIfLoginWallChanged`, which queues a redeploy for a
deployed, running service so the new labels reach Traefik. Policy changes with
the wall already on still apply immediately: `invalidateGatedService()` drops
the 10s service cache. auth-check keeps its early `200` for an ungated service,
for a router still carrying the middleware from an older deploy.

**Real bug: every site 500'd during a self-update.** Services deployed before
the gated-only change still carried the middleware, so each request went through
auth-check, and while compose swapped the app container Traefik's forwardAuth
had nothing to reach and answered 500 for all of them. Two fixes.
`DeploymentService.redeployStaleLoginWalls` runs from the core-services watch
right after a successful `detectAuthCheckUrl` (so on every boot and worker
restart) and redeploys any running routed service whose labels fail
`loginWallDrifted` (`docker/labels.ts`): a forwardAuth on an ungated service,
none on a gated one, or an address other than today's `authCheckUrlFor`, which
also moves every gated service onto the alias. And the updater hands the alias
to its candidate (`docker network disconnect` + `connect --alias homerun-auth`,
on the app's own port now rather than 3999) before `up -d`, and removes the
candidate only after the new app answers `/api/v1/ready`, so the check always
has one live answerer: Go's dialer tries every address the alias resolves to, so
a container that's stopping or not yet listening is skipped. The first update
onto this version still runs the old updater script, so that one still has the
gap.

**Workstations share the wall, through `GateTarget`** (`app-gate.ts`). The
wall's flow (challenge, callback, cookie, re-check) runs on a `GateTarget`, not
a `ServiceDTO`: the policy columns, the domains `gatePrefix` reads, a name, the
token's `serviceId` (`key`) and an `ownerId`. `serviceGateTarget` builds one
from `gatedService`; `workstationWall` (`workstation/sign-in.ts`) from a
workstation row, keyed `workstation:<id>` like the git sign-in, cached next to
its git gate in `WorkstationSignInService` (`wall(id)`, dropped by `forget`).
`gateTarget(key)` (`src/lib/server/gate-target.ts`) dispatches a signed token's
`serviceId` to either, which is all `/app-auth` and `gatedAppFor` needed;
auth-check picks by its query (`?service=` or `?workstation=`), and a
workstation with `authRequired` on takes the wall branch before the git one.
`AppAccessService.evaluate`/`recheck` take an `AccessPolicy` (the policy plus
`ownerId`), and an owner is let in whatever the rules say unless deleted or
banned, so a workstation's owner can't lock themselves out; the sign-in page
offers every method for a workstation for the same reason (`methods: null`). The
workstation columns are the service's names (`auth_required`, `auth_providers`,
`auth_allowed_*`), so `policyVersion` and `loginWallPolicyProblem` apply
unchanged. `WorkstationSettingsService.update` validates them, forgets the
cached gate, and restarts a running workstation when `authRequired` flips, since
its labels (or agent route file) and `--auth none` follow the wall like a
service's redeploy; a policy change alone applies live. The Settings tab reuses
`LoginWallSection` with `subject="workstation"`, its user picker filled only for
a caller who can read Services (`loginWallOptions(withUsers)`); New Workstation
and the preset pages embed the same section in their own form (`embedded`), and
a preset's wall is handed to the workstations created from it.

**Path-scoped walls**: `authPathsMode`/`authPaths` split the gated router in
`buildContainerLabels` rather than teaching auth-check about paths, so an
ungated path costs nothing per request (see `docker.md`, Blocked paths, login
wall paths and IP bans). Saving them redeploys, like toggling the wall.

**The policy columns** on `service` (all jsonb, all `[]` by default):
`authProviders` (allowed sign-in methods, `"password"` for built-in credentials
or `"oauth:<provider name>"`), plus `authAllowedUserIds`/`authAllowedEmails`/
`authAllowedGroups`. `src/lib/auth-providers.ts` is the pure module owning that
encoding (and the `*@domain` email matcher, and the preset catalogue);
`src/lib/services/app-access.service.ts` evaluates a decision. **Nothing is
selected by default and the wall can't be turned on with an empty
`authProviders`** — that combination would lock out everyone including the
owner, so it's rejected at save time rather than allowed and warned about.

**"Which method did they use" is answered by linked identity, not by the
session.** better-auth's `session` table records no provider, so
`AppAccessService` checks whether the user has an `account` row whose
`providerId` matches an allowed method (`credential` ↔ `password`). Groups come
from decoding the claims of that row's stored `idToken` (`groups`, `roles`, and
Keycloak's `realm_access`/`resource_access` roles — a fixed list, deliberately
not per-provider config). A stricter session-bound check would need a side table
written at sign-in and still couldn't classify a pre-existing dashboard session.

**Verified end to end against real infrastructure**, not just reasoned about: a
real gated `nginx:alpine` container behind the real dev Traefik, driven with
curl as the browser through every hop — anonymous redirect, the login screen,
the grant, the host-scoped `Set-Cookie`, the app actually serving, a forged
cookie refused, logout, the identity headers, and a policy change revoking a
live cookie. `tests/integration/app-gate.test.ts` covers the same flow against
the real app (including cross-host cookie rejection and each denial reason), and
`tests/unit/app/app-gate.test.ts` covers token signing/expiry/tampering and
claim extraction.

## User roles & admin-managed accounts (`user.role`, `/users`, `invitation` table)

This moved from "anyone can `/auth/sign-up`" to a real single-instance model.
Roles are `"admin"`, `"developer"`, `"viewer"`, `"app-user"` and `"custom"`,
each a preset of per-area permissions (see Permissions above). Every role reads
the same shared resources (no shared-resource DTO filters by `userId`, which
only records the creator; see Shared resources in `data-and-config.md`); what
differs is which areas' routes `locals.permissions` lets through, and the
sidebar nav is filtered with `mayVisit`.

- **The very first account becomes admin automatically**, whoever creates it.
  `hooks.server.ts`'s `authHandler` hard-blocks
  `POST /api/v1/auth/sign-up/email` (better-auth's real email/password sign-up
  endpoint) with a 403 once `AdminService.hasAnyUser()`
  (`src/lib/services/admin.service.ts`, a raw query, no DTO exists for
  better-auth-owned tables) is true, the endpoint itself is blocked, not just
  the UI, so it can't be curled around. `/auth/sign-up` and `/auth/sign-in`'s
  own `load`s cross-redirect based on the same check (blank instance → sign-up;
  account exists → sign-in), so navigating to either one always lands somewhere
  sensible. Every account after the first is created by an admin from `/users`,
  direct-create (name/email/role, no password field at all, see Email-first
  sign-in below for what happens next) or email invite (`InvitationDTO` +
  `/auth/accept-invite/[token]`, gated behind `isSmtpEnabled()`).
- **Real, tested-in-review finding**: making the bootstrap-admin hook
  conditional on `!user.role` doesn't work. `auth.ts`'s
  `databaseHooks.user.create.before` is where the promotion happens, but the
  `admin()` plugin registers its _own_ `databaseHooks.user.create.before` (via
  its `init()`) that sets `role` to `options.defaultRole`, and depending on
  plugin/app hook-merge order, that can run _before_ the app-level one, so
  `user.role` is already truthy by the time this hook sees it. Verified live:
  with a `!user.role` guard, the bootstrap account came out `"developer"`, not
  `"admin"`. Fixed by checking `AdminService.hasAnyUser()` directly instead of
  `user.role`'s presence, both hooks run pre-insert, so it's still reliably
  false only before the very first user exists, regardless of ordering.
  `admin({ defaultRole: "developer" })` stays as the sane fallback for any
  creation path that doesn't pass an explicit role (shouldn't normally happen,
  direct-create and invite-accept both always pass one).
- **Real, tested-in-review finding**: `auth.api.removeUser` (the admin plugin's
  user-deletion endpoint) calls `internalAdapter.deleteUser()` directly, which
  does **not** run this app's `user.deleteUser.beforeDelete` option, that option
  is read and invoked only by better-auth's own self-service delete-account
  endpoints (`node_modules/better-auth/dist/api/routes/update-user.mjs` is the
  only place `beforeDelete`/`afterDelete` are referenced at all), not by
  `internalAdapter.deleteUser` generically. Calling `auth.api.removeUser`
  naively from an admin "remove user" action would cascade-delete that user's
  rows and leak their Docker containers/networks. Fixed by extracting the
  cleanup body out of `auth.ts`'s `beforeDelete` into
  `src/lib/services/user.service.ts`'s
  `UserService.cleanupUserResources(userId, actingUserId?)`, called explicitly
  by both the self-service `beforeDelete` hook _and_ `/users`' `removeUser`
  action (passing the acting admin) before it calls `auth.api.removeUser`. It
  reassigns every shared row's `userId` (and `template.ownerId`,
  `invitation.invitedByUserId`) to the acting admin, else the oldest other
  admin, else the oldest other account, so nothing cascades; only the very last
  account's deletion removes containers and stack networks. A transferred git
  service builds with its new owner's git connection. By contrast
  `databaseHooks.user.create.before` (used for the role-promotion above)
  genuinely _is_ generic, `internalAdapter.createUser` goes through the same
  `createWithHooks` machinery regardless of caller, confirmed in
  `node_modules/better-auth/dist/db/internal-adapter.mjs`, so that one hook
  firing uniformly for self-service sign-up, `admin.createUser`, and
  invite-accept was safe to rely on.
- `/users`' `setEmail` action changes an address directly through the admin
  plugin's `auth.api.adminUpdateUser` (`{email, emailVerified: true}`, with the
  request headers so better-auth re-checks admin), after refusing an address
  another account already holds. It exists because self-service change-email on
  a verified address sends a confirmation to the old address, which never
  arrives without SMTP.
- `/users`' `removeUser`/`setRole` actions also refuse to strip the last
  remaining admin (`wouldRemoveLastAdmin()`, checked via
  `src/lib/services/user.service.ts`'s `UserService.countAdmins()`) and refuse
  self-removal (mirroring better-auth's own guard on `admin.removeUser`, checked
  client-side too before it gets there).
- `/auth/accept-invite/[token]/+page.server.ts`'s `accept` action calls
  `auth.api.createUser` **without** a `headers` option, confirmed from
  `node_modules/better-auth/dist/plugins/admin/routes.mjs`: omitting
  `headers`/request context is treated as a trusted server-side call and skips
  the admin-role permission check entirely, which is correct here since the
  invite token itself (validated, single-use, expiring via
  `InvitationDTO.getByToken`) is the authorization, not an admin session.
  `/users`' own actions, by contrast, always pass `headers: request.headers` so
  better-auth's own permission check double-enforces admin-only on top of the
  route's own permission check.
- The guards and changes live on `UserService` (`changeRole`, `changeEmail`,
  `changePermissions`, `removeUser`, and `updateAccount` for the REST API's
  `PATCH /users/:id`, which checks every field before saving any), so `/users`
  and `/api/v1/users` refuse the same things with the same messages.
  `POST /api/v1/users` goes through `createPendingUser` like direct-create, and
  can also give the custom role with permissions.
- `App.Locals.permissions` replaced the old `locals.isAdmin`: a route that needs
  an area checks `can(locals.permissions, area, level)`, and "admin" is just
  `hasAllPermissions`.

## Onboarding (`instance_settings.onboardingCompletedAt`, `/onboarding`, `Stepper` component)

A signed-in user whose instance hasn't finished onboarding is forced to
`/onboarding` and can't reach anything else; `/onboarding` itself is unreachable
once it's done. **`src/routes/onboarding/` is its own top-level route, not
nested under `(protected)/`** (it predates that route group's current shape,
this doc previously said otherwise, see below), so the two directions are two
separate `load`s rather than one shared check: `(protected)/+layout.server.ts`
redirects into `/onboarding` when `!settings.onboardingComplete` (right after
its own `locals.user` check, same function that redirects signed-out visitors to
sign-in/sign-up, see Routing above), and `onboarding/+layout.server.ts`
redirects back out to `/` when `settings.onboardingComplete` is already true,
both reading the same `InstanceSettingsDTO.onboardingComplete` getter
(`onboardingCompletedAt !== null`). Onboarding is a property of the singleton
`instance_settings` row (see Instance settings above), not per-user, so once the
bootstrap admin finishes it, later developer accounts never see the wizard, that
falls out naturally from the flag living on the instance, not the account. Edge
case: an admin _could_ create another account before finishing onboarding
themselves, `/onboarding/+page.server.ts`'s own `load` checks the account's
permissions and shows a non-admin a "an admin needs to finish setting up this
instance" holding message instead of the real wizard rather than handing them
instance-wide config controls.

The Docker step shows a live **swarm readiness** block
(`DockerService.swarmReadiness()` via `getSwarmReadiness`): whether this daemon
is a swarm manager, whether the overlay network exists, and whether Traefik is
actually running its swarm provider, each read off the daemon rather than
assumed. It's informational, not a gate : standalone containers need none of it,
and Settings → Docker sets up whatever's missing when the mode is switched.
`cmd/installer/swarm-join.sh` is still unverified against a real host.

**Doc correction**: this section previously described both directions as gated
from a single `(protected)/+layout.server.ts` load comparing `route.id` against
`"/(protected)/onboarding"`, following an earlier fix for a real
`url.pathname`-vs-`resolve()` bug (`resolve("/onboarding")` returned a relative
`"./onboarding"` in this app, not an absolute path, so an `===` check against
`url.pathname` always evaluated false and infinite-redirect-looped). That fix
and its `route.id` mechanism are gone now that `onboarding/` moved out from
under `(protected)/` into its own top-level route with its own reverse-direction
`load`; there is no `route.id` comparison anywhere in this codebase today. The
underlying gotcha (`resolve()` returns a relative path, not useful for a
`url.pathname` equality check) is still worth knowing if a future gate needs
one, just not implemented this way anymore. Kit 3 also changed `resolve()`'s
input: pathnames take no leading slash (`resolve("onboarding")`, home is
`resolve("")`), and only route ids start with `/`.

`/onboarding/+page.svelte` is a 6-step wizard (Core / Docker / Traefik / Email /
DNS / Review; Core also asks "How will you use Homerun?", saved as
`instance_settings.defaultUiMode`, see Simple and advanced UI modes in `ui.md`)
in a centred `max-w-3xl` column, each step a `panel` card with its own header,
closing on a Review step that lists what's about to be persisted. It's built on
the reusable `src/lib/components/stepper.svelte` (connected circular step
markers with labels at `sm+`, a progress bar below that, `Button` primitives for
Back/Next), extracted from `services/new`'s inlined
step-indicator-bar-plus-Back/Next pattern (not retrofitted onto `services/new`
itself, a deliberate scope cut). `Stepper` owns navigation and which step is
unlocked (`reachableStep`, grows only after a passed `onNext`); the consuming
page owns field markup and validation, same "shared chrome, not shared shape"
split as `form-styles.ts`. No phantom errors: a field's error paragraph only
renders once that field's step has actually failed an attempted `Next`/submit
(tracked in the page's own `attempted: Set<number>` state, not the component's),
nothing shows on initial render. The finish action reuses the exact
`InstanceSettingsDTO.updateCore/updateDocker/updateTraefik/updateSmtp` methods
`/settings` already calls, plus `updateCloudflare`/`updatePangolin` for
whichever DNS integration the DNS step switched on, then
`markOnboardingComplete()`, then `applyAndRebuild()` (the same post-save helper
`/settings` uses, so the dashboard DNS record is synced too). The DNS step
shares its form parsing and "Test connection" checks with Settings → Networking
through `src/lib/server/validation/dns-settings-form.ts`; Pangolin's target
host/port and `pangolinOwnsAuth` aren't shown and are preserved; the Newt fields
are shown and validated with the same `newtFieldsError`. Its Test buttons post
`?/testCloudflare`/`?/testPangolin` from the same wizard form, and the page's
submit function routes those through their own promise toast **without calling
`update()`**: a successful action result invalidates `data`, and every wizard
field is a writable `$derived` over `data`, so `update()` would reset everything
typed so far. Secrets (`smtpPassword`, both API tokens) are stripped from the
`values` echoed back on a failed finish.

## Trusted origins (`src/lib/services/auth-origins.ts`)

better-auth's `trustedOrigins` is a function reading `config` live, built by
`trustedOriginsFor`: the `ORIGIN` env, the Dashboard URL, and `http(s)://` of
both the Dashboard URL's host and the Base domain. Real bug this fixes: an
install whose `ORIGIN` is its IP (installer default) rejected every sign-in
reached through its resolved DNS name with "Invalid origin". Subdomains of the
Base domain are deliberately **not** wildcarded: they're deployed apps, same
site as the dashboard, and must not be able to drive its auth endpoints.

**The server's own address is always trusted** (`directAccessOrigins`): when a
request's `Host` header is an IP literal or `localhost`, `http(s)://<Host>` is
added per request. Real lockout this fixes: changing the Base domain / Dashboard
URL to a wrong domain moved Traefik's routing, and signing back in at
`http://<ip>:3000` (the published port still answers) failed with "Invalid
origin", because SvelteKit rewrites `event.url` to `ORIGIN` and the IP was in no
trusted list. It's a same-origin check (a cross-site page can't make a browser
send another site's `Host`), limited to IP literals so DNS rebinding can't use
it. `csrfHandler` got the matching rule: an `Origin` whose host equals `Host`
passes. better-auth only enforces origins on requests carrying a cookie, and
**skips the check entirely when `NODE_ENV=test`**, which is what the integration
suite's spawned app inherits, so `advanced.disableOriginCheck: false` is set
explicitly; the suite now exercises the production behaviour
(`tests/integration/auth.test.ts` signs in from an IP `Host` that isn't
`ORIGIN`, and refuses a cross-site one). Session cookies are only `Secure` when
`ORIGIN` is `https`, and the installer writes `http://<ip>:3000`, so the cookie
sticks over plain http too; an instance with an `https` `ORIGIN` still can't
keep a session over `http://<ip>`.

## Passkeys, 2FA and sign-in requirements

`twoFactor({ allowPasswordless: true })` (TOTP + backup codes) and `passkey()`
are wired server and client side. `passkey`'s `rpID` is the hostname of
`config.auth.origin` (`src/lib/security-policy.ts`'s `passkeyRpId`): without it
better-auth fell back to `localhost`, since `baseURL` is deliberately never set
(see above), so passkeys could never work on a real domain. Users manage both
from Profile → Security (`two-factor-panel.svelte`, `passkey-panel.svelte`,
reads through `AccountSecurityService`). The sign-in page offers a passkey
button (labelled "Continue with a passkey" because e2e selects the `Sign in`
button by name prefix) and the TOTP/backup-code step on `twoFactorRedirect`.

Changing the Dashboard URL's hostname strands every passkey on the instance (a
credential only signs for the rp id it was registered under). Settings → General
computes the next rp id from the typed Base domain / Dashboard URL
(`nextPasskeyRpId`), compares it against the running one
(`strandedPasskeyCount`, count from
`AccountSecurityService.countAllPasskeys()`), shows an inline warning, and
cancels the enhance submit behind a confirm dialog until the admin accepts.

`instance_settings.require_two_factor` / `require_passkey`, edited on
`/authentication`, are enforced by the `(protected)` layout load only for cookie
sessions (`locals.session`), never for API key/bearer/CLI tokens: a user missing
one is redirected to `/security-setup?next=…`, an `AuthShell` card outside
`(protected)` that shows only the panels still needed. Known gaps: form actions
and remote functions hit directly aren't gated, and better-auth only asks for
the TOTP code on email/password sign-in, not passkey or OAuth.

## Email-first sign-in and admin-created accounts (`AccountSetupService`, `src/lib/remote/sign-in.remote.ts`)

`/auth/sign-in` (`src/routes/auth/sign-in/+page.svelte`) is email-first: step 1
asks only for an email (the passkey button and passkey autofill/auto-prompt are
unrestricted and still shown on this step), and "Continue" calls the
`lookupSignIn` remote command (throttled to 20 calls/min per IP per command via
a module-scope `Map`, `sign-in.remote.ts`'s `throttle`), backed by
`src/lib/services/account-setup.service.ts`'s
`AccountSetupService.lookup(email)`. That decides the next step, returned as a
`SignInLookup` discriminated union:

- **`"password"`**: the account has a `credential` account, or the email is
  unknown — an unknown email deliberately also gets this step, so the lookup
  can't be used to enumerate which emails have an account. All enabled OAuth
  providers are offered below as "Continue with …" buttons.
- **`"sso"`**: the account is linked to an enabled OAuth/OIDC provider and has
  no `credential` account, or one of its linked providers is among
  `instance_settings.preferred_sign_in_methods`. `autoRedirect` names the
  provider to jump straight to (the preferred one, or the only linked one); the
  page calls `handleOauthSignIn` immediately in that case, otherwise it shows a
  button per linked provider.
- **`"setup"`**: the account was created by an admin (`createPendingUser`, see
  below) and hasn't chosen a password yet. With SMTP configured
  (`isSmtpEnabled()`), `lookup` emails a 6-digit code first (`#sendCode`,
  10-minute TTL, "Send a new code" re-sends via the `resendSetupCode` command)
  before the page shows the set-password form; without SMTP the page skips
  straight to it. Either way `completeAccountSetup` (12+ characters, confirmed
  twice client-side, `MIN_PASSWORD_LENGTH` server side too) sets the password
  via `ctx.internalAdapter.updatePassword`, marks the email verified only when a
  code was actually checked, clears both verification rows, and the page signs
  in immediately after with the new password.

**Admin-created accounts have no temporary-password field at all.** `/users`'
`createDirect` action calls `AccountSetupService.createPendingUser`, which
creates the user through `auth.api.createUser` with a random 32-byte password
nobody is told, then writes a `verification` row (identifier
`account-setup:<userId>`, no dedicated table) marking it pending — that's the
row `lookup`/`#pendingUser` check for the `"setup"` step above. `/users` shows
an amber "Setting up SMTP is highly recommended" warning when
`!isSmtpEnabled()`: without SMTP anyone who knows the new user's email can hit
`/auth/sign-in`, land on the `"setup"` step, and set that account's password
before its real owner does, since there's no code step to prove the address.
Email invite (`InvitationDTO` + `/auth/accept-invite/[token]`) is unrelated to
this and unchanged, it still requires SMTP.

**Preferred sign-in methods** (`instance_settings.preferred_sign_in_methods`,
jsonb string[], null = none, edited on `/authentication`, keys `password`,
`passkey` and `oauth:<provider name>` via `src/lib/sign-in-methods.ts`'s
`oauthMethod`) no longer reshuffles a list of buttons on one page —
`splitSignInMethods` and the old "Other sign-in methods" link are gone along
with the single-page form. It now drives exactly two things: `lookup`'s SSO
auto-redirect above (a preferred linked provider wins over "show every linked
provider as a button"), and the passkey auto-prompt — when `passkey` is
preferred and usable on this host (`passkeyUsableOn`), step 1 calls
`authClient.signIn.passkey()` on mount instead of starting the conditional
autofill request, since a second WebAuthn call would abort the first.
Cancelling, or a browser that refuses a prompt without a click (Safari), fails
silently and leaves the passkey button in place. A preference matching nothing
available (a deleted provider, passkey on the wrong host) simply doesn't apply,
`lookup` still falls back to the `"password"`/`"sso"` step it would pick anyway,
so the page can never render with no way in.

## Emailed codes and links (`src/lib/services/email-sign-in.ts`, `/auth/magic-link`)

better-auth's `emailOTP` and `magicLink` plugins, registered always (no
`rebuildAuth()` on toggle), plus a small `homerun-email-sign-in` plugin whose
before hook (`guardEmailSignIn`) runs on the four endpoints Homerun uses. The
switches are `instance_settings.email_otp_sign_in` (null = on) and
`magic_link_sign_in` (null = off), edited on `/authentication`;
`emailSignInAvailability()` ANDs them with `isSmtpEnabled()`, and the guard 403s
a method that's off. Codes: 6 digits, 10 minutes, five tries, stored as their
SHA-256 through a custom `storeOTP.hash`. Links: 10 minutes, one use, stored
hashed through a custom `storeToken`. Both `disableSignUp: true`: there is no
public sign-up after the first account, so neither may create one. An unknown
email gets `{success: true}` and no mail (the OTP plugin skips sending itself;
`sendMagicLink` checks the user exists first). Every other emailOTP endpoint
(password reset, verify-email, change-email, check-otp) is in `disabledPaths`,
and `send-verification-otp` refuses any `type` but `sign-in`.

**Real, tested finding: an emailed sign-in wipes an unverified account.** Both
plugins call `revokeUnprovenAccountAccess` when the account's `emailVerified` is
false, which deletes every `account` row (password, OAuth links) and session —
their defence against someone pre-registering a victim's email. Most Homerun
accounts are unverified (bootstrap admin without SMTP, direct-created users), so
the first code sign-in would have erased the admin's password. That pre-hijack
can't happen here (every account comes from an admin or an invite), so the guard
checks the code or link itself, without consuming it (`storedCodeMatches`, or
the hashed token's verification row), and marks the email verified before the
plugin runs; it also deletes the `account-setup:<id>` pending mark, so a
direct-created account that signed in by code stops being sent to the
set-a-password step. Verified live: `client@example.com` signed in by code and
kept its `credential` row, and password sign-in still worked afterwards.

**Two-factor still applies.** `twoFactor()`'s sign-in challenge only matches
`/sign-in/email`; `twoFactorOnEverySignIn()` in `auth.ts` re-registers its after
hook with a matcher over `TWO_FACTOR_SIGN_IN_PATHS` (password,
`/sign-in/email-otp`, `/magic-link/verify`). Verified against the dev app: an
account with TOTP gets `{twoFactorRedirect: true}` and no session from a correct
emailed code, and a session only after `verify-totp`. `security-setup`
requirements need nothing: they're enforced per session by the `(protected)`
layout and `/my-apps`.

**The emailed link is Homerun's page, not better-auth's verify URL.**
`sendMagicLink` mails `<Dashboard URL>/auth/magic-link?token=…&redirectTo=…`
(`magicLinkLandingUrl`; `redirectTo` comes from the client's `metadata` and is
re-checked with `safeRedirectTarget`). That page shows the address
(`magicLinkEmail`, a non-consuming peek) and spends the token only when the
visitor clicks **Sign in as …**, calling `magicLink.verify` without a
`callbackURL` so better-auth answers JSON (with a callback it redirects, errors
included, which a fetch can't report). So a mail scanner fetching links can't
burn it, and the 2FA challenge comes back as JSON the page can act on. The link
isn't offered in the "Sign in with Homerun" flow: the OIDC provider resumes
authorize from the `oauth_query` the client adds to POSTs, which a GET verify in
another tab doesn't carry. Codes work there.

**Sign-in page.** `lookup` carries `email: EmailSignIn` on every step, and has a
new `"email-only"` step for an account with no `credential` row and no linked
enabled provider (an invite accepted with codes). What the page does there is
`emailOnlyStep` (`src/lib/auth-providers.ts`): straight to the code form, whose
mount sends the code, only when codes are the only emailed method; with links on
it shows a `"choose"` step with both buttons and sends nothing until one is
clicked; links never count in the "Sign in with Homerun" flow. Other steps show
**Email me a code** / **Email me a sign-in link** buttons; the pending-setup
step offers **Skip the password, sign in with emailed codes**. The code form
strips non-digits (paste `123 456` works), auto-submits at six digits, and
rate-limits resends to one per 30 seconds client-side; server-side it's the
plugins' own limits (3/min per endpoint for codes, 5/min for links), off with
`HOMERUN_DISABLE_AUTH_RATE_LIMIT`. No new remote functions, so the app-only
allowlist didn't change; the page talks to `/api/v1/auth/*` directly.

**Adding a password later.** A signed-in account with no password (codes-only
invitee, SSO-only user) gets **Set a password** on `/profile/security` and on
`/my-apps` (`set-password-panel.svelte`, both routes export
`src/lib/server/set-password-actions.ts`'s `setPasswordActions`: form actions,
so the app-only remote allowlist needed no new entry and the permission gate (an
open `/profile` route) lets them through).
`AccountSetupService.sendPasswordCode` emails an account-setup-style code (same
`account-setup-code:<id>` row, five tries), `addPassword` checks it, then calls
better-auth's server-only `auth.api.setPassword` with the request headers (it
links the `credential` account, enforces `minPasswordLength` and refuses an
account that already has one) and marks the email verified, so no later emailed
sign-in can take the account for unproven and wipe the new password. Needs SMTP:
without it the panel says so and there's no fallback (session freshness was the
alternative; an account with no password and no SMTP can't sign in by email
anyway). `lookup` then returns `"password"` for that account, nothing else to
change. `tests/integration/auth.test.ts` covers code → set → password sign-in.

**Invites.** `/auth/accept-invite/[token]` has an **Emailed codes** option while
either method is available: `acceptWithCodes` calls `auth.api.createUser`
without a password (no `credential` row, `emailVerified: true` since the invite
link proved the address) and redirects to `/auth/sign-in?email=…`, which
pre-fills the email.

**Login wall.** `"email-otp"` and `"magic-link"` join `"password"` and
`"oauth:<name>"` in `src/lib/auth-providers.ts`; `signInMethodAvailable` is the
one check for the Security tab's save and `/app-auth`'s "any usable method".
There's no identity row for an emailed method, and the session doesn't record
how it was created, so `evaluate()` treats an allowed, currently available
emailed method as satisfied for every account (`acceptsEmailSignIn`): it proves
only the mailbox, and every account has one. The user/email/group lists still
narrow it. Switching the method off or losing SMTP makes it stop counting on the
next re-check.

`tests/integration/support/mail-sink.ts` is a tiny in-process SMTP server
(accepts any AUTH, keeps messages); `tests/integration/auth.test.ts` points SMTP
at it through the real `/settings/email` action, signs a password-less app-only
account in with the mailed code, checks strangers get no mail, and turns SMTP
back off.

## MCP server (`src/lib/server/mcp-server.ts`, `/api/v1/mcp`, `/.well-known/*`)

AI agents manage Homerun through a streamable-HTTP MCP endpoint at
`/api/v1/mcp`. Its tools don't touch DTOs: each one calls the REST API through
SvelteKit's `event.fetch` with the caller's own `authorization`/`cookie`/
`x-api-key` headers, so permissions, per-call permission checks and validation
are the REST routes' and nothing is duplicated. `/api/v1/mcp` is in
`OPEN_ROUTES` (`permissions.ts`) because MCP sends every read as a POST; the
inner REST calls are gated by the caller's permissions.

Tools are grouped per dashboard area, each group a
`register<Area>Tools(server, api)` in its own
`src/lib/server/mcp-<area>-tools.ts` (stacks, templates, environments and
release channels, previews, scans, volumes, cron jobs, status pages,
notifications, redirects, object storage, workstations and their presets,
versions, system (monitoring, system log, instance containers, Docker cleanup)
and admin (DNS, registry, remote hosts, users, git providers)), with the service
tools still in `mcp-server.ts`; `mcp-tool-kit.ts` holds the shared
`asResult`/`errorResult` and annotations. A tool whose input matches a REST body
reuses that route's zod schema (`cronJobApiBody`,
`updateStatusPageApiBody.extend({ statusPageId })`…) instead of restating it, so
the two can't drift. A list tool over rows that are big (services, cron jobs,
templates) returns a summary and leaves the full row to its `get_` tool. A tool
needing data no REST route serves gets a thin route first, never a DTO call:
cron job runs (`GET /cron-jobs/{id}/runs` without output,
`GET /cron-jobs/{id}/runs/{runId}` with it) and the caller's in-app feed
(`GET /notifications`, `POST /notifications/read`, open like the dashboard's
`/notifications`) were added that way, and so were a service's version pin and
update checks (`/services/{id}/version`, `/version/pin`, `/version/check`,
`/version/update`, over `ImageVersionService`, which the Source tab calls too),
monitoring (`GET /monitoring`, `GET /services/{id}/monitoring`, totals without
the chart series) and System's log, containers and Docker cleanup
(`/system/logs`, `/system/containers`, `/system/containers/{id}/logs`,
`/system/docker-cleanup`; `/api/v1/system` is in System's `routes`,
`/api/v1/monitoring` in Services'). `preview_docker_cleanup` sums each category
up instead of listing every image, and `run_docker_cleanup` leaves
`pruneVolumes` out of its enum: irreversible data loss stays a dashboard click.

**Credential-holding admin config stays off MCP's write side, decided.** DNS
connections, git providers, object stores, remote hosts, registry tokens, users
and sign-in get read tools at most, over REST responses that already drop every
secret (`*Set` booleans instead), and no create/update/delete tool. Two reasons:
connecting one means the secret transits the agent's context and its provider's
logs, and an agent that can repoint DNS credentials, mint a registry token or
change a role can widen its own reach, which a prompt injection in a log line it
reads could ask for. DNS records are the exception (no secret, and needed to put
a service online). Revisit only with a reason stronger than "the REST API has
it": `docs/mcp.md` documents the decision for operators. `INSTRUCTIONS` in
`mcp-server.ts` names every tool by area, and `docs/mcp.md` has the same table:
a new tool goes in both. Deleting a service, a stack or an environment stays out
on purpose. The workstation tools mask `env` themselves
(`mcp-workstation-tools.ts`'s `envRedacted`), since `redactSecrets` only treats
`envVars`/`vars` as env maps, and
`update_workstation`/`update_workstation_preset` merge env changes through
`mergeEnvChanges` like `update_cron_job`. `delete_workstation` is in, unlike a
service's delete: it keeps the home volume unless `deleteVolume` is set.
`tests/unit/app/mcp-tools.test.ts` drives the real server through
`createMcpHandler` with a recording fake `ApiCall` (no `initialize` needed): one
row per tool asserting the REST method, path and body it sends, plus the
summaries, filters and the redacted round-trips.

Every value an agent reads goes through `mcp-redact.ts`'s `redactSecrets` first:
`redactEnvValue` fully masks any name in the object's own `secretEnvKeys` (the
lock toggle on a service's Environment Variables and a cron job's Configuration,
`service.secretEnvKeys`/`cron_job.secretEnvKeys`, see Data model in
`data-and-config.md`), the primary mechanism, whatever the name or value. It
also masks a secret-looking name (`PASSWORD`, `TOKEN`, `AUTH`, `COOKIE`,
`SIGNING`…) unless its last part only configures one (`*_AUTH_URL`,
`*_AUTH_ENABLED`, `*_KEY_FILE`, `NON_SECRET_LAST_PARTS`) or the value is a plain
boolean or number (a real false positive was
`GITEA__service__ENABLE_PASSWORD_SIGNIN_FORM=false`), and any value
`looksLikeCredential` whatever its name: `user:<16+ letters and digits>` or a
24+ character token mixing cases and digits that isn't a URL, path, image,
hostname or version (a real leak was `STREMTHRU_AUTH=<user>:<64-char token>`
before `AUTH` joined the name list). `update_service`'s and `update_cron_job`'s
env merge (`mergeEnvChanges`) is handed that same set and compares through the
same `redactEnvValue`, so a value it reads back unchanged is still recognised as
"unchanged" rather than rejected as a bad placeholder. A string under `command`,
`log`, `output`, `url` or `data` (a cron job's shell command, a deploy or job
log, a cron run's output, an error event's request URL or breadcrumb data) gets
`maskInlineSecrets`: URL passwords (with or without a scheme), `--password`
arguments, `Bearer`/`Basic` credentials, sensitive query parameters (`code`,
`state`, `token`, `X-Amz-Signature`…, only after `?`/`&` so `exit code=1`
survives) and bare `token=`/`password=` assignments. Plain-text bodies
(`service_logs`) get it through `redactText`'s fallback. `message`, `metadata`
and `trialMessage` (a system log entry, a breadcrumb, an update trial's failure)
get the same. An error event's `headers` (object or `[name, value]` pairs) lose
every credential-carrying one, `cookies` is replaced whole, `query_string` is
masked like a URL's, and a field literally named `token`, `password`, `secret`,
`authorization`… is masked anywhere. A `data:` URL `icon` becomes `"uploaded"`
(it was tens of KB of base64 in `get_service`), and `update_service` drops an
`icon: "uploaded"` sent back so it doesn't overwrite the real one. Every
placeholder is the fixed `[redacted]`, never sized to the value. A script's
`source` and each of a cron job's `files[].content` go through `maskFileText`: a
line assigning to a secret-looking name (`API_TOKEN=`, `export DB_PASSWORD=`,
`password:`, `const apiKey =`) has its value masked like an env var, every other
line only its inline secrets; a volume's `source` path or a redirect's `source`
hostname passes through untouched. `update_cron_job` merges env like
`update_service` (the REST PATCH replaces the whole map), and
`restoreMaskedText` (with `maskFileText` for `source`) and `restoreFiles` (by
path) put back a command, source or file sent unchanged with its masked parts;
it only reads the job first when something it sends still carries the
placeholder or env changes.

Auth: `hooks.server.ts` treats a Bearer credential shaped like a JWT as an MCP
access token (`verifyMcpAccessToken` in `auth.ts`: `jose` against the `jwks`
table, issuer `oidcIssuer`, audience `mcpResource`, `typ: at+jwt`) and anything
else as an API key. Real, tested finding: better-auth's own `auth.api.verifyJWT`
can't be used, it always enforces an audience of the base URL, which no access
token has. An anonymous call gets a 401 with
`WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/v1/mcp"`.
**No dynamic registration, but CIMD.** RFC 7591 registration stays off: it
stored a client ID and secret for anything on the internet, with only a consent
screen in front. Client ID Metadata Documents (the MCP spec's registration
method) are on through the official `@better-auth/cimd` plugin, registered next
to `mcp()` in `oidcProviderPlugins` with the `mcp-2026-07-28` metadata profile
and the plugin's own `@better-auth/cimd/node` transport, which resolves DNS
once, refuses any non-public address and pins the connection. Verified by hand
that Bun honours `node:https`'s `lookup` override, which that pinning relies on:
a request to a real host pinned to a bogus address fails. A CIMD client must be
public (`none`) or `private_key_jwt`, so nothing secret is stored; it lands in
`oauth_client` with `client_discovery_id = "cimd"`, shows on `/idp` like any
app, and a metadata refresh keeps `disabled`/`skipConsent`, so switching it off
sticks while deleting it only lasts until its next sign-in. Its name comes from
the remote document, so `/auth/consent` shows the `client_id` URL's host
(`discoveredFrom`) next to it. An admin can still pre-register a client under
IDP (`/idp`) → Register app (the **Claude connector** preset fills in
`https://claude.ai/api/mcp/auth_callback`, confidential, PKCE, consent on) for
an agent that asks for an ID and secret. `mcp()` binds every client, registered
or discovered, to the MCP resource (`clientRegistrationDefaultResources`), so
its access tokens carry the MCP audience. Claude Code and other headless agents
use an API key header instead. MCP clients look for discovery at the site root,
not under the auth base path, so `src/routes/.well-known/[...path]` hands every
root `/.well-known/*` request to `auth.handler`, whose `mcp()` plugin answers
the protected-resource and authorization-server documents.
`tests/integration/mcp.test.ts` walks the whole claude.ai flow: an admin creates
the client through the Apps form, then sign in, authorize, consent, token
(client secret over Basic auth), tool call; open registration is refused,
discovery advertises `client_id_metadata_document_supported`, and a metadata
document URL on a private address gets `invalid_client` before any fetch. A full
CIMD sign-in isn't in the suite: the transport only fetches public HTTPS hosts.

## Homerun as an OIDC provider (`@better-auth/oauth-provider`, `src/lib/oidc-provider.ts`, `/idp`, `/auth/consent`)

`oidcProviderPlugins()` in `auth.ts` adds better-auth's `jwt` plugin (RS256 key
pairs in the `jwks` table, since plenty of apps' OIDC libraries reject the EdDSA
default) and `mcp` from `@better-auth/mcp`, which is `oauthProvider` bound to
the MCP endpoint as a protected resource and can't be registered next to a plain
`oauthProvider` (`loginPage: "/auth/sign-in"`, `consentPage: "/auth/consent"`,
scopes `openid profile email offline_access groups`, claims from
`oidcClaimsFor`: `groups` is `[user.role]`, `preferred_username` the email's
local part). `@better-auth/oauth-provider` is pinned to the installed
better-auth version (1.7.7), like `@better-auth/cimd`; they move together.
Issuer is `<config.auth.origin>/issuer` (the `jwt` plugin's `issuer`,
`oidcIssuer()`), while the endpoints stay under `/api/v1/auth`
(`oidcEndpointBase()`): the discovery document's `issuer` comes from the jwt
option and its endpoints from `baseURL`, and the provider's `onRequest` answers
`<issuer path>/.well-known/openid-configuration` whatever path the request has,
so `src/routes/issuer/.well-known/[...path]` just hands the request to
`auth.handler` (as the root `.well-known` route does for
`/.well-known/oauth-authorization-server/issuer`). **The plugins are only added
when `config.auth.origin` is set**: `baseURL` is deliberately unset (see the
`buildAuth` comment), and the provider's `init()` builds
`new URL(issuer ?? baseURL)`, which throws on an empty base; `rebuildAuth()`
adds them once settings supply the origin. `sveltekitCookies` must stay the
**last** plugin, better-auth warns otherwise and the provider's after-hooks set
cookies.

**Tables** (`jwks`, `oauth_client`, `oauth_access_token`, `oauth_refresh_token`,
`oauth_consent`, `oauth_client_assertion`, plus the unused `oauth_resource` /
`oauth_client_resource`) are hand-written from `getAuthTables()` output. Every
`string[]`/`json` field is a `text` column: the drizzle adapter is configured
with `provider: "sqlite"`, which makes better-auth JSON-encode arrays itself.
`OauthClientDTO` reads them back with a tolerant JSON parse. Token and consent
rows cascade from the client's `client_id`.

**Client rows are written by Homerun, not through better-auth's client
endpoints.** `OauthAppService` (register, create, update, environments, secrets)
writes `oauth_client` through `OauthClientDTO`, the way the provider's own
registration does (list columns as JSON text, a 32-letter client id, no
`user_id`). Real, reported bug behind it: `adminCreateOAuthClient` /
`adminUpdateOAuthClient` load the session even as "server-only" admin endpoints,
run `clientPrivileges`, and `update-client` also requires the session user to
**own** the client (`client.userId === session.user.id`), so a second admin's
Settings or Environments save on an app failed with a bare `UNAUTHORIZED`, and
an API key (no session) could never manage an app at all. Two things the
provider did at registration are reproduced by hand: `registeredCallbacks` (test
callback, `native` when a callback is loopback) and, when `mcp()` is active
(`mcpAllowed(origin)`), linking the client to the MCP resource in
`oauth_client_resource` (`OauthClientDTO.linkResource`, seeding the
`oauth_resource` row like `seedResources` when the provider hasn't yet): the
provider's `enforcePerClientResources` defaults to true, so an unlinked client
asking for the MCP `resource` (a claude.ai connector) gets `invalid_target`;
`tests/integration/mcp.test.ts` covers it. Field validation the provider did is
Homerun's: `environmentProblem` (`oidc-provider.ts`, https callbacks, loopback
only with allow-localhost, origins) for the dashboard form and the REST body
alike. Apps created before this still carry the creating admin's `user_id`,
harmless now (deleting that user hands them over, `UserService`). REST:
`/api/v1/oidc-apps` (+ `/environments`, `/secrets`), Users & authentication
area; an app is created with no environment, and the API lets the last
environment go (the dashboard doesn't) so a Terraform destroy, which removes
environments before the app, goes through. Terraform: `homerun_oidc_app`,
`homerun_oidc_app_environment`, `homerun_oidc_app_secret` (`secret`
`returnedOnCreate`), in `resources-identity.ts`.

**Environments and secrets are Homerun's, not the provider's.**
`oauth_client_environment` (name, callbacks, authorized origins, allow
localhost) and `oauth_client_secret` (hash, label, hint, environment, last used;
a null environment plus `expires_at` is a test-sign-in secret). The client row's
`redirect_uris` is kept as the union of its environments' callbacks plus the
test callback (`OauthAppService.syncCallbacks`, after every environment change),
with `application_type: "native"` when any is loopback, since the provider
refuses loopback callbacks on `web` clients. Its `client_secret` holds
`homerun-secrets:<client id>`, and `storeClientSecret: { hash, verify }` in
`auth.ts` makes the provider's own check look that client's secrets up
(`OauthClientSecretDTO.verify`); `hash` is the provider's own SHA-256/base64url,
so a secret it generates at registration is moved into the table as is, and
pre-existing hashes kept verifying through the migration. `rotateClientSecret`
isn't used any more (it would overwrite the marker). The environment rules the
provider can't express are enforced by `guardTokenRequest` in `hooks.server.ts`
before `/oauth2/token` reaches it: a code is redeemed only with a secret of the
environment its `redirect_uri` belongs to, a browser `Origin` must be one of
that environment's authorized origins (which also get CORS headers and a
preflight answer), and the test callback and test secrets are refused there,
since only `OauthTestService` uses them, calling `auth.handler` directly. The
token endpoint auth method is written straight to the row
(`setTokenEndpointAuthMethod`), the provider's update endpoint doesn't take it.

**Three request-path changes the provider needed**, all verified by
`tests/e2e/ui-oidc-provider.spec.ts` (register, signed-out authorize → sign-in →
code, token exchange, id_token claims, userinfo, consent):

1. **CSRF.** SvelteKit's `csrf.checkOrigin` runs before any hook and 403s
   `application/x-www-form-urlencoded` POSTs without a same-origin `Origin`,
   which is exactly what an app's server sends to `/oauth2/token`. It's turned
   off (`csrf: { trustedOrigins: ["*"] }` in `vite.config.ts`) and reimplemented
   as `csrfHandler`, first in `hooks.server.ts`'s sequence
   (`src/lib/server/csrf.ts`), exempting only the token, introspect, revoke and
   end-session paths. Remote-function origin checks are separate in SvelteKit
   and unaffected.
2. **API keys.** `applyApiKeyAuth` treats any `Authorization: Bearer` without a
   session as an API key and 401s it; `isOidcProviderPath` skips that fallback
   for `/oauth2/*`, `/.well-known/*` and `/jwks`, since userinfo is called with
   an OAuth access token.
3. **Sign-in resume.** `/oauth2/authorize` without a session redirects to
   `/auth/sign-in?<original params>&sig=…`; `oauthProviderClient()` in
   `auth-client.ts` adds the signed query to every non-GET auth call from that
   page, and the provider's after-hook answers the sign-in (password, 2FA
   verify, passkey) with a redirect back into authorize. The sign-in page
   detects the flow (`sig` + `client_id`), names the app, shows "taking you
   back", and must not navigate itself (no `goto("/")`, no `redirectTo`), and
   its load doesn't bounce an already-signed-in user so `prompt=login` works.
