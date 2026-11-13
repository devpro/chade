# System clean-up

`chade report` measures what takes disk and memory, and changes nothing.
Each finding of the report links to one of the steps below.
`chade clean` runs those that work from inside Linux, listed under `cleanup` in the configuration, and the others are run by hand.

On WSL, Linux lives in a virtual disk image on C:, which grows with what Linux writes and never shrinks on its own,
and in a virtual machine that takes memory from Windows.
The steps keep both within limits set once.

## Report

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

Each finding comes with the command or setting that fixes it, and a link to its step below.
`--json` prints the report as JSON.

## Clean

```bash
chade clean
```

The clean-up runs the steps listed under `cleanup` in the [configuration](configuration.md), and only those.
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

The compaction of the WSL disk image runs on Windows with WSL shut down, so it stays a manual step, [disk image compaction](#disk-image-compaction).

## WSL memory

WSL takes up to half of the RAM of Windows by default, and keeps the memory Linux uses as cache.
`%USERPROFILE%\.wslconfig` sets a limit, and gives the cache back to Windows:

```ini
[wsl2]
memory=42GB
swap=12GB

[experimental]
autoMemoryReclaim=gradual
```

The values fit a host of 64 GB, and apply after a `wsl --shutdown` from Windows.

## Running services

A Kubernetes cluster, a VM or a language server keeps its memory as long as it runs, and a development machine starts them for a while and forgets them.

```bash
sudo microk8s stop
```

`sudo microk8s start` brings MicroK8s back when needed.

## Docker build cache cap

Docker 29 collects nothing below 750 GiB of build cache, so the cap is set in `/etc/docker/daemon.json`:

```json
{"builder": {"gc": {"enabled": true, "defaultMaxUsedSpace": "30GB"}}}
```

```bash
sudo systemctl restart docker
```

A restart of Docker stops the running containers.

## Weekly prune and trim

Ubuntu's `fstrim.timer` is never scheduled under WSL, so the space Linux frees stays taken in the disk image.
One weekly timer removes the unused Docker data and trims the disk:

```bash
sudo tee /etc/systemd/system/docker-prune.service >/dev/null <<'EOF'
[Unit]
Description=Remove unused Docker images and volumes, and trim the disk
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker image prune -a --filter until=168h -f
ExecStart=/usr/bin/docker volume prune -f
ExecStart=/sbin/fstrim -av
EOF

sudo tee /etc/systemd/system/docker-prune.timer >/dev/null <<'EOF'
[Unit]
Description=Weekly Docker prune and disk trim

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now docker-prune.timer
systemctl list-timers docker-prune.timer
```

`Persistent=true` runs a week missed while WSL was shut down at its next start.
`docker image prune -a --filter until=168h` removes the images no container uses and older than a week.
`docker volume prune -f` removes anonymous volumes only, so named volumes stay.

A first run frees what is already there:

```bash
sudo systemctl start docker-prune.service
docker system df
```

## Disk image compaction

The trim marks blocks as free, and the image file on C: only shrinks once compacted.
The report gives the path of the image, under the `LocalState` folder of the distribution.

From an administrator prompt on Windows:

```bat
wsl --shutdown
diskpart
```

Then:

```text
select vdisk file="<path of ext4.vhdx>"
attach vdisk readonly
compact vdisk
detach vdisk
exit
```

## Disk image ceiling

The virtual disk may grow to 1 TB, more than C: itself, so a full disk would fill C: before failing inside Linux.
Shrinking the maximum size with `--resize` is not verified on every WSL version, so a backup on another drive comes first, from a Windows prompt:

```bat
wsl --shutdown
wsl --export Ubuntu D:\backup\ubuntu.tar
wsl --manage Ubuntu --resize 400GB
```

A refused resize leaves the disk as it was, and the backup restores with `wsl --import`.

## Journal

```bash
sudo journalctl --vacuum-size=500M
```

The last 500 MB of system logs stay.

## Snap revisions

Snap keeps the previous revision of each snap for a rollback, listed as `disabled` by `snap list --all`.
The report gives the command for each one, such as:

```bash
sudo snap remove cups --revision=1266
sudo snap set system refresh.retain=2
```

`refresh.retain=2` keeps one previous revision instead of two.

## Caches

Each cache is rebuilt by its tool on the next install or build, at the cost of a download.

Cache                    | Clear
-------------------------|--------------------------------------------------------------------------
`~/.npm`                 | `npm cache clean --force`
`~/.nuget/packages`      | `dotnet nuget locals all --clear`
`~/.local/share/pnpm`    | `pnpm store prune`, which keeps the packages a project still references
`~/.cache/JetBrains`     | `rm -rf ~/.cache/JetBrains`, IDE backends and indexes rebuilt on demand
`~/.cache/ms-playwright` | `npx playwright uninstall --all`, then the browsers each project installs
`~/.vscode-server`       | Old versions under `~/.vscode-server/bin`, unused extensions from VS Code

On Windows, the same tools keep their caches under the profile, `%LOCALAPPDATA%` being `~/AppData/Local`, and are cleared with the same commands.

Cache                           | Clear
--------------------------------|--------------------------------------------------------------------------
`~/AppData/Local/npm-cache`     | `npm cache clean --force`
`~/.nuget/packages`             | `dotnet nuget locals all --clear`
`~/AppData/Local/pnpm/store`    | `pnpm store prune`, which keeps the packages a project still references
`~/AppData/Local/ms-playwright` | `npx playwright uninstall --all`, then the browsers each project installs

## Agent sessions

Claude Code keeps the transcript of each session in `~/.claude/projects`, for 30 days by default.
`cleanupPeriodDays` in `~/.claude/settings.json` sets how long:

```json
{"cleanupPeriodDays": 14}
```

## Check

```bash
chade report
```
