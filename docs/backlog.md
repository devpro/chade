# Backlog

What is left to do, in the order agreed.

## GitHub and GitLab

- Show the build status of each commit and branch from GitHub and GitLab, as the IstarCI marks are shown.
- List the repositories of the account that are not cloned on the machine.
- Read them through `gh` and `glab` when they are mature enough, through their REST APIs otherwise.
- chade stores no credential: it uses the sign-in of `gh` and `glab`, or of the credential helper of git.

## IstarCI

- chade started from Windows reads no IstarCI running in WSL, its configuration being in the home of WSL.
  It could be read through `\\wsl.localhost\<distro>\home\<user>\.istarci\config.yml`, once the distribution to read is chosen.

## Web interface

- The graph draws at most 12 lanes.
- A file in conflict is listed without a comparison.
- Nothing discards changes, deletes a branch, merges or rebases, on purpose, until decided otherwise.
- A snapshot is taken in a terminal, not from the Store page.
