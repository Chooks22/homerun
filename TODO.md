<!-- vale off -->

# TODO

The backlog, and the only one. There is no priority ordering, pick whatever.
When done delete the entry, no bloat.

## Small

- [ ] CLAUDE.md and the check-repo skill say `bun run type-check`, but the
      package.json script is `typecheck`; make them agree

- [ ] Backup destination capacity: on an SFTP or WebDAV box with automatic
      snapshots, `rclone about` reports used as live files only, so the size
      shown is used + free and space held by snapshots is invisible; say so on
      the Storage panel, and in the docs: deleted backups only free space once
      the snapshots holding them are gone

- [ ] Storage Box integration tests never delete what they upload: each run
      leaves its restic repositories under `homerun-it/<type>/` in the
      configured location; purge that prefix after the round trip

- [ ] Backup cleanup skips backups of deleted volumes: they stay on the
      destination forever; offer to delete them when a volume is deleted, or
      list them as orphans on the destination's page

## Medium

- [ ] Pipelines: expose watched repositories, their CI runs and stats in the
      REST API, MCP server and CLI, and sync on the provider's workflow webhook
      instead of only polling

## Large

- [ ] Pulumi projects: generate a Pulumi program
      (`new homerun.X(..., { import })`) from the inventory like the HCL
      generator, and a drift check reading Pulumi's checkpoint from the bucket

- [ ] Package registries: run language package registries (npm first, then PyPI,
      Maven, Cargo...) from Homerun as core services like the Docker registry,
      with tokens and an optional public hostname, listed under Registries in
      the sidebar next to Docker Registry
