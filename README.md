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
`chade ui` opens a web interface served on the machine, which lists every git repository of the machine with what is left to commit, push or pull.
The same interface shows the store, snapshot by snapshot, and the report.
A git repository is the one thing chade changes, and only when asked at that interface: a fetch, a pull, a checkout, a new branch, a commit, an amend or a push.
`chade report` measures what takes disk and memory, the space WSL takes on C: above all, and gives the command that gets each one back.
It is the tool, the snapshots live in the store, a folder of a git repository chosen at `chade init`.
The store is a dedicated repository, or a subfolder of a repository that holds other things, such as personal notes.

## Requirements

- One of these systems, where a run captures:
  - on Linux, the Linux system
  - on WSL, in the distribution, the distribution and its Windows host
  - on Windows 11, in a Command Prompt or PowerShell terminal, the Windows system
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
└── DESKTOP-9AMBHO5/                  machine, the Windows computer name on WSL and Windows, the hostname on Linux
    ├── windows/                      Windows host, on WSL and Windows
    │   ├── files/C/Users/bthom/.wslconfig
    │   └── inventories/winget.json
    └── wsl-ubuntu/                   distribution on WSL, linux on Linux
        ├── files/etc/wsl.conf
        ├── files/home/bertrand/.istarci/config.yml
        └── inventories/apt-manual.txt
```

A file keeps its absolute path under `files/`.
A snapshot is one commit, named after the machine, its systems and the local date and time: `DESKTOP-9AMBHO5: snapshot of windows, wsl-ubuntu, 2026-11-10 17:45`.
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
cleanup:
  - docker-images
  - journal
  - name: jetbrains-cache
    command: rm -rf ~/.cache/JetBrains
  - fstrim
```

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

- Values of keys named like a secret are replaced by `xxx`: `token`, `password`, `passwd`, `secret`, `apikey`, `api_key`, `credential`, `private_key`, `auth`, `*-key-data`, and the `redact` entries.
- Credentials in URLs keep the user and lose the password: `https://user:xxx@host`.
- gitleaks scans the staged snapshot before the commit, and a finding stops it, with nothing committed.
- `--no-secret-scan` commits without the scan, and a missing gitleaks gives a warning.

## Clean-up

```bash
chade report
```

The report measures, and changes nothing:

- on WSL and Windows, the free space of C:, the size of each WSL disk image, and the memory settings of `.wslconfig` once a distribution is installed
- on WSL, the size of the disk image of the distribution against what Linux uses in it
- the memory and the largest processes
- Docker data and what of it is unused
- on Linux and WSL, the swap, the timers that trim the disk, the systemd journal, snap revisions kept for a rollback
- the caches of the tools, the Claude Code sessions, and the size of the repositories under `repos`

Each finding comes with the command or setting that fixes it, and a link to [docs/cleanup.md](docs/cleanup.md), which explains each step.
`--json` prints the report as JSON.

```bash
chade clean
```

The clean-up runs the steps listed under `cleanup` in the configuration, and only those.
It shows each step with its commands, asks for a confirmation, then runs them one after the other, with their output.

Step                 | Command
---------------------|----------------------------------------------------------------------------
`docker-images`      | `docker image prune -a --filter until=168h -f`
`docker-volumes`     | `docker volume prune -f`
`docker-build-cache` | `docker builder prune -f`
`npm-cache`          | `npm cache clean --force`
`nuget-cache`        | `dotnet nuget locals all --clear`
`pnpm-store`         | `pnpm store prune`
`journal`            | `sudo journalctl --vacuum-size=500M`
`snap-revisions`     | `sudo snap remove <name> --revision=<revision>`, for each disabled revision
`fstrim`             | `sudo fstrim -av`

The steps run in this order, the custom ones before `fstrim`, so the trim covers the space the others free.
A step whose tool is not installed is skipped, a failed step is reported and the next ones still run.
On Windows, `journal`, `snap-revisions` and `fstrim` are skipped, and the other steps and the custom ones run through `cmd.exe /c`, where Linux runs a custom one with `sh -c`.
`--dry-run` shows the steps without running them, and `--yes` runs them without asking, for a timer or a script.

