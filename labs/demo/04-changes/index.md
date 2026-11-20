# Changes

A machine changes every day: a package installed, a setting tried.
Each snapshot records the state of the machine, so git tells what changed and when.

## Change the machine

1. Install a global npm package, and change a git setting:

   <!-- verify: requires=network timeout=120 -->

   ```bash exec
   npm install --global "cowsay@${COWSAY_VERSION}" --no-fund --no-update-notifier && \
   git config --global pull.rebase false
   ```

2. Take a new snapshot:

   <!-- verify: timeout=120 expect="Committed" -->

   ```bash exec
   chade snapshot
   ```

## Compare

1. List the files the snapshot changed:

   <!-- verify: expect="3 files changed" -->

   ```bash exec
   chade diff --stat
   ```

2. Show the changes, the new package in the inventory of npm, the new setting in `.gitconfig` and in the inventory of git:

   <!-- verify: expect="+cowsay@" -->

   ```bash exec
   chade diff
   ```

   > [!TIP]
   > `chade diff --since 2026-01-01` compares with the last snapshot before a date, and `--machine <name>` reads the folder of another machine of the same store.
