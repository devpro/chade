# chade

Command line tool that snapshots the configuration of a system into a git repository, one folder per machine.

A snapshot holds configuration files and inventories: installed applications, VS Code extensions, services, scheduled tasks and git repositories.
It runs on Linux, on WSL, where one run captures the distribution and its Windows host, and on Windows.
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
chade report                            # disk and memory taken, and how to get them back
chade clean                             # run the clean-up steps of the configuration, after a confirmation
```

## Documentation

The configuration, the inventories and the handling of secrets are documented in the [repository](https://github.com/devpro/chade#readme).
