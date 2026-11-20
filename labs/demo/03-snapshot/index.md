# First snapshot

## A laptop with projects

1. Clone two repositories from GitHub, and start one of our own, with no remote:

   <!-- verify: requires=network timeout=120 expect="3 repositories" -->

   ```bash exec
   mkdir -p ~/repos && cd ~/repos && \
   git clone -q https://github.com/octocat/Hello-World.git && \
   git clone -q https://github.com/octocat/Spoon-Knife.git && \
   git init -q notes && cd notes && \
   echo "# Notes" > README.md && git add README.md && git commit -qm "Start the notes" && \
   echo "$(ls ~/repos | wc -l) repositories in ~/repos"
   ```

## Configuration

1. Create the store, a git repository, and the configuration file:

   <!-- verify: expect="Wrote " -->

   ```bash exec
   chade init --store ~/system-snapshots
   ```

2. List the configuration files present on the system:

   <!-- verify: expect=".gitconfig" -->

   ```bash exec
   chade discover
   ```

3. Keep the files of the user, three inventories, and the folder of the repositories:

   ```bash exec
   cat > ~/.chade/config.yml <<'EOF'
   store: ~/system-snapshots
   linux:
     files:
       - ~/.bashrc
       - ~/.gitconfig
       - ~/.npmrc
     inventories: [apt-manual, npm-global, git-config]
     repos:
       - ~/repos
   cleanup:
     - npm-cache
   EOF
   cat ~/.chade/config.yml
   ```

   > [!TIP]
   > The whole configuration is in `docs/configuration.md`, and in the Docs page of the web interface.

## Snapshot

1. Take the first snapshot:

   <!-- verify: timeout=120 expect="Committed" -->

   ```bash exec
   chade snapshot
   ```

2. See what the commit holds, one folder for the machine and one for its system:

   <!-- verify: expect="laptop/linux/" -->

   ```bash exec
   git -C ~/system-snapshots show --stat --format="%s%n"
   ```

3. Look for the npm token in the store:

   <!-- verify: expect="_authToken=xxx" -->

   ```bash exec
   grep -r "_authToken" ~/system-snapshots/laptop
   ```

   > [!IMPORTANT]
   > The token is masked before it is written, and gitleaks scans the snapshot before it is committed.
   > The store can be pushed to a private remote with `chade snapshot --push`, and it never holds a credential.
