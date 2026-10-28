# chade

Command line tool that snapshots the configuration of a system into a git repository, one folder per machine.

A snapshot holds configuration files and inventories: installed applications, VS Code extensions, services, scheduled tasks and git repositories.
On WSL, one run captures the Windows host and the distribution.
chade only reads the system, it never changes it.

## Installation

```bash
npm install --global chade
```

## Usage

```bash
chade init --store ~/system-snapshots   # configuration in ~/.chade/config.yml, store created when missing
chade discover                          # configuration files present and not configured yet
chade snapshot                          # collect, redact secrets, commit
chade diff                              # what changed since the previous snapshot
```

## Documentation

The configuration, the inventories and the handling of secrets are documented in the [repository](https://github.com/devpro/chade#readme).
