# AGENTS.md

The instructions for any coding agent working in this repo live in
[`CLAUDE.md`](CLAUDE.md): how to work here, the commands, and the conventions
every change has to follow. Read it first, then the `.agents/notes/` file for
the area you're touching (CLAUDE.md's "Reference notes" table says which).

- The backlog is [`TODO.md`](TODO.md), and it's the only one.
- A change is done when `bun run type-check`, `bun run lint` and `bun run test`
  all exit 0.
- Workflows are encoded as skills under `.agents/skills/`, one folder per skill
  with its own skill file.
