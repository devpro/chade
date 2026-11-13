# Configuration

`~/.chade/config.yml`, or the file `CHADE_CONFIG` or `--config` names, which `chade init` writes.

## Example

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
cleanup:
  - docker-images
  - journal
  - name: jetbrains-cache
    command: rm -rf ~/.cache/JetBrains
  - fstrim
```

## Keys

Key                | Content
-------------------|--------------------------------------------------------------------------------------------------------------
`store`            | Folder the snapshots are written to, the root of a git repository or a subfolder of one, required
`machine`          | Name of the machine folder, detected when absent
`linux`, `windows` | One section per system, a system without its section is not captured
`files`            | Absolute paths of files, a folder stands for every file under it
`inventories`      | Built-in inventory names, or a custom one with a `name` and a `command`
`repos`            | Folders scanned for git repositories, three levels deep, into the `git-repos` inventory and the web interface
`redact`           | Regular expressions of key names whose values are masked, on top of the defaults
`cleanup`          | Steps `chade clean` runs, built-in names or a custom one with a `name` and a `command`

A Linux path starts with `/` or `~`.
A Windows path starts with a drive letter or a variable such as `%USERPROFILE%`, and is written between single quotes, where YAML keeps backslashes as they are.

## Store

The store is a dedicated repository, or a subfolder of a repository that holds other things, such as personal notes.
It holds system details, so a remote, if any, stays private.

The store has one folder per machine, and in it one folder per system: `windows` for the Windows host, the name of the distribution on WSL, `linux` on Linux.
A file keeps its absolute path under `files/`, an inventory is a file of `inventories/`.

A snapshot is one commit, named after the machine, its systems and the local date and time: `DESKTOP-9AMBHO5: snapshot of windows, wsl-ubuntu, 2026-11-10 17:45`.
Each snapshot rewrites the folder of the system, so a file removed from the configuration, or from the system, disappears from the next commit.
Only the folder of the current machine is committed, so several machines share one store, and anything else of the repository, staged or not, stays out of the commit.

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
A custom inventory runs its command with `sh -c` on Linux and `cmd.exe /c` on Windows, and saves the output to `inventories/<name>.txt`.

## Secrets

A snapshot is meant for a git repository, so chade masks secrets before writing them.

- Values of keys named like a secret are replaced by `xxx`: `token`, `password`, `passwd`, `secret`, `apikey`, `api_key`, `credential`, `private_key`, `auth`, `*-key-data`, and the `redact` entries.
- Credentials in URLs keep the user and lose the password: `https://user:xxx@host`.
- gitleaks scans the staged snapshot before the commit, and a finding stops it, with nothing committed.
- `--no-secret-scan` commits without the scan, and a missing gitleaks gives a warning.