The compaction of the WSL disk image runs on Windows with WSL shut down, so it stays a manual step of [docs/cleanup.md](docs/cleanup.md#disk-image-compaction).

## Web interface

```bash
chade ui
```

The interface opens in the browser, the one of Windows on WSL, and the command returns.
The tab of the browser shows the icon of chade, a C drawn as a line of history between two commits.
Its server runs in the background, on `http://127.0.0.1:7843`: the first `chade ui` starts it, and the next ones find it running.
`--no-open` prints the address without opening it, and `--port <number>` starts the server on another port.

Command               | Effect
----------------------|-------------------------------------------------------------------------------------------
`chade daemon start`  | Starts the server when it is not running, `--port <number>` chooses the port
`chade daemon stop`   | Stops the server
`chade daemon status` | Tells whether the server runs, on what address and since when
`chade daemon run`    | Runs the server in the terminal until Ctrl+C, which is what `start` runs in the background

The server stops with the session of the user or the machine, and the next `chade ui` starts it again.
A `chade ui` of another version of chade replaces the server an earlier version started.
The folder of the configuration holds its state, `daemon.json`, and its output, `daemon.log`.
The configuration is read at each read of the repositories, so a folder added to `repos` shows without a restart.

The top of every page names the machine, then links to the four pages of the interface: Repositories, Store, Report and Docs.

Repositories is the page the interface opens on.
Each system of the machine is a tab, with the number of its repositories and of those with something to do.
A tab lists the git repositories found under `repos`, a Windows repository being read by the git of Windows, on WSL as well.

Column       | Content
-------------|----------------------------------------------------------------------------------------
Repository   | Name and path
Branch       | Checked out branch, or the commit of a detached HEAD
Upstream     | Commits ahead (↑) and behind (↓) the upstream branch, `no upstream`, or `upstream gone`
Working tree | Files changed, untracked and in conflict
Last commit  | Subject and age
Fetched      | Age of the last fetch or pull, which the ahead and behind counts are as old as

The mark at the start of a row is blue with commits to push, amber with something to commit or pull, and red with a conflict or a repository git cannot read.
The name of a repository opens its page.
When its remote is on the web, a link next to its path opens the remote in a tab of the browser, at the branch checked out once pushed, on GitHub, GitLab and Bitbucket.
The filter keeps the repositories whose name, path or branch holds every word typed.
The checkbox keeps those with something to commit, push, pull or fix.
The page reads again by itself every 30 seconds while it is looked at, and when its tab comes back to the front, the list as well as the page of a repository.
Refresh reads at once, without waiting for the next time.
The report is the exception: it is measured when its page opens and at Refresh, and never by itself.
The interface reads the repositories and changes nothing, and it fetches nothing either, so a count behind is the one of the last fetch.

### A repository

A row of the list opens the page of its repository, which goes from a branch to a commit, to its files, to the changes of one file.

Part     | Content
---------|------------------------------------------------------------------------------------------------------------------
Branches | Local and remote branches, the one checked out marked, each with what it is ahead and behind its upstream by
History  | Commits of every branch and tag from the newest, drawn as a graph, each with the branches and tags pointing at it
Changes  | Message, author and date of the commit chosen, and the list of the files it changed

A branch chooses the commit it points at.
A file of the list opens its changes in place of the history, line by line, and another file of the list takes its place.
Close, the Escape key, or another commit, brings the history back.
A merge shows what it brought to its first parent, the branch it was merged into.
When the working tree has changes, a first line of the history, Uncommitted changes, lists what is staged, what is changed and not staged, and the files not tracked, whose content shows as lines added.
The history lists 300 commits, and a button at its end shows 300 older ones.

### IstarCI

When IstarCI runs on the machine, the list and the page of a repository show what it said of the repositories it watches.

The list has a column IstarCI, with the mark of what it said last of each repository, a link to that run, when it watches one of the repositories listed.
A cell is grey when its run is of another commit than the one checked out, and its title names that commit and its branch.
The history of a repository marks each commit IstarCI ran with what came of it.

Mark | Meaning
-----|-------------------------------------
✓    | Passed
✕    | Failed
●    | Running
○    | Waiting to run
⊘    | Stopped
◌    | Skipped, or not run, with the reason

The mark tells the same in words when pointed at, and the changes of the commit chosen link to its run in IstarCI, or to the page of the repository for a commit not run.
A browser never signed in to IstarCI asks for its token there, which this command gives:

```bash
istarci ui
```

chade reads the port and the token of IstarCI from `~/.istarci/config.yml` at each read, and keeps neither.
The marks are read after the list and the history, so neither waits for them, and again at each read of the page.
A run of a workflow started by hand is not the run of its commit, and shows no mark.
When IstarCI does not run, does not answer within a second, or does not watch the repository, the list has no IstarCI column or an empty cell, the history shows no mark, and nothing else changes.
A repository is the same for both whether named from WSL or from Windows, `/mnt/c/Users/<user>/projects/<name>` being `C:\Users\<user>\projects\<name>`.
IstarCI runs on Linux and WSL alone, so chade on Windows without WSL shows none of it.

### Git actions

The page of a repository changes it through these actions, and no other.

Action       | Where                                    | What git runs
-------------|------------------------------------------|-----------------------------------------------------------------------------------
Fetch        | Top of the page                          | `git fetch --all --prune`
Pull         | Top of the page                          | `git pull --no-rebase --ff --no-edit`, and `git merge --abort` on a conflict
Push         | Top of the page                          | `git push`, or `git push --set-upstream origin <branch>` for a branch never pushed
New branch   | Top of the page, then a name             | `git switch --create <name>`, from the commit checked out
Check out    | Beside a branch, when it is pointed at   | `git switch <branch>`, or `git switch --track <remote>/<branch>` for a remote one
Stage, `+`   | Beside a file of the uncommitted changes | `git add --all -- <file>`
Unstage, `−` | Beside a staged file                     | `git reset -- <file>`
Stage all    | Beside Not staged, or Untracked          | `git add --all -- <files>`
Unstage all  | Beside Staged                            | `git reset`
Commit       | Under the message, above the files       | `git commit --message <message>`, of what is staged
Amend        | Under the message, Amend checked         | `git commit --amend --message <message>`, of a commit no remote holds

A pull fast forwards when it can, and otherwise merges the upstream into the branch with a merge commit, whatever `pull.rebase` and `pull.ff` say.
Checking Amend the last commit fills an empty box with the message of the commit checked out.
What is staged joins that commit, and with nothing staged the message alone changes.

While git works, the button that asked turns and a notice in a corner of the page says what is running.
The notice then says what was done, or what git answered when it refused, a push the pre-push hook of IstarCI blocked for instance.
A notice of a refusal stays until dismissed.
One action runs at a time in a repository, and the page reads the repository again after each.
The list of the repositories reads again when it is returned to, so it shows a repository as the action left it.

What is left to the terminal, on purpose:

- A pull that meets a conflict is aborted, and the branch stays as it was, to be merged or rebased by hand.
- Nothing is forced, discarded or deleted: no force push, no reset of the working tree, no branch deletion.
- A commit a remote holds is never rewritten, so Amend is off once the last commit is pushed.
- A conflict is resolved in an editor.

git runs as the user, with the credentials of the user: the SSH agent and the credential helper already set up.
chade holds no credential, and a command that would ask for a password in a terminal fails instead.
A message being written stays in its box, with its caret, while the page reads the repository again.

The bar between the history and the changes is dragged to give one the room of the other, and the browser keeps the width.
A double click on it brings the width back.
The address names the repository, the commit and the file, so the back button of the browser returns to the one before.
The changes of a file stop after 10,000 lines, and a patch of more than 2 MB is cut.

### The store

Store opens the store of the configuration, laid out as the page of a repository.

Part      | Content
----------|------------------------------------------------------------------------------------------------------------------
Machines  | Machine folders of the store, each with its systems and the number of its snapshots, the one of the server marked
Snapshots | Commits that changed the folder of the machine chosen, from the newest
Snapshot  | Message, author and date of the snapshot chosen, then its changes or its files, under the system they belong to

The page opens on the machine the server runs on, and on its last snapshot.
Changes lists what the snapshot changed since the one before on the same machine, and a file opens that comparison in place of the snapshots.
The first snapshot of a machine is compared with nothing, so each of its files is added.
Files lists every file the machine had at the snapshot, changed or not, and a file opens its content.
A commit of the repository that changed no file of the machine is not one of its snapshots.
When the repository holding the store is under `repos`, a link opens its page, where a snapshot is pushed from.
The address names the page, then the machine, the snapshot and the file, as in `#store?machine=DESKTOP-9AMBHO5`, so the back button of the browser works as on a repository.
The 300 last snapshots of a machine are listed, and a button at their end shows 300 older ones.

The store is read from its last commit, and the page changes nothing: a snapshot is taken in a terminal, with `chade snapshot`.

### The report

Report shows what `chade report` measures, a card for each section.
A size is drawn as a bar against the largest of its card, when the card has more than one.
A card with something to clean is marked, and gives the command or the setting, and a link to the step of [docs/cleanup.md](docs/cleanup.md), opened in the documentation of the interface.
The report measures the machine the server runs on, which takes a few seconds, and the page can be left meanwhile.
Its address is `#report`.
Nothing of it is saved, and the page cleans nothing: `chade clean` does, in a terminal.

### The documentation

Docs shows this guide, [docs/cleanup.md](docs/cleanup.md) and [CONTRIBUTING.md](CONTRIBUTING.md), with the pages on one side and the headings of the page shown on the other.
The pages are bundled with the interface, so they are those of the version installed, and read without a network.
A link from a page to another opens it in the interface, and the address names the page and the heading, as in `#docs?name=cleanup&at=caches`.
An image is not shown, as the interface loads nothing from another site.

### Access

- The server listens on `127.0.0.1` only, so no other machine reaches it.
- Every start of the server makes a new token, and the data is served to that token alone.
- The token is kept in `daemon.json`, a file of the user alone, for the next `chade ui` to sign in.
- `chade ui` prints the address that signs in, with the token after the `#`, a part a browser sends to no server.
  The page keeps the token for the tab, and takes it out of the address bar and of the history.
- A request named after another host, or sent by another site, is refused, so a web page open in the same browser can neither read the interface nor act through it.
- An action is a JSON request with the token, which a form of another site cannot send.
- An action names a repository among those under `repos`, a branch among those git lists, and a file among the changes git lists, so it reaches nothing else of the machine.
- A read of the store names a machine among its folders, a snapshot among the commits of that machine, and a file among those of that snapshot, so it reaches nothing else of the repository holding the store.
- IstarCI is asked on `127.0.0.1` alone, whatever address it listens on, and its token stays in the server of chade, never sent to the page.
- A page opened without the token, or after a restart of the server, says so, and the next `chade ui` signs in again.

## Commands

Command                     | Effect
----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
`chade init --store <path>` | Writes the configuration, creates the store folder, and a git repository when the folder is in none, `--force` overwrites an existing configuration
`chade discover`            | Prints the known configuration files present on the system and missing from the configuration, and the Debian configuration files changed since their installation
`chade snapshot`            | Collects, redacts, writes and commits, `--dry-run` lists only, `--push` pushes the repository of the store after the commit, `--no-secret-scan` skips gitleaks
`chade clean`               | Runs the `cleanup` steps of the configuration after a confirmation, `--dry-run` shows them only, `--yes` skips the confirmation
`chade report`              | Measures disk and memory and suggests what to clean, without changing anything, `--json` prints JSON
`chade ui`                  | Opens the web interface over the repositories, the store and the report, starting its server in the background when it is not running, `--no-open` only prints the address, `--port <number>` chooses the port of a server it starts
`chade daemon <action>`     | `start`, `stop`, `status` or `run` the server of the web interface
`chade diff [rev]`          | Compares the last snapshot with the previous one, or with `rev`, `--since <date>` with the last one before that date, `--stat` lists the files, `--machine <name>` reads another machine folder

`--config <path>` applies to every command.

## Roadmap

- Web interface, links: run status of [IstarCI](https://github.com/devpro/istarci), then build status and repositories of GitHub and GitLab
- Restore scripts generated from a snapshot, `winget import` and `code --install-extension` for instance

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development setup, the tests and the pipelines.
