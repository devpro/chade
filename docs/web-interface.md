# Web interface

```bash
chade ui
```

The interface opens in the browser, the one of Windows on WSL, and the command returns.
Its server runs in the background, on `http://127.0.0.1:7843`: the first `chade ui` starts it, and the next ones find it running.
`--no-open` prints the address without opening it, and `--port <number>` starts the server on another port.

The top of every page names the machine and links to the four pages: Repositories, Store, Report and Docs.

## Server

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

## Repositories

The page the interface opens on.
Each system of the machine is a tab, with the number of its repositories and of those with something to do.
A tab lists the git repositories found under `repos`, a Windows repository being read by the git of Windows, on WSL as well.

Column       | Content
-------------|-----------------------------------------------------------------------------------------------------
Repository   | Name and path
Remote       | Mark of the host of the remote: GitHub, GitLab, Azure DevOps, or git for any other host and a folder
Branch       | Checked out branch, or the commit of a detached HEAD
Upstream     | Commits ahead (↑) and behind (↓) the upstream branch, `no upstream`, or `upstream gone`
Working tree | Files changed, untracked and in conflict
Last commit  | Subject and age
Fetched      | Age of the last fetch or pull, which the ahead and behind counts are as old as

The mark at the start of a row is blue with commits to push, amber with something to commit or pull, and red with a conflict or a repository git cannot read.
The remote shown is the one the branch tracks, or origin, or the only one.
A link next to the path opens the remote on the web, at the branch checked out once pushed, on GitHub, GitLab and Bitbucket.
The filter keeps the repositories whose name, path or branch holds every word typed, and the checkbox keeps those with something to commit, push, pull or fix.

The list reads again every 30 seconds while it is looked at, when its tab comes back to the front, and at Refresh.
It fetches nothing, so a count behind is the one of the last fetch.

## A repository

The name of a repository opens its page, which goes from a branch to a commit, to its files, to the changes of one file.

Part     | Content
---------|------------------------------------------------------------------------------------------------------------------
Branches | Local and remote branches, the one checked out marked, each with what it is ahead and behind its upstream by
History  | Commits of every branch and tag from the newest, drawn as a graph, each with the branches and tags pointing at it
Changes  | Message, author and date of the commit chosen, and the list of the files it changed

- A branch chooses the commit it points at.
- A file of the list opens its changes in place of the history, and Close, Escape or another commit brings the history back.
- A merge shows what it brought to its first parent, the branch it was merged into.
- With changes in the working tree, a first line, Uncommitted changes, lists what is staged, not staged and not tracked.
- The history lists 300 commits, and a button at its end shows 300 older ones.
- The changes of a file stop after 10,000 lines, and a patch of more than 2 MB is cut.
- The bar between the history and the changes is dragged to share the room, and a double click resets it.
- The address names the repository, the commit and the file, so the back button of the browser works.

## Git actions

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

A pull fast forwards when it can, and otherwise merges with a merge commit, whatever `pull.rebase` and `pull.ff` say.
Checking Amend fills an empty message with the one of the commit checked out, and with nothing staged only the message changes.
A notice in a corner of the page says what runs, then what was done or what git answered, and a refusal stays until dismissed.
One action runs at a time in a repository, and the page reads the repository again after each.

git runs as the user, with the SSH agent and the credential helper already set up.
chade holds no credential, and a command that would ask for a password fails instead.

Left to the terminal, on purpose:

- A pull that meets a conflict is aborted, and the branch stays as it was.
- Nothing is forced, discarded or deleted: no force push, no reset of the working tree, no branch deletion.
- A pushed commit is never rewritten, so Amend is off once the last commit is pushed.
- A conflict is resolved in an editor.

## IstarCI

When [IstarCI](https://github.com/devpro/istarci) runs on the machine, the interface shows what it said of the repositories it watches.

- The list has a column IstarCI, with the mark of the last run of each repository, linked to that run.
  The mark is grey when the run is of another commit than the one checked out.
- The history marks each commit IstarCI ran, and the changes of the commit link to its run.

Mark | Meaning
-----|-------------------------------------
✓    | Passed
✕    | Failed
●    | Running
○    | Waiting to run
⊘    | Stopped
◌    | Skipped, or not run, with the reason

chade reads the port and the token of IstarCI from `~/.istarci/config.yml` at each read, and keeps neither.
A browser never signed in to IstarCI asks for its token there, which `istarci ui` gives.
A run of a workflow started by hand is not the run of its commit, and shows no mark.
When IstarCI does not run, does not answer within a second, or does not watch the repository, no mark shows and nothing else changes.
A repository is the same whether named from WSL or from Windows, `/mnt/c/Users/<user>/projects/<name>` being `C:\Users\<user>\projects\<name>`.
IstarCI runs on Linux and WSL alone, so chade on Windows without WSL shows none of it.

## Store

Store opens the store of the configuration, laid out as the page of a repository.

Part      | Content
----------|------------------------------------------------------------------------------------------------------------------
Machines  | Machine folders of the store, each with its systems and the number of its snapshots, the one of the server marked
Snapshots | Commits that changed the folder of the machine chosen, from the newest
Snapshot  | Message, author and date of the snapshot chosen, then its changes or its files, under the system they belong to

- The page opens on the machine the server runs on, and on its last snapshot.
- Changes lists what the snapshot changed since the one before on the same machine, the first snapshot adding every file.
- Files lists every file the machine had at the snapshot, and a file opens its content.
- When the repository of the store is under `repos`, a link opens its page, where a snapshot is pushed from.
- The 300 last snapshots of a machine are listed, and a button at their end shows 300 older ones.

The page changes nothing: a snapshot is taken in a terminal, with `chade snapshot`.

## Report

Report shows what `chade report` measures, a card for each section, a size drawn as a bar against the largest of its card.
A card with something to clean gives the command or the setting, and a link to its step of the [system clean-up](cleanup.md).
It is measured when the page opens and at Refresh, which takes a few seconds, and never by itself.
Nothing of it is saved, and the page cleans nothing: `chade clean` does, in a terminal.

## Docs

Docs shows the [user guide](../README.md), this page, the [configuration](configuration.md), the [system clean-up](cleanup.md) and the [contributor guide](../CONTRIBUTING.md).
The pages are bundled with the interface, so they match the version installed and read without a network.
An image is not shown, as the interface loads nothing from another site.

## Access

- The server listens on `127.0.0.1` only, so no other machine reaches it.
- Every start of the server makes a new token, and the data is served to that token alone.
- The token is kept in `daemon.json`, a file of the user alone, for the next `chade ui` to sign in.
- `chade ui` prints the address that signs in, with the token after the `#`, a part a browser sends to no server.
  The page keeps the token for the tab, and takes it out of the address bar and of the history.
- A request named after another host, or sent by another site, is refused, so another web page can neither read the interface nor act through it.
- An action is a JSON request with the token, which a form of another site cannot send.
- An action names a repository among those under `repos`, a branch among those git lists, and a file among the changes git lists, so it reaches nothing else of the machine.
- A read of the store names a machine among its folders, a snapshot among its commits, and a file among those of that snapshot, so it reaches nothing else.
- IstarCI is asked on `127.0.0.1` alone, and its token stays in the server, never sent to the page.
- A page opened without the token, or after a restart of the server, says so, and the next `chade ui` signs in again.
