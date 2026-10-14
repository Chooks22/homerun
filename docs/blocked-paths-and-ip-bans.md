# Blocked paths and IP bans

Advanced mode: [simple mode](ui-modes.md) hides the Blocked paths panel (unless
the service already blocks paths) and the IP bans settings tab. Everything here
keeps working either way, and a hidden page still opens from a link.

Bots scan every public address for the same things: `.env` files, `.git`
folders, WordPress login pages, database dumps. A service can tell Traefik to
turn those requests away before they reach the app, and Homerun can ban an
address that keeps trying.

## Blocked paths

On a service's **Security** tab, **Blocked paths** takes one pattern per line. A
request whose path matches one of them gets a 403 and never reaches the app.

- A pattern matches whole path segments anywhere in the path: `.git` blocks
  `/.git`, `/.git/config` and `/app/.git/HEAD`, but not `/.github`.
- Starting a pattern with `/` matches from the root only: `/admin` blocks
  `/admin` and `/admin/users`, not `/blog/admin`.
- `*` matches anything, slashes included (`*.sql` blocks `/backups/db.sql`), and
  `?` matches one character.
- Matching ignores case.

A pattern that would match every path (`*` or `/*`) is refused: stop the service
or turn on its login wall instead.

**Presets** add a ready-made list to the box, which you can then edit:

- **WordPress probes**: `wp-admin`, `wp-login.php`, `wp-config.php*`,
  `wp-content`, `wp-includes`, `wp-json`, `xmlrpc.php`. Don't use it on a real
  WordPress site.
- **Sensitive files**: `.env` and `.env.*`, `.git`, `.git-credentials`,
  `.gitconfig`, `.svn`, `.hg`, `.aws`, `.ssh`, `.htpasswd`, `.htaccess`,
  `.npmrc`, `.DS_Store`, SQL dumps, backups and editor swap files, private keys.
- **Admin tools**: `phpmyadmin`, `phpinfo.php`, `adminer.php`, `server-status`,
  `cgi-bin`.

Saving redeploys a running service, since the rule is part of its Traefik
routing; a stopped service picks it up on its next deploy. Blocked paths apply
on every one of the service's domains, before its login wall, and its pull
request previews and canary inherit them.

Visitors see the **Blocked path** page, branded and worded under
[Settings → Error pages](error-pages.md). Without Traefik's dynamic config
directory (Settings → Networking), Traefik answers a bare 403 instead, and
blocked requests aren't counted towards a ban.

## IP bans

Every blocked request is counted against the address it came from. An address
that makes too many of them is banned on every service at once: Traefik answers
all its requests with a 403 until the ban ends. **Settings → IP bans** sets the
rule, on by default:

- **Blocked requests**: how many it takes (10 by default),
- **Within**: in how many minutes (10 by default, up to a day),
- **Ban for**: how many hours the ban lasts (24 by default, 0 for good).

**Monitoring → Blocked IPs** (admins) lists the banned addresses, why and until
when, each with an **Unban** button, and under **Being counted** every address
that requested a blocked path within the window but isn't banned yet: how many
requests it made against the threshold, the last host and path it asked for, and
when. Expired bans are lifted within a minute. Turning bans off keeps blocking
the paths and only stops new bans; bans already in place stay until they expire
or you lift them.

The dashboard's own address is never blocked by a ban, so a banned admin can
still sign in and lift it.

