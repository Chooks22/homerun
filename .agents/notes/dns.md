# DNS automation (Cloudflare, Pangolin)

Homerun reference notes, loaded on demand rather than every session. `CLAUDE.md`
holds the rules that always apply plus an index of the sibling notes in this
directory. These sections were split out of that file, so a "see X below/above"
in the text below may now point at a section living in a sibling note rather
than in this one.

## Domains and DNS providers (`src/lib/services/dns-providers/`, `DomainDnsService`, `/dns`)

DNS is managed through **connections** (`dns_connection`: a provider id, a name,
credentials stored per field with the secret ones `encryptSecret`ed) and
**domains** (`domain`: a name, the connection and zone it lives in, a `target`
its services' records point at, `autoRecords`). Every provider implements one
`DnsProviderClient` (`types.ts`: list zones, list/create/update/delete records,
full names in and out, CNAME/MX targets without the trailing dot, TXT unquoted)
and registers a `DnsProviderDefinition` in `index.ts` (its credential fields
drive the connection form). Shared helpers: `http.ts` (`providerRequest`, name
conversion), `rrset.ts` (for rrset APIs: one `DnsRecord` per value with a
composite id, rewriting the set on change), `sigv4.ts` (Route 53). Each has a
stubbed-API test under `tests/unit/app/dns-providers/`; none has run against a
real account. Hetzner targets the Hetzner Cloud API: the old dns.hetzner.com API
was shut down in May 2026.

`DomainDnsService.syncHostname`/`deleteHostname` replace Cloudflare's entry in
`dns.service.ts`'s fan-out: the most specific domain covering a hostname
decides; a record Homerun creates is tracked in `dns_managed_record`, and only
tracked records are ever updated or deleted (most providers have no comment
field to mark ownership). A record someone made on the name is reported and left
alone. Migration 0088 turned the old `cloudflare_api_token_enc`/`zone_id`
instance settings into a connection plus the base domain (the ciphertext moved
as is, it's the same scheme), and `dns_provider` is now just Pangolin on/off.

## Certificates over DNS-01 (`domain.dnsChallenge`, `src/lib/acme-dns.ts`, `AcmeDnsService`)

A domain linked to a connection can opt into DNS-01 (for wildcard certs and
hosts behind Cloudflare's proxy where HTTP-01 fails). Traefik gets a second
resolver, `letsencrypt-dns` (`DNS_CHALLENGE_RESOLVER`), on lego's **httpreq**
provider, whose `HTTPREQ_ENDPOINT` is this app (`/api/acme-dns/present|cleanup`,
at the origin of `config.authCheckUrl`, the address Traefik already reaches it
on for forwardAuth) with Basic auth `homerun:<HMAC of AUTH_SECRET>`.
`AcmeDnsService.handle` writes or removes the TXT record through the most
specific opted-in domain's own `DnsProviderClient`, so all sixteen providers
work with no per-provider lego mapping and Traefik never holds a credential.
Records are added, never replaced: the apex and the wildcard are validated on
the same `_acme-challenge` name at once (`rrsetEditor` appends a value), and
they're not tracked in `dns_managed_record`, whose unique index is one row per
name and type.

The resolver is static config: `DockerService.applyDnsChallenge` puts its flags
(storage and email copied from the HTTP-01 resolver's flags on the running
command, so both share `acme.json`, keyed by resolver) and the `HTTPREQ_*` env
onto Traefik through `applyTraefikFlags`, which now merges env as well as the
command, and `reassertTraefikConfig` re-applies it (or strips it) like the other
flags. `TraefikExpectation.dnsChallenge` drives drift and reassert.

Certificates: `config.traefik.dnsChallengeDomains` (set by
`AcmeDnsService.load`, at boot, on every worker (re)boot and after a domain or
connection change, never by `applyInstanceSettings`) feeds `certResolverFor`: a
host the domain's wildcard names cover (`wildcardNames`: the domain, `*.domain`,
and `*.<serviceDomain()>` when that's below it) gets **no** resolver and takes
the cert from Traefik's store; a deeper host gets the DNS resolver directly. The
wildcard itself is requested by one router per domain in
`homerun-acme-wildcards.yml` (dynamic dir): a `Host()` rule on
`_acme-wildcard.<domain>`, service `noop@internal`, `tls.domains` asking for the
names. Not live-tested against a real ACME account yet.

## Pangolin, and the history of the Cloudflare integration (`src/lib/services/pangolin.service.ts`)

The DNS-provider automation gap this doc used to list under Planned features is
closed: two optional integrations, configured on the admin-only `/dns` page
(Integrations in the sidebar), DB-backed on `instance_settings`, both unset by
default. **Only one runs at a time**: `instance_settings.dns_provider` picks it,
and `cloudflareConfigured`/`pangolinConfigured` are true only for the chosen
provider, so every consumer (DNS fan-out, Newt, Pangolin's TLS and sign-in
handling) follows the choice without knowing about it. The other provider's
credentials stay stored (`cloudflareCredentialsSet`/`pangolinCredentialsSet`)
but inert. Saving a provider's settings with none chosen makes it the provider,
which is how onboarding's Pangolin step keeps working. Migration 0060 backfills
the choice from whatever was configured, Pangolin first. The page also lists the
active provider's domains (`CloudflareService.listZoneNames`,
`PangolinService.listDomainNames`), streamed from `load` so a slow API never
holds the page. Both are instance singletons that re-read `InstanceSettingsDTO`
on every call rather than caching, the admin can change credentials mid-session
and syncs are infrequent (once per deploy), same reasoning as
`GitProviderService`. Both fire from the same spot, `deploy.service.ts`'s
`syncAutoDns`, right after a successful **local** deploy with `dnsResolvable`
set, for **every** hostname the service answers on (`serviceHostnames()` in
`src/lib/service-domains.ts`: the default `<slug>.<baseDomain>` hostname while
it's still routed, plus each of `domains`, which used not to be synced at all).
Neither can fail the deploy.

**They are no longer fire-and-forget, and that was the whole bug behind
"Pangolin is configured and nothing gets created".** Both `syncDnsRecord`s
caught their own failures into a `logger.warn` and returned `void`, so a
misconfiguration was indistinguishable from a working setup. Every entry point
now returns a `DnsSyncResult` (`src/lib/services/dns-result.ts`,
`{provider, ok, detail}`, `null` when that provider isn't configured);
`dns.service.ts`'s `syncDns`/`deleteDns` take an **array** of hostnames and
return every provider's verdict, and `syncAutoDns` awaits that and appends each
one to the deployment's own log
(`DNS (pangolin): created app.example.com -> tunnel:80`, or
`DNS failed (pangolin): no registered Pangolin domain covers …`). The user sees
it on the Overview tab's deploy log where they're already looking, instead of in
a server log line nobody reads.

- **`CloudflareService`**: for instances that own DNS on Cloudflare directly.
  `syncDnsRecord(hostname, target)` upserts a CNAME (`<slug>.<baseDomain>` →
  `baseDomain`) via the Cloudflare v4 REST API;
  `deleteDnsRecord(hostname, target)` removes it on service delete;
  `verifyZoneAccess(token, zoneId, baseDomain)` backs the Settings page's and
  the onboarding wizard's "Test connection" button. Config: `instanceSettings`'s
  `cloudflareApiTokenEnc` (AES-256-GCM, same scheme as every other `*Enc`
  column) + `cloudflareZoneId`.
- **`PangolinService`**: for instances fronted by a self-hosted
  [Pangolin](https://github.com/fosrl/pangolin) tunnel/reverse-proxy manager
  instead of owning DNS directly. `syncDnsRecord(hostname)` creates a Pangolin
  **Resource** (a subdomain under one of the org's already-registered Pangolin
  domains matching the hostname) plus a **Target** pointing at this host's own
  Traefik entrypoint through the configured "main site"'s tunnel;
  `deleteDnsRecord(hostname)` removes the Resource;
  `verifyConnection({baseUrl, token, orgId, siteName, baseDomain})` backs its
  own "Test connection" button. Config:
  `pangolinApiBaseUrl`/`pangolinApiTokenEnc`/`pangolinOrgId`/`pangolinMainSiteName`
  (all four required to activate) + optional `pangolinTargetPort` (defaults to
  80, Pangolin terminates public TLS itself). Both services use plain
  hand-rolled `fetch` calls rather than an `openapi-fetch` client, same posture
  as `GitProviderService`.

**The Target is `https` against 443, and that is what fixed "routes are created
but we hit a 404".** Every router Homerun writes lives on
`config.traefik.entrypoint` (`websecure`) with `tls=true`, so a Target pointing
at port 80 reached a Traefik entrypoint with **no matching router** and Traefik
answered its own 404 — the tunnel was working, the request just landed nowhere.
`targetScheme(port)` maps 80 to `http` and everything else to `https` (`method`
is a free-form nullable string in the Integration API's own schema), and
`pangolinTargetPort` now defaults to **443**. TLS is therefore terminated twice
on purpose: Pangolin for the public connection, Traefik again for the hop from
the tunnel to the container. With DNS pointing at Pangolin rather than this
host, Traefik's own HTTP-01 challenge can't complete, so that inner certificate
is usually its self-signed default — which is fine, nothing verifies it, but
it's why the inner hop is encrypted rather than trusted. Which host the Target
points at is detected, see below. For the same reason, no router asks for an
ACME certificate at all while Pangolin is configured: `certResolverFor`
(`docker/cert-resolver.ts`, used by `buildContainerLabels` and the dashboard
router) drops the certresolver when `config.pangolinEnabled` is set, and for IP,
`localhost` and dotless hosts, which Traefik otherwise retried forever.

**Every resource Homerun creates has Pangolin's own SSO gate turned off, and
that is what fixed "the route exists, the tunnel is up, and the service is still
unreachable".** `resources.sso` defaults to **true** in Pangolin, and
`PUT /org/{orgId}/resource` is a `strictObject` with no `sso` field, so a
created resource is gated and nothing in the create call can say otherwise: a
browser got a 302 to `pangolin.example.com/auth/resource/…` and an API client a
bare `401 Unauthorized`, for every service the instance published.
`setResourceSso` therefore follows every create with `POST /resource/{id}`
`{"sso": false}`, **and does the same on the already-exists path** (skipped when
the listed resource's effective `sso` already matches), so redeploying a service
heals a resource created before this (there's no other way to reach the ones
already made — the exists check returns early). A failed SSO update is reported
as a failed sync rather than a success, since a gated route is exactly as
unreachable as a missing one. Access control for a deployed service belongs to
this app's own per-service login wall (see `auth.md`), not to a second,
invisible gate at the edge — **unless the admin says otherwise**:
`instance_settings.pangolinOwnsAuth` ("Let Pangolin handle sign-in", the
Pangolin card on `/dns`, default off) flips it, creating Resources with
`sso: true` and making `api/v1/auth-check` answer 200 for every gated service,
so Pangolin's own login is the only one a visitor sees instead of two in a row.
That endpoint runs on every proxied request, so it reads
`config.pangolinOwnsAuth` rather than querying the DTO; `toConfigOverride()`
only reports it true when Pangolin is actually configured.
`instance_settings.pangolinTargetHost` (same card) is the address a created
Target points at. **Unset means detected, not `localhost`, and that is what
fixed "the route exists and answers 502".** A fresh instance that deployed newt
as a Homerun service had it on the `homerun` network, so `localhost` was newt's
own loopback (`dial tcp [::1]:443: connection refused` in newt's log).
`DockerService.tunnelTargetHost` (pure logic in `docker/tunnel.ts`) returns
Traefik's container name when a running `fosrl/newt` container shares a network
with it, and `localhost` for host networking or no local newt container. A set
value always wins (newt on another machine). **The already-exists path heals the
target too**, like SSO: `ensureTarget` leaves a matching target alone, adds one
if the resource has none, and otherwise `POST /target/{id}`s the first one to
the wanted host, so a redeploy repairs a resource created with the wrong host.
**Diagnosed against a real instance**, not from the docs: Traefik on the host
answered `200` for `curl -k -H "Host: <slug>.<domain>" https://127.0.0.1` while
the public hostname answered `401`, with the target already correct
(`localhost:443`, `method=https`, site online).

**Newt is core infrastructure, not a service.** It used to be a `builtin-newt`
template the admin deployed as an ordinary service, so it sat in the services
list and could be redeployed, scaled or deleted like an app.
`instance_settings.pangolinNewtEndpoint`/`pangolinNewtId`/`pangolinNewtSecretEnc`
(Pangolin card and the onboarding DNS step, all three or none, checked by
`newtFieldsError` in `dns-settings-form.ts`) now drive
`DockerService.syncNewt(credentials, swarm)`, which converges one `homerun-newt`
workload (specs in `docker/newt.ts`): a plain container on the shared network in
standalone mode, and in swarm mode a one-replica swarm service on the swarm
overlay (which Traefik is attached to), pinned with a `node.id ==` constraint to
this node, where Traefik runs, so the tunnel reaches Traefik by name and
`tunnelTargetHostFrom`'s local container listing sees the task. Whichever form
the current mode doesn't use is removed first, so switching the orchestration
mode (`settings/docker`'s `updateOrchestration` resyncs it) swaps one for the
other. Both are labelled `homerun.core=newt` (the service's task containers too)
rather than the managed label, so no service list or reconcile sees them, while
`listInfraContainers` does (System logs). A `homerun.core.hash` label of the
spec (mode and node included for the service) makes the sync a no-op unless
something changed. It runs on boot and from `applyAndRebuild`, and
`InstanceSettingsDTO.newtCredentials()` is null (so both are removed) whenever
Pangolin itself isn't fully configured. Neither is part of the compose project,
so self-update never recreates or removes it. The swarm form goes through the
worker's `POST /v1/swarm/services` and `GET /v1/swarm/services/{id}` (id or
name). Seeding deletes the retired template row; a service an admin already
deployed from it stays and has to be deleted by hand.

**Editing a service's domains syncs right away**, not on its next deploy: the
Networking tab's `updateDomains` fires `syncServiceDomainsDns(previous, next)`
for a `dnsResolvable` service, syncing every current hostname and deleting the
ones it dropped. Real bug it fixed: with Pangolin connected, a newly added
domain got no resource until someone redeployed. Traefik still needs the
redeploy to route it, which is what the save toast says.

**A moved services domain releases the old default hostnames on each service's
next successful deploy**, not when the setting is saved: until that deploy,
Traefik still routes the old `<slug>.<serviceDomain>` and the new one has no DNS
yet, so deleting right away would take every service offline.
`InstanceSettingsService.saveCore` reads `serviceDomain()` before saving and
hands it to `markStaleServiceDns`, which appends each routed service's old
default hostname to `service.staleDnsHosts` (text[], kept out of the REST output
by `serviceApiJson`), dropping one the change brings back. A service whose
default hostname is off or that isn't `dnsResolvable` is skipped.
`finalizeWorkerDeploy` then fires `releaseStaleServiceDns`, which deletes every
listed host `hostnameOwner` says nothing routes any more (not a core host, a
workstation, a redirect, this service or another), and empties the list whatever
the providers answer. Covers a base domain change too, since `serviceDomain()`
moves with it.

**`deleteDns` never deletes a core host.** It drops every hostname in
`coreHosts()` (`server/hostname-owner.ts`: the dashboard's host from
`config.auth.origin`, `registryPublicHost`, `garagePublicHost`, every status
page domain) before fanning out, and logs a warning instead. Real bug it fixed:
a service given the dashboard's domain, then changed or deleted, deleted the
dashboard's Pangolin resource and locked the user out until a restart re-ran
`syncDashboardDns`. The same hosts are refused at save time (services through
`serviceDomainConflicts`, redirects in `parseRedirectInput`, workstations
through `hostnameOwner`). A core host's own move still deletes the old record:
`syncCoreHostDns` runs after the setting is saved, so the old host is no longer
in `coreHosts()` by then.

**The dashboard's own hostname is synced too.** `dns.service.ts`'s
`syncDashboardDns` runs on boot and after every settings save
(`applyAndRebuild`), next to `syncDashboardRouter`, for the Dashboard URL's host
(skipped for IPs and bare hostnames), always with Pangolin SSO off since the
dashboard has its own sign-in and the CLI needs the API unauthenticated at the
edge. Before, setting a dashboard domain created nothing in Pangolin. It also
depends on the dashboard router file actually being written:
`/app/traefik-dynamic` is a named volume that started root-owned while the app
runs as `bun`, so every write failed with `EACCES`. The image now creates the
directory `bun`-owned and `entrypoint.sh` chowns it for volumes made before
that.

Two failure modes live **outside** this client and look identical from a
browser, worth checking before touching code again: a Pangolin domain with
`preferWildcardCert: true` and no wildcard actually issued serves Pangolin's
Traefik default self-signed certificate for every subdomain (the apex keeps its
real one, so "the dashboard works and the services don't" is the tell), and an
instance whose generated `compose.yaml` predates the `DASHBOARD_DOMAIN` router
has no Traefik labels on its own `app` service at all.

**Pangolin's OpenAPI document is fetchable after all**, contrary to what this
section used to say (a "the OAS is broken, the types are guesses" note inherited
from the sibling `dokploy-to-pangolin` project):
`GET https://api.pangolin.net/v1/openapi.json` serves the real 3.1 document, and
`/v1/docs` is just a Swagger UI widget over it. Every path and request body this
client sends is now checked against that document plus `fosrl/pangolin`'s own
route source. Three things it settled, all of which matter:

- **The base URL is the Integration API, not the dashboard.** It's a separate
  server (port 3003 by default) that a self-hosted instance only exposes once
  it's enabled, and its base path ends in `/v1`. The Settings placeholder used
  to say `https://pangolin.example.com/api/v1`, which is the cookie-authed
  dashboard API and rejects an API key. `pangolinRequest` (`pangolin/http.ts`)
  now names that case specifically when a response body is HTML rather than
  JSON.
- **Every list endpoint is paginated, and `/sites` and `/resources` default to
  20 per page.** The old client read page one and stopped, so `findMainSite`
  silently missed a site and the already-exists check silently missed a resource
  on any org bigger than that. `pangolinListAll` (`pangolin/http.ts`) now
  follows `pagination.total` (recursively, since this repo's `noAwaitInLoops`
  rule forbids the obvious loop). Note the two parameter spellings: `/sites` and
  `/resources` page with 1-based `page` + `pageSize`, `/domains` with `offset` +
  `limit`.
- **Resource creation bodies are `z.strictObject`**, so an unknown field is a
  400, not an ignored key. `http: true` + `protocol: "tcp"` are deprecated in
  favour of `mode`, but still accepted, and are kept deliberately: an older
  self-hosted instance wouldn't know `mode`, and strict parsing would reject it.

`verifyConnection` deliberately checks the **whole** configuration, not just
that the token authenticates: it first confirms the org itself exists
(`GET /org/{orgId}`, a 404 reported directly as
`Organization "X" doesn't exist…` rather than falling through), since Pangolin
answers a _list_ call for an unknown org with an empty 200 — a typo'd org ID
used to surface three steps later as "no registered domain", which reads like a
domain problem, not an org one. It then confirms the named site exists and one
of the org's registered domains covers this instance's `baseDomain`, since
without either no resource can ever be created. The old version listed sites and
called it a pass, which is how a setup that could never work reported "Org
access verified". `tests/unit/app/pangolin.test.ts` drives all of this against a
stubbed API that caps pages at 10 rows regardless of the requested size, so a
client that stops after page one fails the test.

**Live-verified, not just built from the docs and offline audit below**:
Pangolin's side ran against a real `homelab` org, site `homerun-live-test`,
domain `chibre.space`, and passed end to end. That run also caught a real bug
the offline audit's stub didn't: `/resources`' list endpoint reports `sso` as
`0`/`1`, not a JSON boolean, so `healResource`'s `resource.sso !== sso` never
matched and re-wrote the flag on every single deploy. `sso` is now
`boolean | number` on `PangolinResource` and compared with
`Boolean(resource.sso) !== sso`. Cloudflare hasn't been tried against a real
account yet, see the note at the end of this section.

Both integrations can also be switched on from the onboarding wizard's DNS step
(see `auth.md`'s Onboarding section). Its form parsing and Test connection
checks are the same functions the DNS page uses,
`src/lib/server/validation/dns-settings-form.ts` (`cloudflareInputFromForm`,
`pangolinInputFromForm`, `testCloudflareFromForm`, `testPangolinFromForm`), so
the two surfaces can't drift. The wizard tests Pangolin against the base domain
typed in its own Core step, not the running one.

## Offline API audit (Cloudflare v4 docs, Pangolin 1.23.0 source)

Checked against `developers.cloudflare.com/api` and `fosrl/pangolin` tag
`1.23.0` (`server/routers/integration.ts` and the route files it mounts), no
real account involved. What it changed, all covered by
`tests/unit/app/cloudflare.test.ts` and `tests/unit/app/pangolin.test.ts`:

- **Cloudflare envelope.** Every response is
  `{success, errors: [{code, message}], messages, result}`; `request()` now
  unwraps `result`, throws on `success: false` even with a 2xx, renders errors
  as `[code] message`, survives a non-JSON edge page (a 502 used to throw a bare
  `SyntaxError`), and names `Retry-After` on a 429 (limit: 1,200 requests per 5
  minutes per user, then 5 minutes blocked).
- **Cloudflare lookup** lists by `name.exact` with **no** `type` filter. The old
  `type=CNAME` lookup missed an A/AAAA record on the name, then the create
  failed with `81053` ("An A, AAAA, or CNAME record with that host already
  exists"); that case is now reported and left alone.
- **Cloudflare update is `PATCH`, not `PUT`**, and only when the content
  differs. `PUT` overwrites the record, so every redeploy reset a hand-set
  `proxied`/TTL/comment. The body echoes `name`/`type`/the existing `ttl`, which
  the documented CNAME schema marks required. Creates carry
  `comment: "Managed by Homerun"` (the Free plan caps comments at 100
  characters), and delete only removes a CNAME that points at `baseDomain` or
  carries that comment; a 404 on delete counts as gone.
- **Cloudflare skips** a hostname outside the zone (`GET /zones/{id}`'s `name`,
  e.g. a domain on another provider) and a hostname equal to its target (the
  create schema says content "must not match the record's name", which the
  dashboard host hit when it equals `baseDomain`). `/user/tokens/verify` isn't
  used since it rejects account-owned tokens; the zone read plus a
  `dns_records?per_page=1` read work for both.
- **Pangolin domain matching** (`matchPangolinDomain`, `pangolin/domains.ts`)
  mirrors `validateAndConstructDomain` (`server/lib/domainUtils.ts`): a
  `cname`-type domain's full domain is always its base domain, so it only
  matches exactly; the most specific registered domain wins (the old `find` took
  the first suffix match); the apex sends `subdomain: null`, because a
  `wildcard`-type domain builds `${subdomain}.${base}` from any non-null value
  and `""` became `.example.com`; an unverified domain is reported before
  Pangolin 400s on it. `verifyConnection` probes `service.<baseDomain>` rather
  than the base domain itself for the same reason.
- **Pangolin idempotency.** Resource lookup compares `fullDomain`
  case-insensitively (Pangolin lowercases it) and ignores `mode: "inference"`
  resources, which may share a domain. A create answered `409` ("Resource with
  that domain already exists", a concurrent sync) re-lists and heals the winner.
  `ensureTarget` treats a target as correct only when host, port, `method`,
  `siteId` and `enabled` all match, and repairs the one on the same address
  before moving another, so a disabled or wrong-scheme target no longer passes
  as healthy. A resource disabled in Pangolin is reported, not re-enabled.
  Delete tolerates a 404.
- **Pangolin pagination totals** come from `count(*)`, which Postgres returns as
  a string; `pangolinListAll` coerces with `Number()`.
- **Confirmed unchanged in 1.23.0:** `Authorization: Bearer <apiKeyId>.<secret>`
  (`middlewares/integration/verifyApiKey.ts`), the error body
  `{data, success, error, message, status}`, `PUT /org/{orgId}/resource` still
  accepting the deprecated `http`/`protocol` pair (`mode` is the new field),
  `POST /resource/{id}` still taking `sso` (now written to the resource's inline
  policy), target create/update bodies, and the pagination parameters. The
  Integration API has no rate limiter of its own.

**Cloudflare is still not live-tested against a real registered account**, same
posture as `GitProviderService`'s OAuth flow: built from the documented API
shapes, verify the first real sync by hand once a zone/token is configured.
