# chade

Command line tool and local web interface that keep track of a machine and its git repositories.

- `chade snapshot` commits the configuration of the system, files and inventories, into a git repository, the store, one folder per machine.
- `chade ui` lists every git repository of the machine with what is left to commit, push or pull, and shows the store and the report.
- `chade report` measures what takes disk and memory, and `chade clean` gets it back.

chade never changes the system, and changes a git repository only when asked in the web interface.

## Quick start

```bash
npm install --global @devprofr/chade
chade init --store ~/system-snapshots
chade discover
chade snapshot
chade ui
```

## Documentation

The [user guide](https://github.com/devpro/chade#readme) links to every page, which `chade ui` also shows, offline.