The rule and the [CrowdSec](#crowdsec) push can also be set from Terraform with
`homerun_ip_ban_settings`, see
[Infrastructure as code](infrastructure-as-code.md#resources).

### Mean mode and Disrespect mode

Two more toggles on **Settings → IP bans**, both off by default, change what a
blocked request gets back while it still counts towards a ban:

- **Mean mode**: a request for a secret-shaped path (`.env` and `.env.*`,
  `.git/config`, `wp-config.php` and other PHP configs, `.aws/credentials`, an
  SSH private key, a `.sql` dump, an archive or `.bak`) gets a `200` and a fake
  file instead of the blocked page. The secrets in it look real (an `AKIA…` AWS
  key, an `sk_live_…` Stripe key) but are random, and an archive is half a
  megabyte of junk. A scanner that trusts it wastes its time on dead
  credentials.
- **Disrespect mode**: the same fake files, with every secret an insult
  (`PROD_API_KEY=fuckyou`) and an archive's bytes spelling one out, and any
  other blocked path gets a one-line insult instead of the blocked page.

Both only answer paths you blocked on a service: add `.env`, `.git` or `*.sql`
to its blocked paths for scanners to get there.

To hear about bans as they happen, turn on **IP banned** for a channel under
**Profile → Notifications** (it's off by default): each new ban sends the
address, until when, the host it was hitting and the reason, linking to Blocked
IPs. See [Notifications](notifications.md).

**Which address gets banned.** It's the address Traefik sees the request come
from. Behind Homerun's own Pangolin tunnel (Newt credentials set on the DNS
page), that's the visitor: Homerun tells Traefik to believe the visitor address
Pangolin forwards, from the tunnel container and nothing else. Behind any other
proxy or tunnel (Cloudflare's proxy, a load balancer, a Newt you run yourself),
it's the proxy. Homerun never bans a private, loopback, link-local or
carrier-grade NAT address (which is how a tunnel or a Docker network reaches
Traefik), nor an address in Cloudflare's published proxy ranges, so a proxy
can't get every visitor behind it banned. Behind such a proxy, blocked paths
still work; bans just don't happen. Only requests that really went through a
blocked-paths router count: requesting the Blocked path page directly never
does.

## CrowdSec

If a [CrowdSec](https://www.crowdsec.net) agent guards the server in front of
Homerun (a Pangolin server, typically, with its firewall bouncer), Homerun can
hand it every ban, so the address is dropped at that server before it reaches
yours, on every port.

1. On the CrowdSec host, register Homerun as a machine:
   `cscli machines add homerun --password <password>`. A bouncer key won't do,
   bouncers can only read decisions.
2. Make the Local API reachable from Homerun over HTTPS. By default it only
   listens on `127.0.0.1:8080` on its own host.
3. Under **Settings → IP bans → CrowdSec**, enter the LAPI URL, the machine id
   and its password, and save. Saving logs in first and refuses credentials that
   don't work. Clear the URL to stop.

Each new ban becomes a CrowdSec `ban` decision for the ban's length (ten years
for a ban for good) and shows up in `cscli decisions list`, with "homerun:" and
the reason as its scenario. **Unban** on Blocked IPs deletes every decision on
that address, CrowdSec's own included. CrowdSec expires decisions itself. A
failed push shows up among Homerun's own errors on
[System Logs](system-logs.md), and the ban still applies in Homerun's own
Traefik.

**Monitoring → CrowdSec** (admins) reads the Local API live, in three tabs, each
paged:

- **Decisions**: every decision CrowdSec's bouncers enforce right now from its
  own scenarios, manual bans and Homerun's, with the address's country and
  network when CrowdSec knows them, its reason and origin and when it ends. Bans
  Homerun pushed are marked **Homerun**. **Delete** lifts one decision; it
  doesn't lift Homerun's own ban on the same address, which stays under Blocked
  IPs. **New decision** bans an address through CrowdSec only, for a number of
  hours (0 for ten years) with a reason. Homerun's own Traefik isn't told.
- **Alerts**: what CrowdSec's scenarios caught in the last 24 hours.
- **Community blocklist**: the addresses the CrowdSec community reported, tens
  of thousands of them, searchable by address or scenario. Homerun reads the
  list at most once a minute.

A firewall bouncer drops everything from a banned address, the dashboard
included when it's served through the same server. Homerun's own exception for
the dashboard doesn't reach that far: lift the ban from another network, or with
`cscli decisions delete --ip <address>` on the CrowdSec host.
