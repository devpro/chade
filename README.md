# Chade

[![CI](https://github.com/devpro/chade/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/devpro/chade/actions/workflows/ci.yaml)
[![PKG](https://github.com/devpro/chade/actions/workflows/pkg.yaml/badge.svg?branch=main)](https://github.com/devpro/chade/actions/workflows/pkg.yaml)
[![npm](https://img.shields.io/npm/v/chade?label=npm&logo=npm)](https://www.npmjs.com/package/chade)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=devpro_chade&metric=alert_status)](https://sonarcloud.io/dashboard?id=devpro_chade)

Command line tool that snapshots the configuration of a system into a git repository, one folder per machine.

The system is read like a git repository: `chade snapshot` commits what is configured, `chade diff` shows what changed since.
A snapshot holds configuration files (`/etc/wsl.conf`, `C:\Users\<user>\.wslconfig`, `/etc/docker/daemon.json`),
and inventories: installed applications, VS Code extensions, services, scheduled tasks and git repositories.

chade only reads the system, it never changes it.
`chade report` measures what takes disk and memory, the space WSL takes on C: above all, and gives the command that gets each one back.
It is the tool, the snapshots live in the store, a folder of a git repository chosen at `chade init`.
The store is a dedicated repository, or a subfolder of a repository that holds other things, such as personal notes.

## Requirements

- Linux, or WSL on Windows, where one run captures the Windows host and the distribution
- Node.js 24 or later
- git
- [gitleaks](https://github.com/gitleaks/gitleaks), recommended, for the secret scan before each commit

## Installation

```bash
npm install --global chade
```

## Quick start

1. Create the store and the configuration file, `~/.chade/config.yml`.

   ```bash
   chade init --store ~/system-snapshots
   ```

   A path in no git repository becomes a new one.
   A path in an existing repository, such as `~/repos/personal-notes/systems`, is used as it is, a subfolder of that repository.
   The store holds system details, so a remote, if any, stays private.

2. List the configuration files present on the system and missing from the configuration.

   ```bash
   chade discover
   ```

   It prints them as YAML, ready to copy under `files` in the configuration.

3. Take the snapshot.

   ```bash
   chade snapshot
   ```

   `--dry-run` lists what would be written, without writing or committing.

4. Show what changed between the last two snapshots.

   ```bash
   chade diff
   ```

## Store layout

```txt
<store>/
└── DESKTOP-9AMBHO5/                  machine, the Windows computer name on WSL, the hostname on Linux
    ├── windows/                      Windows host, on WSL only
    │   ├── files/C/Users/bthom/.wslconfig
    │   └── inventories/winget.json
    └── wsl-ubuntu/                   distribution, linux outside of WSL
        ├── files/etc/wsl.conf
        ├── files/home/bertrand/.istarci/config.yml
        └── inventories/apt-manual.txt
```

A file keeps its absolute path under `files/`.
Each snapshot rewrites the folder of the system, so a file removed from the configuration, or from the system, disappears from the next commit.
Only the folder of the current machine is committed, so several machines share one store, and anything else of the repository, staged or not, stays out of the commit.

## Configuration

`~/.chade/config.yml`, or the file `CHADE_CONFIG` or `--config` names.

```yaml
store: ~/system-snapshots
linux:
  files:
    - /etc/wsl.conf
    - /etc/docker/daemon.json
    - /etc/apt/sources.list.d
    - ~/.istarci/config.yml
  inventories:
    - apt-manual
    - vscode-extensions
    - systemd-services
    - name: pip
      command: pip list --user
  repos:
    - ~/repos
windows:
  files:
    - '%USERPROFILE%\.wslconfig'
    - '%APPDATA%\Code\User\settings.json'
  inventories: [winget, vscode-extensions, wsl-distros, scheduled-tasks]
  repos:
    - '%USERPROFILE%\projects'
redact:
  - ^license$
```

Key                | Content
-------------------|--------------------------------------------------------------------------------------------------
`store`            | Folder the snapshots are written to, the root of a git repository or a subfolder of one, required
`machine`          | Name of the machine folder, detected when absent
`linux`, `windows` | One section per system, a system without its section is not captured
`files`            | Absolute paths of files, a folder stands for every file under it
`inventories`      | Built-in inventory names, or a custom one with a `name` and a `command`
`repos`            | Folders scanned for git repositories, three levels deep, into the `git-repos` inventory
`redact`           | Regular expressions of key names whose values are masked, on top of the defaults

A Linux path starts with `/` or `~`.
A Windows path starts with a drive letter or a variable such as `%USERPROFILE%`, and is written between single quotes, where YAML keeps backslashes as they are.

A custom inventory runs its command with `sh -c` on Linux and `cmd.exe /c` on Windows, and saves the output to `inventories/<name>.txt`.

## Inventories

Name                    | System  | Source                                             | Content
------------------------|---------|----------------------------------------------------|-------------------------------------------------------------
`apt-manual`            | Linux   | `apt-mark showmanual`                              | Packages installed on purpose, not their dependencies
`snap`                  | Linux   | `snap list`                                        | Snaps and their versions
`vscode-extensions`     | Linux   | `code --list-extensions --show-versions`           | Extensions of VS Code, those of the WSL server on WSL
`npm-global`            | Linux   | `npm ls --global --depth=0`                        | Global npm packages
`dotnet-tools`          | Linux   | `dotnet tool list --global`                        | Global .NET tools
`git-config`            | Linux   | `git config --global --list`                       | Global git settings
`crontab`               | Linux   | `crontab -l`                                       | Scheduled jobs of the user
`systemd-services`      | Linux   | `systemctl list-unit-files --state=enabled`        | Enabled system services and timers
`systemd-user-services` | Linux   | `systemctl --user list-unit-files --state=enabled` | Enabled user services and timers
`winget`                | Windows | `winget export`                                    | Installed applications, as a file `winget import` reads back
`vscode-extensions`     | Windows | `code --list-extensions --show-versions`           | Extensions of VS Code on Windows
`wsl-distros`           | Windows | `wsl.exe --list --quiet`                           | WSL distributions
`git-config`            | Windows | `git config --global --list`                       | Global git settings
`scheduled-tasks`       | Windows | `schtasks /query`                                  | Scheduled task names, those under `\Microsoft\` left out
`git-repos`             | Both    | `git remote -v` in each repository under `repos`   | Repository paths and remotes

An inventory whose tool is not installed is skipped, and the run says so.

## Secrets

A snapshot is meant for a git repository, so chade masks secrets before writing them.

- Values of keys named like a secret are replaced by `***`: `token`, `password`, `passwd`, `secret`, `apikey`, `api_key`, `credential`, `private_key`, `auth`, `*-key-data`, and the `redact` entries.
- Credentials in URLs keep the user and lose the password: `https://user:***@host`.
- gitleaks scans the staged snapshot before the commit, and a finding stops it, with nothing committed.
- `--no-secret-scan` commits without the scan, and a missing gitleaks gives a warning.

## Clean-up

```bash
chade report
```

The report measures, and changes nothing:

- on WSL, the free space of C:, the size of each disk image against what Linux uses in it, and the memory settings of `.wslconfig`
- the memory, swap and largest processes
- the timers that trim the disk, Docker data and what of it is unused, the systemd journal, snap revisions kept for a rollback
- the caches of the tools, the Claude Code sessions, and the size of the repositories under `repos`

Each finding comes with the command or setting that fixes it, and a link to [docs/cleanup.md](docs/cleanup.md), which explains each step.
`--json` prints the report as JSON.

## Commands

Command                     | Effect
----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
`chade init --store <path>` | Writes the configuration, creates the store folder, and a git repository when the folder is in none, `--force` overwrites an existing configuration
`chade discover`            | Prints the known configuration files present on the system and missing from the configuration, and the Debian configuration files changed since their installation
`chade snapshot`            | Collects, redacts, writes and commits, `--dry-run` lists only, `--push` pushes the repository of the store after the commit, `--no-secret-scan` skips gitleaks
`chade report`              | Measures disk and memory and suggests what to clean, without changing anything, `--json` prints JSON
`chade diff [rev]`          | Compares the last snapshot with the previous one, or with `rev`, `--since <date>` with the last one before that date, `--stat` lists the files, `--machine <name>` reads another machine folder

`--config <path>` applies to every command.

## Roadmap

- `chade clean`, running the clean-up steps the configuration lists, after a confirmation
- Web viewer of the store: machines, snapshots, files and differences
- Restore scripts generated from a snapshot, `winget import` and `code --install-extension` for instance
- Native Windows, without WSL

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, the tests and the pipelines.
