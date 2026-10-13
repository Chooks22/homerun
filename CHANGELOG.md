# Changelog

## [1.0.58](https://github.com/orochibraru/homerun/compare/v1.0.57...v1.0.58) (2026-10-13)

### Features

- **workstations:** presets, git sign-in, devcontainer detection and dev.
  domains (#104)
  ([b95c7eb](https://github.com/orochibraru/homerun/commit/b95c7eb5220d91e8a7b1a6489b1dbfbc5c36f822))

### Bug Fixes

- stop Souin's broken 304 from resetting HTTP/2 streams and serve … (#107)
  ([975a228](https://github.com/orochibraru/homerun/commit/975a228b5b4654ec16015f37af131ef36d6e07ae))

## [1.0.57](https://github.com/orochibraru/homerun/compare/v1.0.56...v1.0.57) (2026-10-13)

### Features

- **workstations:** editor and git setup, per-section settings and observability
  (#102)
  ([6c70b9c](https://github.com/orochibraru/homerun/commit/6c70b9c19ada2039e46765ce6198bd9d0d63d467))
- add image version pinning and update checks (#101)
  ([526d49f](https://github.com/orochibraru/homerun/commit/526d49f7ae31d62e4fc3fa8520dd5b6c2ae843fa))
- workstation auto-stop, live cron runs with a run detail page and inline volume
  creation, broad MCP tool coverage, drop the dashboard's unread notifications
  ([50608f1](https://github.com/orochibraru/homerun/commit/50608f1b71749976a1237657c2d180a0a98c4029))
- cron job volumes, user, socket and tabs; mean/disrespect bait for blocked
  paths; CIMD for MCP sign-in and a dedicated MCP docs page
  ([172b25a](https://github.com/orochibraru/homerun/commit/172b25a5e7fd815ffd69603473b4a4b86e865129))
- **workstations:** add git repo picker, logs viewer, and self-test (#96)
  ([95d7ad5](https://github.com/orochibraru/homerun/commit/95d7ad5f8beda66f1fbc2019c4bdbaf8f141b306))
- CrowdSec sub-tabs for decisions, alerts and a searchable, paged community
  blocklist
  ([93ba9d0](https://github.com/orochibraru/homerun/commit/93ba9d02ede283a6600d5b45226135efe45cd369))
- script cron jobs with file support and multiple runtimes (#93)
  ([bf09c66](https://github.com/orochibraru/homerun/commit/bf09c669eff4495579ec15b184108aeb05411557))
- add dev workstations with browser IDE support (#92)
  ([5035ef1](https://github.com/orochibraru/homerun/commit/5035ef13984a1524c1e49e2306faa33bade3bd3f))
- real visitor IP behind the Newt tunnel for IP bans, CrowdSec ban push and a
  CrowdSec page under Monitoring
  ([b0c3b1a](https://github.com/orochibraru/homerun/commit/b0c3b1a83d007b00dcc93348131ce97a3917e890))
- opt-in notification grouping per channel, notification settings under
  /notifications/settings, tab-only fallback for browsers without a push service
  ([7227a90](https://github.com/orochibraru/homerun/commit/7227a908b82901d928889d2e51e29001737be826))
- web push browser notifications via service worker, browser channel kind and
  build/deploy started events (#53)
  ([036c486](https://github.com/orochibraru/homerun/commit/036c4867244767aec97ef8e70e450b4e38d8b0bc))
- notifications page, dashboard unread summary, in-app scheduled tasks summary,
  stacked grouped channel messages and browser notifications
  ([72dc436](https://github.com/orochibraru/homerun/commit/72dc4361baea77adbde9a65ac028c9823198a3fa))
- show job traces on the scheduling job page and run the OpenTelemetry collector
  by default
  ([ab39631](https://github.com/orochibraru/homerun/commit/ab39631b3652daf02eba05c3313df036bc631404))
- permission presets and editable API key permissions
  ([b94220b](https://github.com/orochibraru/homerun/commit/b94220b408dd673642e105f98d6fe48e8595adf1))
- IaC projects with per-project tabs and tool choice, and git watch/ignore paths
  for push deploys
  ([3f9033e](https://github.com/orochibraru/homerun/commit/3f9033e39a3f55b8e14543b144d603f02560065f))

### Bug Fixes

- update stale e2e tests and keep bake --print fixtures out of biome
  ([0638025](https://github.com/orochibraru/homerun/commit/0638025cfc5d18e038f13ae67d079bb9edeecad5))
- **builds:** ignore cacheonly bake context targets when resolving the bake
  target
  ([f00aa07](https://github.com/orochibraru/homerun/commit/f00aa0742190605833aafa4bdd4b972160fb5d52))
- route workstations through Pangolin/DNS sync and stop calling a CrowdSec 502 a
  refused login
  ([392202a](https://github.com/orochibraru/homerun/commit/392202adbac4e1d7147732171209f59443b15994))
- stack delete refuses mid-deploy with force, typed-name confirm, volume choice
  and overview; give icon URLs an extension so CrowdSec stops banning
  ([2f2cd36](https://github.com/orochibraru/homerun/commit/2f2cd36b04d84724a5f10116266c934f2291bccd))
- serve public buckets on the S3 custom domain and add empty/empty-and-delete
  bucket actions (#90)
  ([40e402e](https://github.com/orochibraru/homerun/commit/40e402e6c141d6be5af2f7e3eb71ef6d49805ce7))
- **deps:** update drizzle (#68)
  ([1c0c88a](https://github.com/orochibraru/homerun/commit/1c0c88a61919781ab57357dbfed5b2882b102fad))
- **deps:** update dependency @modelcontextprotocol/server to v2.3.1 (#84)
  ([8722397](https://github.com/orochibraru/homerun/commit/872239723db801bfd593e2da33beb94d147d4eb0))

## [1.0.56](https://github.com/orochibraru/homerun/compare/v1.0.55...v1.0.56) (2026-10-09)

### Features

- rework IaC, API keys, sidebar, tabs and glass default, background jobs with
  job pages, error boundaries, environment switcher, public buckets, S3 file
  browser and MCP toolsfeat: rework IaC, API keys, sidebar, tabs and glass
  default, background jobs with job pages, error boundaries, environment
  switcher, public buckets, S3 file browser and MCP tools
  ([6ad2d28](https://github.com/orochibraru/homerun/commit/6ad2d28cb8fd8c6788445767580929d37ed7a3bc))
- pull request previews for image-based services from CI, provider registry
  docs, and IaC backend matching with a stack/service combobox
  ([adca9c5](https://github.com/orochibraru/homerun/commit/adca9c59d0882c31fe9dc386c2b68c64f2a46ad1))

### Bug Fixes

- **auth:** answer 429 instead of 401 for rate-limited API keys and raise the
  per-key limit
  ([54fd9ec](https://github.com/orochibraru/homerun/commit/54fd9eca25e4916bb0cdde5b00ebe488516416d1))
- **iac:** link state projects to their bucket's access keys for Pulumi
  ([b74a62c](https://github.com/orochibraru/homerun/commit/b74a62c824ba5caf904f5e787329ce9f4984dd76))
- **iac:** point the provider snippets at Authorized Clients
  ([82628b0](https://github.com/orochibraru/homerun/commit/82628b066e05a0cf54641e74881bb2174a0bb625))

## [1.0.55](https://github.com/orochibraru/homerun/compare/v1.0.54...v1.0.55) (2026-10-07)

### Features

- area-based permissions for users and scoped expiring API keys, publish the
  Terraform provider, mirror Docker Hub pulls in CI
  ([44874af](https://github.com/orochibraru/homerun/commit/44874afd0125860dab7820c6f4cae6d533f2b131))

### Bug Fixes

- **ci:** prettier-format the generated screenshot index so nightly prek passes
  ([a76afb9](https://github.com/orochibraru/homerun/commit/a76afb90213a2dd7d809dad16a33acec1c7a8af2))

## [1.0.54](https://github.com/orochibraru/homerun/compare/v1.0.53...v1.0.54) (2026-10-07)

### Bug Fixes

- **e2e:** name the required status checks in the docs screenshot setup
  ([d84140a](https://github.com/orochibraru/homerun/commit/d84140afe83c0f05b87d091fae9b3595a1f28276))

## [1.0.53](https://github.com/orochibraru/homerun/compare/v1.0.52...v1.0.53) (2026-10-07)

### ⚠ BREAKING CHANGES

- sveltekit 3 (#45)
  ([bb111f2](https://github.com/orochibraru/homerun/commit/bb111f2355190b56ee1267332ba59a1964f88262))

### Features

- full CLI coverage with iac generate, backup destination free-space alerts, and
  custom domains for status pages
  ([ca4c5fd](https://github.com/orochibraru/homerun/commit/ca4c5fd49534ce0991ee1d5ecac9b5a9b1e3e18c))
- **iac:** generate a zipped Terraform project per stack or service,
  Shiki-highlightedfeat(iac): generate a zipped Terraform project per stack or
  service, Shiki-highlighted
  ([0764bc4](https://github.com/orochibraru/homerun/commit/0764bc493f801f5d6edb3ad72f5551c5911f95ee))
- OpenTelemetry tracing, a Terraform provider with full API coverage and an IaC
  page, simple and advanced UI modes, and IP ban alerts
  ([dcf3c8d](https://github.com/orochibraru/homerun/commit/dcf3c8dde16ad74224e3bf271b57a649308806fa))
- **storage:** object storage with a built-in Garage store, S3 providers,
  buckets and Terraform state
  ([f226ad4](https://github.com/orochibraru/homerun/commit/f226ad4dfdab6124d7dcb4ad1fbd034127a1a4b4))
- **login-wall:** dress a gated app's sign-in pages in the error pages' brand
  ([36857f4](https://github.com/orochibraru/homerun/commit/36857f4e3f38e6e91d5123a1206aab48cc6e5d53))
- **registry:** list repositories as a table and give each its own page with its
  tags
  ([df5fdf0](https://github.com/orochibraru/homerun/commit/df5fdf080bda77e34ab2b32a7cf8f335cf6616de))
- **security:** block path patterns per service, scope the login wall to paths,
  and ban IPs that keep hitting blocked paths
  ([e99282e](https://github.com/orochibraru/homerun/commit/e99282ee958c700dd66442931c72418e6db3a814))
- **registry:** stream the images tab and page and search its repositories
  ([bd31b7c](https://github.com/orochibraru/homerun/commit/bd31b7ce7435edea905128095711718905a9e892))
- **deployments:** stream the deployments list and give each deployment its own
  page with its log
  ([44a62d2](https://github.com/orochibraru/homerun/commit/44a62d22e2c95a1ef2d96a44f9c9cf61c6c61a8f))
- **services:** default a new git service's build cache to the built-in registry
  when it's running
  ([0af787b](https://github.com/orochibraru/homerun/commit/0af787b7a4a1392408cf3d11b010bf1ab3e1d370))
- **build-cache:** list the services using a build cache registry on its page
  ([16cf8c1](https://github.com/orochibraru/homerun/commit/16cf8c1a977e795301e74f4669a224591f477e92))
- **stacks:** move a focused diagram card or substack with Alt and the arrow
  keys
  ([39059e2](https://github.com/orochibraru/homerun/commit/39059e254f93e5f14fc35f8967d0bfecf91f797e))
- **error-pages:** link Homerun in the Powered by line to the project page
  ([7f19a7d](https://github.com/orochibraru/homerun/commit/7f19a7d57cee2805dc3d1eca850cb5f7f90470f5))
- service environments with presets, regrouped service tabs with path-routed
  sub-pages, GitHub deployments for every environment, built-in build cache, and
  review fixes
  ([abde2d3](https://github.com/orochibraru/homerun/commit/abde2d37c53e8cf5d5a5be96f6b023a83c1613bd))
- branded Traefik error pages, liquid glass rework, GitHub app permissions for
  previews, and screenshots across the docs
  ([b1f070f](https://github.com/orochibraru/homerun/commit/b1f070ff9bd9eef3ca29b34419037a2a675d4353))
- **previews:** comment the preview URL on GitHub pull requests and track it as
  a deployment environment
  ([4c5245a](https://github.com/orochibraru/homerun/commit/4c5245a05e10173f7378346c708a1e923c52ccfb))
- deploy already-open pull requests, section-header save buttons, keyboard
  navigation pass
  ([d041924](https://github.com/orochibraru/homerun/commit/d041924941951712ae8988d504a400b0994d7d87))
- fork ci suite (#46)
  ([c0bd9a8](https://github.com/orochibraru/homerun/commit/c0bd9a82af7dca4b9f0054a0c2c19f14513748f9))
- sveltekit 3 (#45)
  ([bb111f2](https://github.com/orochibraru/homerun/commit/bb111f2355190b56ee1267332ba59a1964f88262))
- **notifications:** edit, enable and disable notification channels
  ([48e33df](https://github.com/orochibraru/homerun/commit/48e33dfd18ae3da43ca89ef6b7fe30cec6673be2))

### Bug Fixes

- **ci:** unbreak nightly cleanup on missing tags and two stale e2e assertions
  ([4dcbdc5](https://github.com/orochibraru/homerun/commit/4dcbdc5d3a692f11cb481fd6549f645dbb4999e9))
- **iac:** keep code previews from overflowing the page on mobile, and put
  secret values in terraform.tfvars
  ([dacbeee](https://github.com/orochibraru/homerun/commit/dacbeeee2221cccaf4ef018866d4c52b93fde680))
- **api:** answer a rate-limited API key with 429 and Retry-After instead of
  401, and let the integration client wait it out
  ([f74f7ac](https://github.com/orochibraru/homerun/commit/f74f7acc7bdbc1d145d30924f9ef6eab61d45da8))
- **services:** show a git service's repo and branch in its header until it has
  an image
  ([58c4ca7](https://github.com/orochibraru/homerun/commit/58c4ca73a9994b9ebee709da62d3d97ca0421ca3))
- **a11y:** set the html lang attribute to en, missed by the previous commit
  ([3a9b7b1](https://github.com/orochibraru/homerun/commit/3a9b7b1d3d354ea2853116347df37aacd9efd16e))
- **a11y:** declare the dashboard's language as English
  ([3be80c8](https://github.com/orochibraru/homerun/commit/3be80c8e3ec33ccdee15998615adff1504f93732))
- **auth:** drop the dead sign-up link from the sign-in footer
  ([e255598](https://github.com/orochibraru/homerun/commit/e255598a337c09b33dcbaae271e7873d7399eaae))

### Documentation

- **agents:** point repo-gate, scaffold-feature and subproject-sync at SvelteKit
  3 and src/lib paths
  ([7e849e6](https://github.com/orochibraru/homerun/commit/7e849e6d1e61dde3cf470a8237ce1d36fa434a53))

## [1.0.52](https://github.com/orochibraru/homerun/compare/v1.0.51...v1.0.52) (2026-10-01)

### Bug Fixes

- **docs:** list the six unlisted pages in docs/config.json and test that every
  page is listed
  ([d2c8b0b](https://github.com/orochibraru/homerun/commit/d2c8b0bebe939d8d8b8ccf5ca24c8d8392ae64af))

## [1.0.51](https://github.com/orochibraru/homerun/compare/v1.0.50...v1.0.51) (2026-09-30)

### Documentation

- use the feature graphic as the README hero
  ([939fe0b](https://github.com/orochibraru/homerun/commit/939fe0bd9470ad4736a29115b290513cf2e449eb))

## [1.0.50](https://github.com/orochibraru/homerun/compare/v1.0.49...v1.0.50) (2026-09-30)

### Features

- build servers build for the deploy host's architecture through QEMU, backup
  durations in minutes/hours/days
  ([6368848](https://github.com/orochibraru/homerun/commit/63688481f5006fe595288594ad2d4d1a1342106f))
- destination presets including Hetzner Storage Box, and an integration test
  against a real box over SFTP, SMB and WebDAV
  ([fa44121](https://github.com/orochibraru/homerun/commit/fa4412153745e4f7b9851792424a4b63da9a0edd))
- backup destination page to view details, edit and test a destination
  ([2bad820](https://github.com/orochibraru/homerun/commit/2bad820094e0b2d6bd214101964bc12cf763efc2))
- back volumes up to SFTP, SMB and WebDAV destinations through an rclone helper,
  lock every better-auth package to one version, fix a flaky S3 upload test
  ([3535b56](https://github.com/orochibraru/homerun/commit/3535b56b3aee5b9a9c3bcd86bdabcf3630b83f2b))
- redirects sync DNS/Pangolin with a list toggle and REST/MCP/CLI support,
  generated architecture diagram, slimmer CLI help, fix invisible code editor
  text on opaque themes
  ([89e8fc9](https://github.com/orochibraru/homerun/commit/89e8fc9f452ef49283a17e30091327a4ccec4ec2))
- registry self-test and boot-time registry reconcile; CI builds pull base
  images through mirror.gcr.io
  ([06822ce](https://github.com/orochibraru/homerun/commit/06822ce451b39846230b7c48f08bb0d3fb08baaf))
- SSH machine terminals, 25 new templates incl. Immich, and templates E2E fails
  fast instead of hanging
  ([5fa1326](https://github.com/orochibraru/homerun/commit/5fa1326bbd147bbf995ea10b8dfb2190a4a6efa6))
- SSH machine terminals, 25 new templates incl. Immich, and templates E2E fails
  fast instead of hanging
  ([7c7051e](https://github.com/orochibraru/homerun/commit/7c7051ea30351525c57ab2b947f2688b40528464))
- monitoring vs previous period, preview env overrides and volume copies,
  instance TLS certificate tab, per-template CI matrix, preview breadcrumbs,
  local setup docs
  ([a5b475c](https://github.com/orochibraru/homerun/commit/a5b475c6dc4a1fff51e73adf8e5b56992ec2f668))
- stack (with substacks) and instance-wide monitoring with a per-service
  breakdown; rename analytics to monitoring
  ([4f89c85](https://github.com/orochibraru/homerun/commit/4f89c85c0491635e720778cb0185a58520d3ba1e))
- service analytics (traffic from Traefik metrics, uptime, resources over today
  to all time), preview branch filters, refreshed showcase screenshots
  ([f0dede6](https://github.com/orochibraru/homerun/commit/f0dede652e04f0100b273aa333ff1a46365d83e3))
- Sleek style, wider sidebar and search palette, warmer less-pink bordeaux
  ([1b69a22](https://github.com/orochibraru/homerun/commit/1b69a226bc9cf02e2abe51907a5a2a6e23cda831))
- Homerun branding and a close button in the mobile sidebar drawer
  ([2a7b87d](https://github.com/orochibraru/homerun/commit/2a7b87d9c0bb4e5f293437f1fe32115ccd55f0f9))
- one-command server enrollment as build server or swarm node, liquid glass
  tinted by the accent, Material You style
  ([30035fd](https://github.com/orochibraru/homerun/commit/30035fd4dd3cbcc32a5315c6592bfb79580132a5))
- domains and DNS providers (16 APIs incl. Cloudflare, Route 53, Hetzner,
  Namecheap) managed from Homerun, with tracked auto-records per service
  hostname
  ([5401224](https://github.com/orochibraru/homerun/commit/540122461fa224b9c4a0cb477e5a89ed6c356104))
- restore a volume backup from a service's Storage tab (replace, back up first,
  or as a revision with rollback), macOS-style glass, baba-style resource
  incidents with a sustain window, reminders and per-resource recovery
  ([19f8580](https://github.com/orochibraru/homerun/commit/19f8580ea4f4fed4bff0d18ce2a7527f595cccb9))
- cancel running backups and restores, presets get a windowed sidebar, title-bar
  header and bundled era fonts
  ([7c3cf3b](https://github.com/orochibraru/homerun/commit/7c3cf3bda56164bb19321a7e471983f94dff86bd))
- appearance presets (Windows 95/98/XP/7, MSN, Retro) overriding theme, style
  and colors
  ([d24fe18](https://github.com/orochibraru/homerun/commit/d24fe18b52ea9b4aa52f0828f9d21d575f1f3b42))
- error tracking source maps (upload API, CLI and Errors tab, frames mapped back
  to source at ingest), header-authenticated API clients pass the form CSRF
  check
  ([059fef9](https://github.com/orochibraru/homerun/commit/059fef928e2fb4d4cbc88f7f5138de2e2fd84ae8))
- group notifications and report scheduled runs once, backup and cron job
  events, S3 upload timeouts/retries/progress, backups and jobs in the
  API/CLI/MCP, and PR CI deploys only touched templates
  ([e1fbd82](https://github.com/orochibraru/homerun/commit/e1fbd822aefd1230b9bd2ff0a398e0dcae218a3e))

### Bug Fixes

- retry a failed start-first rollout stop-first when a routed service's writable
  volume can't be shared
  ([486a96f](https://github.com/orochibraru/homerun/commit/486a96fd82981858040a3fff735b68df8a3fd365))
- swarm updates routed services start-first even with a writable volume, so
  redeploys stop 404ing
  ([3fe30a7](https://github.com/orochibraru/homerun/commit/3fe30a73add6eb8848fd5cf646d6f818f600acb8))
- build cache registries accept a namespace path so cross-host builds can push
  to Gitea/GHCR, logging in against the bare host
  ([9a25de3](https://github.com/orochibraru/homerun/commit/9a25de3503bae7c4f7221350ec82f770f671f17a))
- tag every channel's images with their release tag so the agent setup command
  pins a real image; wider dialogs
  ([440fc58](https://github.com/orochibraru/homerun/commit/440fc587d10d3dafcee083a3b51a5f3dbf4d1455))
- agent setup
  ([ed96a60](https://github.com/orochibraru/homerun/commit/ed96a606abf11e8cfbc80f990f86e57868934895))
- registry TLS, agent setup commands with a connection test, git provider type
  in the repo picker, templates E2E infra pulls via mirrors, and a checked
  nightly publish script
  ([0c027c1](https://github.com/orochibraru/homerun/commit/0c027c187a09b5139311305c476747dcfca06c31))
- templates E2E setup hook takes no args again; Sleek is the default style,
  showcase the style picker with several styles picked
  ([b36e0bd](https://github.com/orochibraru/homerun/commit/b36e0bd70060cccf3f0183d7d820136b394042f2))
- stop queue.test's JobDTO mock leaking into other test files and breaking CI
  ([3edc1bd](https://github.com/orochibraru/homerun/commit/3edc1bd59ed87abd693ad0bd6d16296a7d2e2205))
- **deps:** update module golang.org/x/crypto to v0.57.0 (#38)
  ([95991b0](https://github.com/orochibraru/homerun/commit/95991b0f2c546ae2f7f15a57e3ebc6548c570431))
- backups fail loudly instead of hanging (S3 request timeout and retries, real
  upload error, progress log, bigint size) and are listed and triggered from the
  API, CLI and MCP
  ([28c66dc](https://github.com/orochibraru/homerun/commit/28c66dce92e405c0e276a95bd2072a278a6dac01))

### Performance Improvements

- upload backup parts four at a time with fast gzip; show volume sizes on disk;
  real-bucket S3 backup/restore integration test
  ([51a22ea](https://github.com/orochibraru/homerun/commit/51a22eaee830cecd957646aa1523c4ddb690effe))

## [1.0.49](https://github.com/orochibraru/homerun/compare/v1.0.48...v1.0.49) (2026-09-27)

### Features

- IDP apps get a real list and tabbed pages (overview, users with revoke,
  settings), branded HTML emails, login wall lets manifests through and 401s
  background requests
  ([cc06649](https://github.com/orochibraru/homerun/commit/cc066493fefad959d977b229487cde261eb14fbc))
- stack icons, pan/zoom architecture canvas with draggable substacks, OIDC apps
  moved to their own IDP page
  ([0ccaa6f](https://github.com/orochibraru/homerun/commit/0ccaa6f97c06b6aa0ec7f2e0b33415690f43266f))
- Sentry-compatible error tracking (per-service DSN and env injection, issues
  with source-linked stack traces, new/regression notifications, Errors tab,
  API/MCP/CLI)
  ([f4990ee](https://github.com/orochibraru/homerun/commit/f4990ee87858716089472f5abcb30eaa96b0edf9))
- emailed sign-in codes and magic links with passwordless client invites,
  Dashboard Icons through a cached proxy
  ([378d66d](https://github.com/orochibraru/homerun/commit/378d66d45a1792beb8a11ebd53993e1aabd18a0a))
- mobile-responsive dashboard, per-account page size, previews API/CLI with
  promote and a GitHub Actions cookbook, opt-in release channels with deployment
  environments, app-access-only role with /my-apps
  ([7ebfd59](https://github.com/orochibraru/homerun/commit/7ebfd597386e239af6f4d25199fb326041dbdb10))
- keep sites up during self-updates, nest PR previews under their parent, weekly
  template tag bumps with an E2E suite deploying every template
  ([27852f9](https://github.com/orochibraru/homerun/commit/27852f9a5958a3b27690684c50bca9faac3a7ff9))
- Previews tab with preview domain templates, instance-wide deployment history
  with recorded triggers, Website service category
  ([3e64b91](https://github.com/orochibraru/homerun/commit/3e64b9178531b887029a4a366442338430f95808))
- service Health tab with healthcheck overrides and off switch, DB-stored
  service dependencies driving start order, xterm.js terminal; fix false
  unhealthy verdict on unrouted services
  ([0cbf285](https://github.com/orochibraru/homerun/commit/0cbf285caf110292dc8353000b18e5186fd15749))
- substacks with dependency tree, draggable architecture diagram and unlink;
  per-var secret marks, default datastore volumes, Dockerfile build target, own
  nightly workflow, update-status dialog; fix Pangolin org check and false
  service links
  ([7aaee6b](https://github.com/orochibraru/homerun/commit/7aaee6ba99f9b6c160ff17a32ebedf99dd9f6f2a))
- nested substacks, per-stack dependency tree and architecture diagram,
  stack-prefixed slugs; auto-restart swarm services whose DNS alias Docker
  dropped
  ([3153e59](https://github.com/orochibraru/homerun/commit/3153e59c902a7e1aaa7c600fc209b5fb7f5ffdff))
- nightly update channel, generated {{secret}} template passwords,
  authentication page tabs, deployment history API and MCP tool, recreate a
  missing swarm ingress network; fix MCP env redaction and Claude connector
  token auth
  ([ab39c37](https://github.com/orochibraru/homerun/commit/ab39c37a6944ed386c0321ba0f91523bde4de85e))
- self-updates check the new version in a candidate before switching and roll
  back on failure; public /api/v1/ready probe
  ([711cb77](https://github.com/orochibraru/homerun/commit/711cb77c88b9f2ab541fdeb83864c95773928d7d))
- remote MCP server with OAuth for claude.ai, HTTP readiness in revision health;
  fix installer README formatting
  ([9f0bb03](https://github.com/orochibraru/homerun/commit/9f0bb0389e6afe3295052c7b0f4f691d3318d7f7))
- one-switch volume backups with schedule dialog, scheduled backups on /backups,
  DNS page with exclusive Cloudflare/Pangolin provider and domain listing; fix
  stale uptime alerts
  ([5f3823c](https://github.com/orochibraru/homerun/commit/5f3823c46f23fe59af268d6edd72c83c8411c3b0))
- sorting, palettes, volume file editor, per-session HTTP cache, cancellable
  worker deploys, swarm rollback fix, schedule picker, stack-aware breadcrumbs
  and notifications, create-and-mount volumes
  ([8f31e2a](https://github.com/orochibraru/homerun/commit/8f31e2a9cba5e65de63810929d7da771188a47f5))
- published ports and per-domain ports, templates as JSON by category, CI deploy
  action and CLI image, queue orphan recovery fix, UI consistency fixes
  ([8475c45](https://github.com/orochibraru/homerun/commit/8475c458f6edd1dc390707399ae965967b896925))
- Stremio/Nuvio templates, deploy cancel button, fail status checks on commits
  with no checks
  ([a83e937](https://github.com/orochibraru/homerun/commit/a83e93751d609dfddbd16753b17a02c6fc88cd74))
- header breadcrumbs replacing back links, tabbed stack page with services first
  ([8ebb472](https://github.com/orochibraru/homerun/commit/8ebb4727bee038eb7a0a6f1f8a5db5f003b39b69))
- right-click context menu on stacks list, coloured service tab icons
  ([19b596b](https://github.com/orochibraru/homerun/commit/19b596b9b3e3d070c26697ff3ac4338603fa1c2b))

### Bug Fixes

- IDP pages overflow on mobile, grids get a shrinkable single column
  ([8f9fdb9](https://github.com/orochibraru/homerun/commit/8f9fdb90b4459d8580946dcc5151f1c941700634))
- templates E2E green: template data volumes and {{url}}, twelve templates
  fixed, onboarding stops pre-filling an IP base domain
  ([51fc8d6](https://github.com/orochibraru/homerun/commit/51fc8d6af30bd4d831f6d8778552e5abe0a82ff4))
- login wall sign-in page offers only the methods the gated app allows
  ([042e748](https://github.com/orochibraru/homerun/commit/042e7486c209b8703957e189cc2574c62ba9e8e3))
- pre-fill the deploy wizard's default data volume row for datastore images and
  show icons in the stack flat list
  ([ea959a1](https://github.com/orochibraru/homerun/commit/ea959a1abac43c261872c3dc2eace5ab09fbdcea))
- MCP redacts env vars by secret-looking name, URL passwords and password args
  instead of every value; update_service merges env changes and refuses
  unmatched placeholders
  ([788e77e](https://github.com/orochibraru/homerun/commit/788e77ee4f24f1443a12fc4f46caa02764c6d2ab))
- stop re-applying unchanged Traefik flags from recreating Traefik on every
  boot; pause uptime probes during updates, boot and Traefik restarts
  ([7f9e243](https://github.com/orochibraru/homerun/commit/7f9e243f357ec26eaff8c1c34c5201b0dabb8881))
- add cache engine names to the Vale vocabulary
  ([6e14c5c](https://github.com/orochibraru/homerun/commit/6e14c5c39f12606df211ffe52ea055436d653e87))
- traefik expectations
  ([ed6e234](https://github.com/orochibraru/homerun/commit/ed6e23464b5659ae2777ccd68b144f757376bf86))
- cover mcpResource and make the Claude Stop gate block on failure
  ([4a5f006](https://github.com/orochibraru/homerun/commit/4a5f00640b3d51523fc71d361fe8614905be65db))
- re-apply Traefik cache plugin on worker boot, stop treating gated apps' bearer
  tokens as API keys, damp flapping uptime alerts; feat: homerun mcp server,
  Vale prose linting for docs
  ([c7dd792](https://github.com/orochibraru/homerun/commit/c7dd79221526d53d7ea5cd2fe9e76e85c3d0d19c))
- count 5xx responses as down in uptime probes; add htmx, Remix, SolidJS, Qwik,
  Vite, Hono and more service icons
  ([e95bca7](https://github.com/orochibraru/homerun/commit/e95bca7c3926f4f2648b809c753d690c530516f7))
- show an alert linking to a failed deploy instead of redirecting to it on every
  Overview visit
  ([281a37e](https://github.com/orochibraru/homerun/commit/281a37e908747382de795cdda2f1c7906b9fa921))
- contain absolutely-positioned content in the dashboard scroll area to kill the
  double scrollbar
  ([5b4b2ab](https://github.com/orochibraru/homerun/commit/5b4b2ab89838b83dabb2f04dfbdbf0af5e3a6803))
- import Dokploy/Coolify domains on migration, target Traefik's 443 for
  in-network Pangolin tunnels
  ([14c5b35](https://github.com/orochibraru/homerun/commit/14c5b354920ff1361597f626fe5ebbdfdd36e5f9))

### Performance Improvements

- attach the login-wall middleware only to gated services and redeploy when the
  wall is toggled
  ([c21162f](https://github.com/orochibraru/homerun/commit/c21162f32eca4d464238d15bae5095894db7cf73))

## [1.0.48](https://github.com/orochibraru/homerun/compare/v1.0.47...v1.0.48) (2026-09-24)

### Bug Fixes

- **ci:** push refreshed screenshots with RELEASE_TOKEN, root font 110% → 100%
  ([4088964](https://github.com/orochibraru/homerun/commit/4088964a5ee85b9bbed19a5b13ed8e1d2663e06a))
- **ui:** drop root font size from 110% to 100%
  ([952f4f1](https://github.com/orochibraru/homerun/commit/952f4f130f874e9c32bd79d3e75e12085ee570cc))

## [1.0.47](https://github.com/orochibraru/homerun/compare/v1.0.46...v1.0.47) (2026-09-24)

### Bug Fixes

- **screenshots:** encode webp in chromium, playwright workers have no Bun
  global
  ([78594d1](https://github.com/orochibraru/homerun/commit/78594d1fd25bd50654983a697c68c687bf89932d))
- **auth:** drop better-auth's unset baseURL warning
  ([27ac4f5](https://github.com/orochibraru/homerun/commit/27ac4f529a2e7b15a1cec51f76e32fbb1a7643af))

## [1.0.46](https://github.com/orochibraru/homerun/compare/v1.0.45...v1.0.46) (2026-09-24)

### Features

- **services:** add rebuild, fresh build, pull image and kill actions, show
  lifecycle buttons on swarm, equal-height dashboard cards
  ([9b9279c](https://github.com/orochibraru/homerun/commit/9b9279c3de3052c8fc2fdd3705f85c2f65a13aaa))

## [1.0.45](https://github.com/orochibraru/homerun/compare/v1.0.44...v1.0.45) (2026-09-24)

### Features

- **services:** add a volumes step and default login to Homerun sign-in in the
  wizard, split every oversized svelte file
  ([974f672](https://github.com/orochibraru/homerun/commit/974f6726104cdfbc75a176b20fd15c7b0065b8a3))
- **templates:** add Bercail and give Penombre and Bercail their icons
  ([eb7d8a3](https://github.com/orochibraru/homerun/commit/eb7d8a3e7e6826a19aab380a28b54328895e1556))

## [1.0.44](https://github.com/orochibraru/homerun/compare/v1.0.43...v1.0.44) (2026-09-24)

### Features

- **ui:** tint sidebar nav icons with the accent and regenerate docs screenshots
  ([652453b](https://github.com/orochibraru/homerun/commit/652453b882fe70691ff73bbb0c9d86d665ddef69))
- **brand:** replace the house logo with a home-plate mark and drop the
  favicon's background box
  ([e9cf65b](https://github.com/orochibraru/homerun/commit/e9cf65b399d8e9c03c6cabbb6ba9cb8385d67f70))
- **ui:** make bordeaux the default accent and drop per-category sidebar colors
  ([2ee7841](https://github.com/orochibraru/homerun/commit/2ee7841ca6f0574ebe1425d833fbe8c7c87ebf6d))

## [1.0.43](https://github.com/orochibraru/homerun/compare/v1.0.42...v1.0.43) (2026-09-24)

### Features

- **installer:** add --dashboard-port/--http-port/--https-port to install next
  to Dokploy and take over 80/443 later
  ([b03ce43](https://github.com/orochibraru/homerun/commit/b03ce43ababd002ac1794231ea3efb99f05952d8))

## [1.0.42](https://github.com/orochibraru/homerun/compare/v1.0.41...v1.0.42) (2026-09-22)

### Features

- re-assert core services whenever the worker (re)starts, keyed on a worker boot
  id
  ([c8cc39c](https://github.com/orochibraru/homerun/commit/c8cc39ca022707c2d7e8811b9fd5e92bf7e1905a))

### Bug Fixes

- **docker:** bump go-builder image to golang 1.27 to match go.mod
  ([e5889ea](https://github.com/orochibraru/homerun/commit/e5889ea0b43ac4e848685d393e80cebe977b917f))
- probe swarm services internally via their overlay alias and show last deploy
  time in the service header
  ([a004e63](https://github.com/orochibraru/homerun/commit/a004e636f50d96b95471d44aab524319f3817625))

## [1.0.41](https://github.com/orochibraru/homerun/compare/v1.0.40...v1.0.41) (2026-09-21)

### Features

- stable/canary release channel in settings, sync Pangolin/DNS when a service's
  domains change
  ([610ac6f](https://github.com/orochibraru/homerun/commit/610ac6f7ef557052d848cdf66fac828cba87b6a5))

### Bug Fixes

- **ci:** publish one immutable v<version> prerelease per canary instead of a
  rolling canary tag
  ([a914946](https://github.com/orochibraru/homerun/commit/a914946177d9d3c31d2d46ade6137e5f7537196b))

## [1.0.40](https://github.com/orochibraru/homerun/compare/v1.0.39...v1.0.40) (2026-09-21)

### Features

- go worker for all (#22)
  ([dba2d4f](https://github.com/orochibraru/homerun/commit/dba2d4f54386b1ee7be0ecb4d7cf9da6e5e39c1e))

## [1.0.39](https://github.com/orochibraru/homerun/compare/v1.0.38...v1.0.39) (2026-09-19)

### Features

- system errors ([#21](https://github.com/orochibraru/homerun/issues/21))
  ([bd873f4](https://github.com/orochibraru/homerun/commit/bd873f41fb68473c0920f10fda7a25cd47470922))

## [1.0.38](https://github.com/orochibraru/homerun/compare/v1.0.37...v1.0.38) (2026-09-19)

## [1.0.37](https://github.com/orochibraru/homerun/compare/v1.0.36...v1.0.37) (2026-09-19)

### Features

- shadcn selects everywhere, last sign-in on users, live CLI update progress,
  plus logo, domains polish and registry auth fix
  ([c7bd3ef](https://github.com/orochibraru/homerun/commit/c7bd3efb4bb539d0cb27172fce2b503466d1d445))

### Bug Fixes

- registry setup
  ([13151e1](https://github.com/orochibraru/homerun/commit/13151e1ea4bbd0544564a16415fe688f2346ef70))

## [1.0.36](https://github.com/orochibraru/homerun/compare/v1.0.35...v1.0.36) (2026-09-19)

### Features

- add a home-plate logo and favicon, and polish the service domains list
  ([8fb8985](https://github.com/orochibraru/homerun/commit/8fb89851a042cff142c07f05caf1b483a419b85f))

## [1.0.35](https://github.com/orochibraru/homerun/compare/v1.0.34...v1.0.35) (2026-09-18)

### Features

- Go agent and worker foundation under cmd/ + internal/, multiple domains per
  service, email-first sign-in, OIDC app revocation, GitHub App setup, and
  auth/lifecycle fixes
  ([4008956](https://github.com/orochibraru/homerun/commit/40089567315b284a5ef0549e9849b7ffd7daa1c6))
- **registry:** add a Registry page and make the built-in registry pushable
  ([443eb70](https://github.com/orochibraru/homerun/commit/443eb70007411b21a9d1a5858a294b14f123a00a))

### Bug Fixes

- **ci:** exclude gosec's taint-analysis SSRF rule for the CLI's configured
  instance URL
  ([97eedf7](https://github.com/orochibraru/homerun/commit/97eedf7d344e89b1681457553d978a370bded6b0))
- **ci:** install golangci-lint in the code quality job so the prek lint-go hook
  can run
  ([66489c0](https://github.com/orochibraru/homerun/commit/66489c0121e1d0fe29d24f90d5199b59c7fd9a92))
- **logs:** stream logs for swarm services instead of claiming they're
  undeployed
  ([ba08d5b](https://github.com/orochibraru/homerun/commit/ba08d5b7550fab56fbae82a2d48f5afbdbe4d025))
- skip registry htpasswd sync for token changes while auth is off, and render
  the UI at 110% root font size
  ([97328ef](https://github.com/orochibraru/homerun/commit/97328efb958d08a6b9918faf4e6d547b891b5b07))
- skip the sign-in lookup throttle when auth rate limiting is disabled and keep
  the Registry page up when Docker is unreachable
  ([f2620ff](https://github.com/orochibraru/homerun/commit/f2620ff7c5e97660c5d17b86d3cfbffbac1cc2ff))
- **ui:** outline toast action buttons and hide Redeploy on services that were
  never deployed
  ([25a2f4f](https://github.com/orochibraru/homerun/commit/25a2f4fd16d60b4fd0310bdf608a90148adbfac2))

## [1.0.34](https://github.com/orochibraru/homerun/compare/v1.0.33...v1.0.34) (2026-09-17)

## [1.0.33](https://github.com/orochibraru/homerun/compare/v1.0.32...v1.0.33) (2026-09-17)

### Bug Fixes

- **ci:** upload release binaries with retries and publish the draft only once
  all are uploaded
  ([4531333](https://github.com/orochibraru/homerun/commit/4531333f45da1422fc5e9436318d1bab7afa07d1))
- count swarm tasks started during the rollout as running in the health watch
  ([218b8df](https://github.com/orochibraru/homerun/commit/218b8dfcf05bdbae142b8ac25091ef844f06aca7))

## [1.0.32](https://github.com/orochibraru/homerun/compare/v1.0.31...v1.0.32) (2026-09-17)

### Bug Fixes

- duplicate traefik logs
  ([856cc35](https://github.com/orochibraru/homerun/commit/856cc35a5b52b2b87f5243870680c93ed1572ea7))
- handle cli api errors
  ([1aea7b7](https://github.com/orochibraru/homerun/commit/1aea7b718cb68dac53cf709b2ec61532466160c9))

## [1.0.31](https://github.com/orochibraru/homerun/compare/v1.0.30...v1.0.31) (2026-09-17)

### Features

- update the instance from the CLI, poll for releases, show remote function
  errors
  ([81e3caf](https://github.com/orochibraru/homerun/commit/81e3caf6dfdcda94315a48016547a9bdc6a32c8d))

## [1.0.30](https://github.com/orochibraru/homerun/compare/v1.0.29...v1.0.30) (2026-09-17)

### Features

- unhealthy reason and service logs over API and CLI, docker group for install
  user
  ([bc17e48](https://github.com/orochibraru/homerun/commit/bc17e48c231d4ffc9f032eac85c58cbb22dc598f))

## [1.0.29](https://github.com/orochibraru/homerun/compare/v1.0.28...v1.0.29) (2026-09-17)

### Features

- docs conf
  ([d8850fa](https://github.com/orochibraru/homerun/commit/d8850fa1e34d4606c6effd75b239164733a3dc9d))
- login wall on Security tab, editable PKCE, retrying rollouts, IP-origin fixes
  ([e1b57b4](https://github.com/orochibraru/homerun/commit/e1b57b4e0e50316623a00af2b018cd9b55870b9a))
- more docs
  ([4370ead](https://github.com/orochibraru/homerun/commit/4370eada143f984d7d0154124a853fbc0d559ba4))

### Bug Fixes

- e2e
  ([fb48a89](https://github.com/orochibraru/homerun/commit/fb48a896aeb2ce6fedc8ba91b335de7fdc5239ef))

## [1.0.28](https://github.com/orochibraru/homerun/compare/v1.0.27...v1.0.28) (2026-09-17)

### Features

- **pangolin:** run Newt as a Homerun-managed container, set up from onboarding
  ([8e260bf](https://github.com/orochibraru/homerun/commit/8e260bf5cef2fabbbfa14b5be402c4102148c05c))

## [1.0.27](https://github.com/orochibraru/homerun/compare/v1.0.26...v1.0.27) (2026-09-17)

### Features

- swarm by default with rootful migration, readiness gate, BuildKit/Bake builds,
  stable revisions list, copyable build logs
  ([1ecadc1](https://github.com/orochibraru/homerun/commit/1ecadc1b09adffc50ff666822aed50a20bebda0f))

## [1.0.26](https://github.com/orochibraru/homerun/compare/v1.0.25...v1.0.26) (2026-09-17)

### Features

- clear the TODO backlog (shared resources, roles, previews, BuildKit/Bake,
  health-gated rollout, swarm fixes)
  ([a116ba1](https://github.com/orochibraru/homerun/commit/a116ba17aab790625a791d27fe9cefc7051f9143))

## [1.0.25](https://github.com/orochibraru/homerun/compare/v1.0.24...v1.0.25) (2026-09-17)

### Bug Fixes

- two factor cookies & macos cli
  ([0d2b969](https://github.com/orochibraru/homerun/commit/0d2b9699f9607a0841414ca13ed4404086385d4c))

## [1.0.24](https://github.com/orochibraru/homerun/compare/v1.0.23...v1.0.24) (2026-09-17)

### Features

- night sesh ([#19](https://github.com/orochibraru/homerun/issues/19))
  ([d95d325](https://github.com/orochibraru/homerun/commit/d95d325b4b995e664b415e25cbe15f731f31da43))
- scan policy, fix bugs, safe delete, cli security, code cleanup, tooling
  ([5b3c01a](https://github.com/orochibraru/homerun/commit/5b3c01a3a388342e8b19f302433b5173be044770))
- so much stuff
  ([0c28e26](https://github.com/orochibraru/homerun/commit/0c28e2654456f4096484a825a8e29b90068bdf8e))

### Bug Fixes

- release night session
  ([bef8141](https://github.com/orochibraru/homerun/commit/bef8141d3ddd7f60ebe3fed8815c47019180ec45))
- revocation, dropdownws tooling
  ([b0c852a](https://github.com/orochibraru/homerun/commit/b0c852a888f56ee98b17fa195c70e8a838441605))

## [1.0.23](https://github.com/orochibraru/homerun/compare/v1.0.22...v1.0.23) (2026-09-16)

### Features

- stacks, global search, self-update, passkeys/2FA and migrate tab
  ([#18](https://github.com/orochibraru/homerun/issues/18))
  ([8cb03c2](https://github.com/orochibraru/homerun/commit/8cb03c23a3afcc1785f6f7f9d78766221f0ab699))

## [1.0.22](https://github.com/orochibraru/homerun/compare/v1.0.21...v1.0.22) (2026-09-16)

### Features

- notification channels
  ([969c11e](https://github.com/orochibraru/homerun/commit/969c11e6626f0d556c7855e56a92b71321060b56))

## [1.0.21](https://github.com/orochibraru/homerun/compare/v1.0.20...v1.0.21) (2026-09-16)

### Bug Fixes

- e2e
  ([a4071fd](https://github.com/orochibraru/homerun/commit/a4071fd8107ae072f0db4b4ba2d5570535244d4d))
- endless cert generation
  ([#17](https://github.com/orochibraru/homerun/issues/17))
  ([ad15644](https://github.com/orochibraru/homerun/commit/ad1564443a1362e33045258e38cdc39010934316))
- release
  ([200c1f2](https://github.com/orochibraru/homerun/commit/200c1f2fd60e8daa29d6f035baf01bbfa79da819))

## [1.0.20](https://github.com/orochibraru/homerun/compare/v1.0.19...v1.0.20) (2026-09-16)

### Bug Fixes

- ci filters & docs
  ([51ccaf5](https://github.com/orochibraru/homerun/commit/51ccaf52793233d45f6bbf6c93452485b6b7d0af))

## [1.0.19](https://github.com/orochibraru/homerun/compare/v1.0.18...v1.0.19) (2026-09-15)

### Bug Fixes

- release the bug-batch merge
  ([d420723](https://github.com/orochibraru/homerun/commit/d4207232becae812ac335ba48c0ed6f1e71d5edb))

## [1.0.18](https://github.com/orochibraru/homerun/compare/v1.0.17...v1.0.18) (2026-09-15)

### Features

- remote cron jobs, S3 restore, Dokploy migration, orphan network reclaim
  ([#15](https://github.com/orochibraru/homerun/issues/15))
  ([9f2b7c9](https://github.com/orochibraru/homerun/commit/9f2b7c9aa669a7195923442560472e249bd1edac))

## [1.0.17](https://github.com/orochibraru/homerun/compare/v1.0.16...v1.0.17) (2026-09-15)

### Bug Fixes

- release the bug-batch merge
  ([48afa9b](https://github.com/orochibraru/homerun/commit/48afa9bf5a4141b5c6406927758b080ce65cbb4f))

## [1.0.16](https://github.com/orochibraru/homerun/compare/v1.0.15...v1.0.16) (2026-09-15)

### Bug Fixes

- agent conf & types
  ([315f383](https://github.com/orochibraru/homerun/commit/315f38305b1eb139e44d6e5f15f23e02c38e1b45))
- linting (should have done this in a pr -_-)
  ([49a4ca9](https://github.com/orochibraru/homerun/commit/49a4ca9c445094776d0b978e557e6f9cb5548fcc))
- no parallel commands
  ([b518fc1](https://github.com/orochibraru/homerun/commit/b518fc15c8c07f600f890dcf740ee12fadd04387))
- pangolin integration & docs
  ([#12](https://github.com/orochibraru/homerun/issues/12))
  ([a356a00](https://github.com/orochibraru/homerun/commit/a356a00ab04d8bfa219275e87274db0eefd921d2))
- release
  ([3224ad0](https://github.com/orochibraru/homerun/commit/3224ad098c72a3609df6cd9ffab06997d52820d3))
- settings
  ([70d6e24](https://github.com/orochibraru/homerun/commit/70d6e24854a58e3500f40aa70bd5dcef2c76fbef))
- tests again
  ([581c9bf](https://github.com/orochibraru/homerun/commit/581c9bf33c78906a3c4c74527a9b3e31467a3851))

## [1.0.15](https://github.com/orochibraru/homerun/compare/v1.0.14...v1.0.15) (2026-09-14)

### Features

- docs trigger floow
  ([9f7790b](https://github.com/orochibraru/homerun/commit/9f7790b631057897ec0147248f91c2d63edc3547))

## [1.0.14](https://github.com/orochibraru/homerun/compare/v1.0.13...v1.0.14) (2026-09-14)

### Bug Fixes

- installer docker path
  ([2051ae2](https://github.com/orochibraru/homerun/commit/2051ae2e20d401d01f62becc4b58e891e3da9885))

## [1.0.13](https://github.com/orochibraru/homerun/compare/v1.0.12...v1.0.13) (2026-09-14)

### Bug Fixes

- auth & ci ([#9](https://github.com/orochibraru/homerun/issues/9))
  ([8133de5](https://github.com/orochibraru/homerun/commit/8133de51b3d46319287be8f59d2115b9e6f1b649))

## [1.0.12](https://github.com/orochibraru/homerun/compare/v1.0.11...v1.0.12) (2026-09-11)

### Bug Fixes

- precommit & signin flow
  ([3259623](https://github.com/orochibraru/homerun/commit/3259623e85e5b152051474ec7fc78adde0686608))
- prek
  ([acd16a2](https://github.com/orochibraru/homerun/commit/acd16a2d3e2589aaf10cfbe755f9d38048142a6e))
- sveltekit sync before tests
  ([ddcffaa](https://github.com/orochibraru/homerun/commit/ddcffaafbbe88143c454dbbca458b7a92b87efd8))

## [1.0.11](https://github.com/orochibraru/homerun/compare/v1.0.10...v1.0.11) (2026-09-09)

### Bug Fixes

- origin on setup
  ([ece74be](https://github.com/orochibraru/homerun/commit/ece74bec313ba70e3897ac663d724b2e9f72bedb))

## [1.0.10](https://github.com/orochibraru/homerun/compare/v1.0.9...v1.0.10) (2026-09-07)

### Features

- oauth gate ([#6](https://github.com/orochibraru/homerun/issues/6))
  ([27ed10f](https://github.com/orochibraru/homerun/commit/27ed10fe671a490abdc1d0b23b146acb77dcd90c))

## [1.0.9](https://github.com/orochibraru/homerun/compare/v1.0.8...v1.0.9) (2026-09-05)

### Features

- remote functions
  ([1eae07e](https://github.com/orochibraru/homerun/commit/1eae07ef9f3a6b690c61c6bdeac95b3964aef0d9))

## [1.0.8](https://github.com/orochibraru/homerun/compare/v1.0.7...v1.0.8) (2026-09-05)

### Features

- named volumes backup, compose import, smart service links, cron jobs from ui
  ([dcf2e4f](https://github.com/orochibraru/homerun/commit/dcf2e4f5d2bf0e6fd3f104449250071e5d4ef23f))

## [1.0.7](https://github.com/orochibraru/homerun/compare/v1.0.6...v1.0.7) (2026-09-05)

### Features

- filters & pagination
  ([04fef9b](https://github.com/orochibraru/homerun/commit/04fef9b590645a33e15fa15b1c9925fbf60f73a1))

## [1.0.6](https://github.com/orochibraru/homerun/compare/v1.0.5...v1.0.6) (2026-09-05)

### Features

- queue
  ([f0207da](https://github.com/orochibraru/homerun/commit/f0207da21b0086baf4e0024cee5aa0658b6c2f67))

## [1.0.5](https://github.com/orochibraru/homerun/compare/v1.0.4...v1.0.5) (2026-09-05)

### Bug Fixes

- use service containers in ci
  ([0f92067](https://github.com/orochibraru/homerun/commit/0f92067d7f66bb6d0383f7e57989aa0cfc8247a0))

## [1.0.4](https://github.com/orochibraru/homerun/compare/v1.0.3...v1.0.4) (2026-09-04)

### Features

- docker cleanup
  ([8cbbae5](https://github.com/orochibraru/homerun/commit/8cbbae590805cc928c3a69a83b732655c7b68269))

## [1.0.3](https://github.com/orochibraru/homerun/compare/v1.0.2...v1.0.3) (2026-09-04)

### Features

- add test run retry policy on ci
  ([5ae92ce](https://github.com/orochibraru/homerun/commit/5ae92ceb3350d483db439ae8e045eb7d94d877dc))

### Bug Fixes

- conf & docs
  ([1d33ab3](https://github.com/orochibraru/homerun/commit/1d33ab3b12e6141a2c62ced6d5ae35ea288f281e))
- rerun flaky tests
  ([aefdfc2](https://github.com/orochibraru/homerun/commit/aefdfc255a07a3b0b5dc8958f3f09f1cbc458e4b))

## [1.0.2](https://github.com/orochibraru/homerun/compare/v1.0.1...v1.0.2) (2026-09-03)

### Bug Fixes

- ui
  ([38f6c29](https://github.com/orochibraru/homerun/commit/38f6c29e0f7da9ff2834ffa98d0466f5cc4d6e6f))

## [1.0.1](https://github.com/orochibraru/homerun/compare/v1.0.0...v1.0.1) (2026-09-03)

### Features

- more prek hooks, prettier docs, fixed docs links
  ([51ef41e](https://github.com/orochibraru/homerun/commit/51ef41e4b44ec81881c0ebf792dd919d0f730700))

### Bug Fixes

- prek
  ([9845f6e](https://github.com/orochibraru/homerun/commit/9845f6e9347ae391275af75e45ca965287d6c1e6))
- tests
  ([67a3175](https://github.com/orochibraru/homerun/commit/67a317521cffea732fe4fb37865b6c58879238d1))

## 1.0.0 (2026-09-03)

### Features

- another todo
  ([68d7c89](https://github.com/orochibraru/homerun/commit/68d7c894c66dc770ac5fba7aa3a20c6817a8654d))
- base
  ([1693733](https://github.com/orochibraru/homerun/commit/1693733bc73f9e6ccd9e027003b2f8b853cc5ac5))
- better classes
  ([87c925d](https://github.com/orochibraru/homerun/commit/87c925dc3d31738269794ab8c0d2218582fbd65f))
- better linting & precommit
  ([#8](https://github.com/orochibraru/homerun/issues/8))
  ([a3f3c6e](https://github.com/orochibraru/homerun/commit/a3f3c6e5ed68f2065a9aa1830f4aa46395b9f713)),
  closes [#123](https://github.com/orochibraru/homerun/issues/123)
  [#456](https://github.com/orochibraru/homerun/issues/456)
- build log
  ([09485d5](https://github.com/orochibraru/homerun/commit/09485d538a9690594f23c426ec5ac62c3741f24a))
- build on prs
  ([71e499a](https://github.com/orochibraru/homerun/commit/71e499ab1f51efa3a074754a3fc28f3488397f84))
- ci
  ([e31ed4b](https://github.com/orochibraru/homerun/commit/e31ed4b6e7b8f36e5a5490dfb8aa9d90223da153))
- cli auth improvements
  ([586e328](https://github.com/orochibraru/homerun/commit/586e3285cf6374ebcd47615eb475e665bb707b03))
- docs & release tag
  ([c99933d](https://github.com/orochibraru/homerun/commit/c99933d85f3532a11ff4d502e98e9f7e4c0c649c))
- e2e tests and docs website
  ([84eca8b](https://github.com/orochibraru/homerun/commit/84eca8bcb01902a8cab2f11ca0e70ad6bfd92235))
- handle volumes
  ([08bb3cf](https://github.com/orochibraru/homerun/commit/08bb3cf7c621785b892d7ec1ca47b9ba41185b1e))
- image existence checker
  ([617c0b6](https://github.com/orochibraru/homerun/commit/617c0b6237b04b44b9c459b298dbb68b51eef0fb))
- improve docs ui
  ([ab4a74b](https://github.com/orochibraru/homerun/commit/ab4a74bb3cbcd6a45c1cfa81882f45a09eff6560))
- more classes
  ([b885f09](https://github.com/orochibraru/homerun/commit/b885f096c8fa16c21a88df255a05226f3869b31f))
- more features
  ([f3ab041](https://github.com/orochibraru/homerun/commit/f3ab041b16ce6277c1fccb8d22f9a78edf7b4183))
- more features
  ([515eddf](https://github.com/orochibraru/homerun/commit/515eddf2ff43d5c1b90b40775f1df838e95814ca))
- more networking
  ([2b27d11](https://github.com/orochibraru/homerun/commit/2b27d116e8226d445a093fcf76e899e9b9533bed))
- more stuff
  ([c9d2bc4](https://github.com/orochibraru/homerun/commit/c9d2bc4c99b4f683ffa602f12278f0873da2d5d7))
- more todos
  ([b532919](https://github.com/orochibraru/homerun/commit/b53291925b97ef64bf636743e1db03a45d9bbf62))
- onboarding
  ([8a17b9e](https://github.com/orochibraru/homerun/commit/8a17b9e669c9b5c4c3fe10d9e4932e8631a5a0f7))
- pangolin integration
  ([021765c](https://github.com/orochibraru/homerun/commit/021765caa606bbe074125e1f31e240fb2ab4d5d1))
- publish job
  ([3c987c4](https://github.com/orochibraru/homerun/commit/3c987c4fdc042ae45ed1c8c99e0bc579df758040))
- restart traefik from ui
  ([9fff779](https://github.com/orochibraru/homerun/commit/9fff779be56ae0f32764a7af33b50af265b5c276))
- service volumes
  ([6aa1fe0](https://github.com/orochibraru/homerun/commit/6aa1fe06a9667a9f793e3d8e88b066aaef0e13cb))
- services
  ([7f0de6a](https://github.com/orochibraru/homerun/commit/7f0de6a6364cfebe05f3933df057b8ecbe101cd9))
- ssl certs, remote hosts, wizard, ui components
  ([ebd9cc9](https://github.com/orochibraru/homerun/commit/ebd9cc9e6a15231656b90974698550d36dbc77c7))
- stats
  ([b1327a5](https://github.com/orochibraru/homerun/commit/b1327a58b83a034fc7c08528f42740dc5bd520c4))
- stronger CI ([#3](https://github.com/orochibraru/homerun/issues/3))
  ([b9477eb](https://github.com/orochibraru/homerun/commit/b9477ebda039743b61b186c608b68fc9cfc6cb35)),
  closes [#123](https://github.com/orochibraru/homerun/issues/123)
  [#456](https://github.com/orochibraru/homerun/issues/456)
- swarm mode
  ([7cf7308](https://github.com/orochibraru/homerun/commit/7cf7308b62d35fe349d8bb816c209fda51b9433d))
- tests ([#7](https://github.com/orochibraru/homerun/issues/7))
  ([7bc3aa7](https://github.com/orochibraru/homerun/commit/7bc3aa7d2dd7b5ec8058d656c9ac5556850078e3)),
  closes [#123](https://github.com/orochibraru/homerun/issues/123)
  [#456](https://github.com/orochibraru/homerun/issues/456)
- todo & wip on Bun Webview
  ([dab2b58](https://github.com/orochibraru/homerun/commit/dab2b589f1626edfa586a46b8ef5574ac3d8c46b))
- todo items & better ui
  ([c33caae](https://github.com/orochibraru/homerun/commit/c33caaef5b744a401849920cece6263bd0c88263))
- ultracite
  ([52dbf14](https://github.com/orochibraru/homerun/commit/52dbf146dd27da2edf4da670261ad9d631764ccc))
- unit tests
  ([c2f6b17](https://github.com/orochibraru/homerun/commit/c2f6b17d367b388342a3933fcc9c6a90603c3d7e))
- use smol adapter
  ([3b36fef](https://github.com/orochibraru/homerun/commit/3b36fef9e59d2fd617c4db0b857a425ff74c9bc5))
- working deployments
  ([4aec3f2](https://github.com/orochibraru/homerun/commit/4aec3f2a0bd16a750672e2a67f3bb48328603e87))

### Bug Fixes

- action versions
  ([81624aa](https://github.com/orochibraru/homerun/commit/81624aa794e12c31e06f5f2ac7095b4fb0a12f2d))
- actions path
  ([d3ca42f](https://github.com/orochibraru/homerun/commit/d3ca42f6fc55c6cac3572bd368ef576acaa144c1))
- actions trigger
  ([4488a1f](https://github.com/orochibraru/homerun/commit/4488a1f6bd9d2aa51cfd6801c8562c7317c35199))
- app name
  ([0e2c2e7](https://github.com/orochibraru/homerun/commit/0e2c2e764530daffc7cc0f5901af17e25577c8b8))
- bake def
  ([da14ab1](https://github.com/orochibraru/homerun/commit/da14ab10c53f61ef9583cc4bff6c344a7ebb09d5))
- cap release branch at major-zero, prevent auto-jump to v1.0.0
  ([8f91335](https://github.com/orochibraru/homerun/commit/8f91335bc4ae8c704f5c392aebb7bab8918319fe))
- ci
  ([39cb4d6](https://github.com/orochibraru/homerun/commit/39cb4d6a7fcc89118fa382a1f29b482cb675414d))
- ci
  ([30e3e38](https://github.com/orochibraru/homerun/commit/30e3e38af17ce0bf20713f66683766d8c6bda17e))
- ci
  ([5a8ec6d](https://github.com/orochibraru/homerun/commit/5a8ec6d3da81c47b5277b158518a7a51c4cf5333))
- ci docker build
  ([84fbe3f](https://github.com/orochibraru/homerun/commit/84fbe3f4eec42788171eb8803e9bc00b9a4aec93))
- ci flow names
  ([e55f884](https://github.com/orochibraru/homerun/commit/e55f8846f75b87c37d18be6af79bfeb7e409de0e))
- ci flow names
  ([c629952](https://github.com/orochibraru/homerun/commit/c6299526b1d8191d60ea23d2970ddcf8aed71939))
- ci flows
  ([8ccb128](https://github.com/orochibraru/homerun/commit/8ccb128ccb00319887f71dbcf3cd7c1c311ee998))
- ci flows
  ([8960f13](https://github.com/orochibraru/homerun/commit/8960f13b7b40b43004288d9cb31e21d6dc73aeaf))
- ci rules
  ([8e57e46](https://github.com/orochibraru/homerun/commit/8e57e46e5fc4a7fd8a660271283b75add3f59ee4))
- cli
  ([be0c839](https://github.com/orochibraru/homerun/commit/be0c839c81831bc03b9f58feaee93ef42079b310))
- code quality
  ([64c1150](https://github.com/orochibraru/homerun/commit/64c115081bd190b8148f3a1153b1f7d77dd65f76))
- config name
  ([cb3528e](https://github.com/orochibraru/homerun/commit/cb3528e5d8dfe34245bbbd89fe17687abd42fbae))
- docker builds
  ([0de636c](https://github.com/orochibraru/homerun/commit/0de636ceda8520cdc47cdd3b77487b07ef04b340))
- docker conf
  ([66cb582](https://github.com/orochibraru/homerun/commit/66cb58223f27ea63c7991ef6083c0738d4276f40))
- docker env
  ([f5887b8](https://github.com/orochibraru/homerun/commit/f5887b8eb237c18259e6e2956b2e59896cf877b7))
- docker image name
  ([f48b125](https://github.com/orochibraru/homerun/commit/f48b125ab98a0e83cdfcf60f1d762932eed770f5))
- dockerfile
  ([3aa766a](https://github.com/orochibraru/homerun/commit/3aa766ae38f35d27bf793776c8138351c88d0576))
- docs
  ([395f8e9](https://github.com/orochibraru/homerun/commit/395f8e99bc5e5026e4d696ad599dbcf0f75ffc4b))
- docs
  ([6417c8e](https://github.com/orochibraru/homerun/commit/6417c8e023e95f32c9cd2858a403f9f614ccdc26))
- docs
  ([0f7defa](https://github.com/orochibraru/homerun/commit/0f7defaa437823c605609e13334b617eebfab977))
- don't build image if lint fails
  ([52cec13](https://github.com/orochibraru/homerun/commit/52cec1339ee10725acfe44e610a6495cb5cca276))
- format
  ([0dacdac](https://github.com/orochibraru/homerun/commit/0dacdac55caeb82194ded204e1349008fda42252))
- image name
  ([0a684f6](https://github.com/orochibraru/homerun/commit/0a684f616b199dce4235108d695e393816cea58f))
- latest tag
  ([5a34f02](https://github.com/orochibraru/homerun/commit/5a34f0289643345435ccfaefae7208356d0907a2))
- lint
  ([2ba0da5](https://github.com/orochibraru/homerun/commit/2ba0da54240529b6fa32aaadfee0ab8cf61df576))
- lint & types
  ([75b4e20](https://github.com/orochibraru/homerun/commit/75b4e202d9095c990ce19725dfc045854ab2bba6))
- md
  ([6d92399](https://github.com/orochibraru/homerun/commit/6d92399e2c7ca79d3761b187346a5d7587c24207))
- nginx alpine
  ([d63647f](https://github.com/orochibraru/homerun/commit/d63647fa457f1b8512d0658ae62c0c73381b9c8d))
- no default value on registry
  ([6c09c8c](https://github.com/orochibraru/homerun/commit/6c09c8c1ab791f466b4f09fa3f949a39915c9ffd))
- notifications
  ([402e509](https://github.com/orochibraru/homerun/commit/402e50983ac7412b675a48c71120352b771ba0de))
- oop
  ([04f58b0](https://github.com/orochibraru/homerun/commit/04f58b03b6270440032f3236e54afbe441353a6e))
- precommit
  ([f120209](https://github.com/orochibraru/homerun/commit/f12020979e6bdb968c0f5d850adfde121eb7d0a2))
- precommit hook
  ([d66d299](https://github.com/orochibraru/homerun/commit/d66d29930cc546190ee64485b6d0597746550530))
- prettier on changelog
  ([11aff9a](https://github.com/orochibraru/homerun/commit/11aff9adb83ecf95825d994b43a4cd83add8dd2f))
- publish rules
  ([1d35fd2](https://github.com/orochibraru/homerun/commit/1d35fd2f09b7a1e97f52d5b367cf5480793f86d6))
- publish rules
  ([1fe59f0](https://github.com/orochibraru/homerun/commit/1fe59f043c862b1db787220b23488943cf1747f1))
- publish trigger
  ([a4a2e2a](https://github.com/orochibraru/homerun/commit/a4a2e2a528f9ab53399dd6dd00da72c5da10c5d8))
- qemu build
  ([830c30f](https://github.com/orochibraru/homerun/commit/830c30fce12e165688c17c4647f67480a6ff004b))
- readme & tests
  ([bd00e5c](https://github.com/orochibraru/homerun/commit/bd00e5c491e97e8b0983674e211dc0973164aa44))
- release
  ([133852b](https://github.com/orochibraru/homerun/commit/133852bdd5ec17556115851b94f0daba28bdac77))
- release conf
  ([8da3b9b](https://github.com/orochibraru/homerun/commit/8da3b9bd8bd2d0f386d5d39043155b573bf8d419))
- release note version
  ([59c8b5d](https://github.com/orochibraru/homerun/commit/59c8b5df608df9b2916680ad44cc7ee1455da18c))
- remove build from webapp in ci, already ran by docker
  ([fea99e0](https://github.com/orochibraru/homerun/commit/fea99e0e2c81b493c9fca15a82dac97ddd601cbf))
- removed quality gate
  ([bffedb7](https://github.com/orochibraru/homerun/commit/bffedb7b7f8e94461e6365341fe01776ce7a0189))
- removed ultracite and fixed biome conf
  ([1ef8c25](https://github.com/orochibraru/homerun/commit/1ef8c251f3e501f8427956138caa47c55fd66a24))
- rename readme
  ([ecd9253](https://github.com/orochibraru/homerun/commit/ecd925360a21e1bbb84b1535df013e0edbbfd02f))
- runner labels
  ([8bbad8a](https://github.com/orochibraru/homerun/commit/8bbad8a60c6db203424d34e4bf433289127b1bd9))
- secret name
  ([faf1123](https://github.com/orochibraru/homerun/commit/faf11238cfec14becb7bf25dd5479ddfceb453e2))
- service details
  ([61964a3](https://github.com/orochibraru/homerun/commit/61964a329e76dafb3abbb962f716729bd8748451))
- spinner
  ([b132c80](https://github.com/orochibraru/homerun/commit/b132c800ffb76d32c9447be2aa216a2c832f939d))
- type errors
  ([4ef257c](https://github.com/orochibraru/homerun/commit/4ef257cf74484fb1e91d5afea4483c8d0b178555))
- types
  ([5f5404e](https://github.com/orochibraru/homerun/commit/5f5404e04aa11a5d4b613468e35884b0d7adec68))
- ui
  ([aee3fb2](https://github.com/orochibraru/homerun/commit/aee3fb24045bc3cd9a2f6906e76a8e0f905696e1))
- ui & release
  ([cb277b3](https://github.com/orochibraru/homerun/commit/cb277b322972089d45f43612b3ead56f9c74ec5a))
- ui consistency
  ([89b75fc](https://github.com/orochibraru/homerun/commit/89b75fca732ebe4aebfcac05345c6e64f15d1ddd))
- upgrade svelte smol
  ([a813ad1](https://github.com/orochibraru/homerun/commit/a813ad167501432d89efa42ee3207144df0c4cee))
- variables
  ([96d1d92](https://github.com/orochibraru/homerun/commit/96d1d92a2f5df01bed493b8dfc77ed2cea1e676f))
- versions
  ([57ba011](https://github.com/orochibraru/homerun/commit/57ba0114597c49f9767030b89a40bacc6e0dcd82))

### Performance Improvements

- speed up ci
  ([9b851e8](https://github.com/orochibraru/homerun/commit/9b851e89559790aedba9198654cecb1b6e4db160))

## [0.3.8](https://github.com/orochibraru/homerun/compare/v0.3.7...v0.3.8) (2026-08-26)

### Bug Fixes

- docs
  ([6417c8e](https://github.com/orochibraru/homerun/commit/6417c8e023e95f32c9cd2858a403f9f614ccdc26))

## [0.3.7](https://github.com/orochibraru/homerun/compare/v0.3.6...v0.3.7) (2026-08-25)

### Bug Fixes

- dockerfile
  ([3aa766a](https://github.com/orochibraru/homerun/commit/3aa766ae38f35d27bf793776c8138351c88d0576))
- nginx alpine
  ([d63647f](https://github.com/orochibraru/homerun/commit/d63647fa457f1b8512d0658ae62c0c73381b9c8d))

## [0.3.6](https://github.com/orochibraru/homerun/compare/v0.3.5...v0.3.6) (2026-08-25)

### Features

- better linting & precommit
  ([#8](https://github.com/orochibraru/homerun/issues/8))
  ([a3f3c6e](https://github.com/orochibraru/homerun/commit/a3f3c6e5ed68f2065a9aa1830f4aa46395b9f713)),
  closes [#123](https://github.com/orochibraru/homerun/issues/123)
  [#456](https://github.com/orochibraru/homerun/issues/456)
- e2e tests and docs website
  ([84eca8b](https://github.com/orochibraru/homerun/commit/84eca8bcb01902a8cab2f11ca0e70ad6bfd92235))

## [0.3.5](https://github.com/orochibraru/homerun/compare/v0.3.4...v0.3.5) (2026-08-25)

### Features

- tests ([#7](https://github.com/orochibraru/homerun/issues/7))
  ([7bc3aa7](https://github.com/orochibraru/homerun/commit/7bc3aa7d2dd7b5ec8058d656c9ac5556850078e3)),
  closes [#123](https://github.com/orochibraru/homerun/issues/123)
  [#456](https://github.com/orochibraru/homerun/issues/456)

## [0.3.4](https://github.com/orochibraru/homerun/compare/v0.3.3...v0.3.4) (2026-08-24)

### Bug Fixes

- oop
  ([04f58b0](https://github.com/orochibraru/homerun/commit/04f58b03b6270440032f3236e54afbe441353a6e))

## [0.3.3](https://github.com/orochibraru/homerun/compare/v0.3.2...v0.3.3) (2026-08-23)

### Features

- more networking
  ([2b27d11](https://github.com/orochibraru/homerun/commit/2b27d116e8226d445a093fcf76e899e9b9533bed))
- more stuff
  ([c9d2bc4](https://github.com/orochibraru/homerun/commit/c9d2bc4c99b4f683ffa602f12278f0873da2d5d7))
- pangolin integration
  ([021765c](https://github.com/orochibraru/homerun/commit/021765caa606bbe074125e1f31e240fb2ab4d5d1))
- swarm mode
  ([7cf7308](https://github.com/orochibraru/homerun/commit/7cf7308b62d35fe349d8bb816c209fda51b9433d))
- unit tests
  ([c2f6b17](https://github.com/orochibraru/homerun/commit/c2f6b17d367b388342a3933fcc9c6a90603c3d7e))

### Bug Fixes

- ci
  ([39cb4d6](https://github.com/orochibraru/homerun/commit/39cb4d6a7fcc89118fa382a1f29b482cb675414d))
- ci docker build
  ([84fbe3f](https://github.com/orochibraru/homerun/commit/84fbe3f4eec42788171eb8803e9bc00b9a4aec93))
- docker builds
  ([0de636c](https://github.com/orochibraru/homerun/commit/0de636ceda8520cdc47cdd3b77487b07ef04b340))
- docker conf
  ([66cb582](https://github.com/orochibraru/homerun/commit/66cb58223f27ea63c7991ef6083c0738d4276f40))
- notifications
  ([402e509](https://github.com/orochibraru/homerun/commit/402e50983ac7412b675a48c71120352b771ba0de))
- release note version
  ([59c8b5d](https://github.com/orochibraru/homerun/commit/59c8b5df608df9b2916680ad44cc7ee1455da18c))
- remove build from webapp in ci, already ran by docker
  ([fea99e0](https://github.com/orochibraru/homerun/commit/fea99e0e2c81b493c9fca15a82dac97ddd601cbf))
- types
  ([5f5404e](https://github.com/orochibraru/homerun/commit/5f5404e04aa11a5d4b613468e35884b0d7adec68))
- versions
  ([57ba011](https://github.com/orochibraru/homerun/commit/57ba0114597c49f9767030b89a40bacc6e0dcd82))

### Performance Improvements

- speed up ci
  ([9b851e8](https://github.com/orochibraru/homerun/commit/9b851e89559790aedba9198654cecb1b6e4db160))

## [0.3.2](https://github.com/orochibraru/homerun/compare/v0.3.1...v0.3.2) (2026-08-21)

### Bug Fixes

- cli
  ([be0c839](https://github.com/orochibraru/homerun/commit/be0c839c81831bc03b9f58feaee93ef42079b310))
- format
  ([0dacdac](https://github.com/orochibraru/homerun/commit/0dacdac55caeb82194ded204e1349008fda42252))
- prettier on changelog
  ([11aff9a](https://github.com/orochibraru/homerun/commit/11aff9adb83ecf95825d994b43a4cd83add8dd2f))
- release conf
  ([8da3b9b](https://github.com/orochibraru/homerun/commit/8da3b9bd8bd2d0f386d5d39043155b573bf8d419))

## [0.3.1](https://github.com/orochibraru/homerun/compare/v0.3.0...v0.3.1) (2026-08-21)

### Features

- cli auth improvements
  ([586e328](https://github.com/orochibraru/homerun/commit/586e3285cf6374ebcd47615eb475e665bb707b03))

## [0.3.0](https://github.com/orochibraru/homerun/compare/v0.2.0...v0.3.0) (2026-08-21)

### Features

- stronger CI ([#3](https://github.com/orochibraru/homerun/issues/3))
  ([b9477eb](https://github.com/orochibraru/homerun/commit/b9477ebda039743b61b186c608b68fc9cfc6cb35)),
  closes [#123](https://github.com/orochibraru/homerun/issues/123)
  [#456](https://github.com/orochibraru/homerun/issues/456)

### Bug Fixes

- docs
  ([0f7defa](https://github.com/orochibraru/homerun/commit/0f7defaa437823c605609e13334b617eebfab977))
- md
  ([6d92399](https://github.com/orochibraru/homerun/commit/6d92399e2c7ca79d3761b187346a5d7587c24207))

## [0.2.0](https://github.com/orochibraru/homerun/compare/v0.1.0...v0.2.0) (2026-08-21)

### Features

- docs & release tag
  ([c99933d](https://github.com/orochibraru/homerun/commit/c99933d85f3532a11ff4d502e98e9f7e4c0c649c))
