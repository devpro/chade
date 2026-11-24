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

## Platform detection

- A container on a WSL 2 kernel is taken for WSL, since `/proc/sys/kernel/osrelease` names `microsoft` there too, a dev container of VS Code on Windows for instance.
  chade then names its system `wsl-linux`, asks Windows for the computer name, and the report measures `C:` and `.wslconfig`.
  WSL also has `/proc/sys/fs/binfmt_misc/WSLInterop`, which a container does not, so requiring it as well tells them apart.

## Packages and images

- The pnpm store keeps its packages by content, not by name, so `chade scan` does not read it.
- A Node.js of nvm for Windows is never called unused, as the one in use is a link whose target is not read yet.
- A Docker of Windows with an engine of its own, not shared with WSL, is not read from WSL.
- The images of podman, which trivy reads with `--image-src podman`, grype as `podman:<image>`, and `podman images --format json` lists.
- A faster scan of the images, which must still match each image against the newest CVEs every day.
  The list of the packages of an image does not change while its ID is the same, so it can be kept, and only the list matched each day.
  Each scanner must give the same findings from the list as from the image, the notes on the end of life of its system included.
  osv-scanner takes most of the time, up to 3 minutes for one image, and can update its databases once for each scan instead of once for each image.
  Two or three images can be read at the same time, with a limit on the memory, as osv-scanner can use 2 GB for one image.
- More scanners as layers, each one optional: Docker Scout for images, and a reader of jars without Maven.

## Inventory

- More dependencies: Helm charts, GitHub Actions, GitLab CI, Azure Pipelines, Go, Python and Java.
- The modules of Terraform, and the providers without a lock file.
- The images of the Kubernetes manifests and of the Helm values.
- The arguments of a Dockerfile with a default value, and the properties of MSBuild.
- Private registries, with the sign-in that their tool has.
- The tools of dotnet, pipx, uv, snap and Homebrew.
- The versions of the technologies, with the end of their support.
- A proxy for the requests that chade makes itself.

## Restore

- Restore scripts generated from a snapshot, `winget import` and `code --install-extension` for instance.

## Web interface

- The graph draws at most 12 lanes.
- A file in conflict is listed without a comparison.
- Nothing discards changes, deletes a branch, merges or rebases, on purpose, until decided otherwise.
- A snapshot is taken in a terminal, not from the Store page.
