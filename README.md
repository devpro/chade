# Chade

[![CI](https://github.com/devpro/chade/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/devpro/chade/actions/workflows/ci.yaml)
[![PKG](https://github.com/devpro/chade/actions/workflows/pkg.yaml/badge.svg?branch=main)](https://github.com/devpro/chade/actions/workflows/pkg.yaml)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=devpro_chade&metric=alert_status)](https://sonarcloud.io/dashboard?id=devpro_chade)

Command line tool and local web interface to get insights on one machine and manage its git repositories:

- Commits the configuration of the system into a git repository.
- Lists every git repository of the machine with its current state and provides common git actions.
- Measures what takes disk and memory and how to clean it.

> [!IMPORTANT]
> Chade never changes the system, and changes a git repository only when asked in the web interface.

## Requirements

- Linux and/or Windows 11
- Node.js 24 or later
- git

## Quick start

1. Give npm access to the packages of `@devpro` on GitHub Packages, in `~/.npmrc`, with a GitHub token that has the `read:packages` scope.

   ```ini
   @devpro:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=<token>
   ```

2. Install chade.

   ```bash
   npm install --global @devpro/chade
   ```

3. Create the store and the configuration file, `~/.chade/config.yml`.

   ```bash
   chade init --store ~/system-snapshots
   ```

4. List the configuration files present on the system, to add under `files` in the configuration.

   ```bash
   chade discover
   ```

5. Take a snapshot, then open the web interface.

   ```bash
   chade snapshot
   chade ui
   ```

## Documentation

- [Configuration](docs/configuration.md)
- [Contributor guide](CONTRIBUTING.md)
- [Commands](docs/commands.md)
- [System clean-up](docs/cleanup.md)
- [Web interface](docs/web-interface.md)

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free to use, change and share for any noncommercial purpose.
Any commercial use, including shipping chade or a part of its code in a product, needs a separate license from the author.
Versions up to 0.1.4 were published under MIT.
