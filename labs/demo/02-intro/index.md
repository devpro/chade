# chade

Keep track of a machine and its git repositories.

- Commits the configuration of the system into a git repository.
- Lists every git repository of the machine, with its state and the common git actions.
- Measures what takes disk and memory, and how to clean it.

---

## Why

- A new laptop, or a reinstalled one: what was configured on the old one, and which packages were there?
- Dozens of repositories: which one has work not committed, not pushed, or behind its remote?
- A disk that fills up, on WSL a virtual disk that never shrinks: what takes the room?

> One command line tool and one local web page answer all three.

---

## How it works

![chade reads the configuration files, the inventories and the git repositories of a machine, commits a snapshot into the store, and shows everything in a local web page](../assets/chade-overview-dark.svg#gh-dark-mode-only)
![chade reads the configuration files, the inventories and the git repositories of a machine, commits a snapshot into the store, and shows everything in a local web page](../assets/chade-overview.svg#gh-light-mode-only)

---

## Commands

Command          | Effect
-----------------|----------------------------------------------------------------
`chade init`     | Writes the configuration and creates the store
`chade discover` | Lists the configuration files present on the system
`chade snapshot` | Collects, masks the secrets, scans, and commits
`chade diff`     | Compares the last snapshot with the previous one
`chade ui`       | Opens the web interface
`chade report`   | Measures disk and memory, and suggests what to clean

---

## Safe by design

- chade never changes the system, and changes a git repository only when asked in the web interface.
- Secrets are masked before writing, and gitleaks scans the snapshot before the commit.
- The web interface listens on `127.0.0.1` only, behind a token made at each start.
- The store is a git repository chosen by the user, kept private.

---

## This demo

A fresh Debian laptop, with two repositories cloned from GitHub and one of its own:

1. The first snapshot.
2. A change on the machine, and its diff.
3. The web interface: the repositories, a branch and a commit, the store.
4. The report.
