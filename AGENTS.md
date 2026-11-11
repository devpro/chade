# chade: agent context

CLI (`chade` on npmjs.org) that snapshots the configuration of a system into a git repository, the store, one folder per machine.
chade is the tool, never the store: the snapshots live in a repository the user chooses, and nothing in this repository holds them.
`chade ui` opens a local web interface over the git repositories of the machine, the store and the report: `packages/daemon` is its server, `packages/ui` its page, both bundled into the one published package.
The interface changes a repository only through the actions of `packages/daemon/src/actions.ts`, where every value given to git is checked against what git itself lists.
A change of the interface is checked with `task ui:screenshots`, and by looking at the screenshots it saves.
CONTRIBUTING.md lists the tasks, `task check` runs what CI runs.

## Working rules

- **Every command runs in the foreground, and the agent waits for it.**
  No background commands, no subagents, no forks, no parallel tasks, even for a long commands.
- Headers stay: concise documentation still has sections.
- Linters for YAML and Markdown are never run by an agent.
- Commit only when asked, and never push.
  Shell scripts are `snake_case` and committed with the executable bit (`git update-index --chmod=+x`).
- Documentation is simple, exhaustive and precise, with only the essential information presented in an obvious way, in a normal human flow.

## Writing style

Applies to Markdown, code comments, commit messages and prose in scripts.

- **A comment says why, not what, and the why is timeless.**
- **One thought per line.**
  Every sentence starts on its own line, can be cut if longer than 240 characters but on a natural break (before "and", "so", ",").
- **No em dash, no en dash.**
  A colon, a comma, or a full stop.
- **No second person.**
  "The working tree", not "your working tree"; `<token>`, not `<your-token>`.
