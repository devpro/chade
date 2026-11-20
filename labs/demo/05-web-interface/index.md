# Web interface

## Open it

1. Start the server in the background, and open the address it prints:

   <!-- verify: interactive action=ui.sign-in capture="#token=([A-Za-z0-9_-]+)" -->

   ```bash exec
   chade ui --no-open
   ```

   > [!NOTE]
   > On a desktop, `chade ui` opens the browser itself, the one of Windows on WSL.
   > The token after `#` signs the browser in, and changes at each start of the server.

## Repositories

1. [The **Repositories** page](:action:ui.repositories) lists the repositories under `~/repos`: the branch, the commits ahead and behind the remote, the files changed, the last commit.
   The mark of the remote tells GitHub from a repository with no remote.

2. Start some work in `Hello-World`, a change not committed yet:

   <!-- verify: expect="1 file(s) changed" -->

   ```bash exec
   cd ~/repos/Hello-World && \
   echo "Hello from the chade demo" >> README && \
   echo "Hello-World: $(git status --porcelain | wc -l) file(s) changed"
   ```

3. [Refresh the list](:action:ui.refresh): the mark of `Hello-World` turns amber, there is something to commit.

## A repository

1. [Open `Hello-World`](:action:ui.open-hello-world): the branches on the left, the history as a graph, and **Uncommitted changes** on top.

2. From the interface, create a branch, stage the change and commit it, while the terminal waits for the commit:

   <!-- verify: interactive action=ui.commit capture="Hello-World is on (main|master)" timeout=120 expect="hello-from-chade: Say hello from the chade demo, 0 file(s)" -->

   ```bash exec
   cd ~/repos/Hello-World && \
   echo "Hello-World is on $(git branch --show-current), $(git status --porcelain | wc -l) file(s) to commit" && \
   for i in $(seq 1 90); do [ -z "$(git status --porcelain)" ] && break; sleep 1; done; \
   echo "$(git branch --show-current): $(git log -1 --format=%s), $(git status --porcelain | wc -l) file(s) to commit"
   ```

   > [!NOTE]
   > The interface runs git as the user, with a fixed list of actions: fetch, pull, push, branch, check out, stage, commit, amend.
   > No force push, no reset of the working tree: what can lose work is left to the terminal.
   > Nothing is pushed in this demo, the branch stays on the laptop.

## Store

1. [The **Store** page](:action:ui.store) shows the snapshots of the machine, and what each one changed.
   A file of a snapshot opens its changes, the `.gitconfig` of the last one shows `pull.rebase`.
