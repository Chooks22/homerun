# Homerun Manifest

A Homerun Manifest is a service's configuration kept as a file: its port,
environment, resources, health check, build method, domains, login wall,
previews and so on. Commit it to the repository as `.homerun.json` (or
`.homerun.yaml` / `.homerun.yml`, same keys) and every deploy of a service built
from that repository applies it before building. Or apply it to any service,
image-based ones included, with the CLI or the REST API.

```json
{
  "$schema": "https://raw.githubusercontent.com/orochibraru/homerun/main/manifest.schema.json",
  "gitBuildMethod": "railpack",
  "containerPort": 3000,
  "envVars": { "NODE_ENV": "production" },
  "memoryLimitMb": 512,
  "healthcheckCommand": "wget -qO- http://localhost:3000/health",
  "domains": ["app.example.com"],
  "authRequired": true,
  "authProviders": ["email-otp"],
  "authAllowedEmails": ["*@example.com"],
  "previewsEnabled": true,
  "previewAuthRequired": true,
  "previewAuthProviders": ["email-otp"],
  "previewAuthAllowedEmails": ["*@example.com"]
}
```

**The schema.** Every key is optional and uses the REST API's field name, so the
[OpenAPI document](api-and-cli.md) and the Terraform provider describe the same
settings. The JSON schema is published at the root of Homerun's repository
(`manifest.schema.json`, the URL above) and served by every instance for its own
version at `/api/v1/manifest.schema.json`. Point `$schema` at either for
completion and linting in your editor; for YAML, add
`# yaml-language-server: $schema=<that URL>` as the first line. An unknown key
is an error, so a typo fails loudly instead of being ignored.

**How it applies.** Keys you leave out keep whatever value the service has, so a
manifest can hold only what you care about. `envVars` are **merged** into the
service's environment: a variable set on the dashboard and missing from the
manifest is kept, which is where secrets belong (don't commit them). Removing a
key from the manifest doesn't reset it either. Every value goes through the same
checks as the dashboard's forms: a sign-in method that isn't enabled or a bad
cron schedule is refused with the same message.

**What it can't set.** Host access (privileged mode, devices, Linux
capabilities, env files), Docker labels, host networking, published host ports,
registry credentials, custom TLS certificates, the slug, the stack and the git
source itself. Those stay on the dashboard or in Terraform, so write access to a
repository never grants root on the server. A service built from git ignores
`image`, `tag` and `pullPolicy`.

## In the repository

On every deploy of a git service, Homerun looks for `.homerun.json`,
`.homerun.yaml` then `.homerun.yml` at the ref being deployed: first in the
build context directory (`gitBuildContext`, for a monorepo), then at the
repository root. It reads the file without checking the repository out, with the
same credentials the build uses, then builds exactly the commit it read the
manifest from (unless required status checks pin another one). The deployment
log says which file it applied, from which commit, and which keys. An invalid
manifest fails the deploy with the problems listed, before anything is built. No
file, no change. A rollback restores the rolled-back revision's settings and
doesn't read the repository.

**Pull request previews and release channel canaries** only take how the app is
built and run: build, image and runtime keys (port, command, environment,
resources, health check, restart policy). Domains, the login wall, blocked
paths, the preview policy and the rest come from the parent service, so a pull
request can neither open its own preview's login wall nor claim a production
hostname.

**When creating a service** from a repository, the wizard reads the manifest the
same way, before anything is deployed: it fills in the port and shows the rest,
over whatever the Dockerfile declares, see
[Services](services.md#detected-from-the-image-dockerfile-or-manifest).

## With the CLI or the API

```sh
homerun manifest validate                      # checks ./.homerun.json (or .yaml/.yml)
homerun manifest apply my-app                  # applies it to the service my-app
homerun manifest apply my-app --file ops/staging.yaml --deploy
```

`apply` prints the keys applied and the ones the service left out; `--deploy`
queues a deploy afterwards. The REST API equivalents are
`PUT /api/v1/services/{serviceId}/manifest` (add `?deploy=true`) and
`POST /api/v1/manifests/validate`, taking JSON, or YAML with a YAML content
type. Applying needs write access to Services. On a git service whose repository
carries its own manifest, the repository's copy is applied again on the next
deploy and wins for the keys it sets.
