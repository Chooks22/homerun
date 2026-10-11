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

## Large

- [ ] Pulumi projects: generate a Pulumi program
      (`new homerun.X(..., { import })`) from the inventory like the HCL
      generator, and a drift check reading Pulumi's checkpoint from the bucket

- [ ] Package registries: run language package registries (npm first, then PyPI,
      Maven, Cargo...) from Homerun as core services like the Docker registry,
      with tokens and an optional public hostname, listed under Registries in
      the sidebar next to Docker Registry
