<!-- vale off -->

# TODO

The backlog, and the only one. There is no priority ordering, pick whatever.
When done delete the entry, no bloat.

## Small

- [ ] Route `screenshots.yaml` and `e2e.yaml` Docker Hub pulls through
      mirror.gcr.io like the integration job, they can flake on an anonymous
      pull refusal the same way
- [ ] Notification channels: move the "Add a channel" form off the list page
      onto its own `channels/new` route, like every other list page

## Medium

- [ ] Workstations behind the per-app login wall: the gate is service-shaped
      (`gatedService`, `AppAccessService`), a workstation only has the IDE's own
      password today
- [ ] Workstations in the REST API, the CLI and the Terraform provider
- [ ] Workstations on a raw `docker` remote host (the worker's
      `dockerapi.NewRemote`), only agent hosts can run one today
- [ ] Workstation start never re-pulls an image it already has, so a `:latest`
      IDE image never updates: add a "pull" toggle or always pull on Recreate
- [ ] Deleting an agent host cascades its workstation rows but leaves their
      containers on that host and their Traefik route file behind
- [ ] A service created after a workstation can take the workstation's slug, and
      the two then fight over the same hostname: check workstation slugs on
      service creation too

## Large

- [ ] Pulumi projects: generate a Pulumi program
      (`new homerun.X(..., { import })`) from the inventory like the HCL
      generator, and a drift check reading Pulumi's checkpoint from the bucket

- [ ] Package registries: run language package registries (npm first, then PyPI,
      Maven, Cargo...) from Homerun as core services like the Docker registry,
      with tokens and an optional public hostname, listed under Registries in
      the sidebar next to Docker Registry
