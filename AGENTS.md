## Agent conventions

### Issue tracker

Issues and specs live as local markdown files under `.scratch/` (gitignored and
kept local; back the directory up separately). Before starting an implementation
ticket, add `Claimed by: <session/agent> (date)` under its `Status:` line so a
parallel session does not pick the same ticket. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Read `docs/adr/` for decisions that touch the area you are changing. See
`docs/agents/domain.md`.

### Coding standards

`CODING_STANDARDS.md` — module boundaries, UI ownership, test shape and the
review protocol. Review agents must read it before reviewing.

### Checks

`npm run check` parses every JS file, verifies the paths named in the agent
docs, and runs the unit suite. Install the tracked hook once per clone with
`npm run hooks:install`; CI runs the same command.
