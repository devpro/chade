# System clean-up

`chade report` measures what takes disk and memory, and changes nothing.
Each finding of the report links to one of the steps below, which are run by hand.

On WSL, Linux lives in a virtual disk image on C:, which grows with what Linux writes and never shrinks on its own,
and in a virtual machine that takes memory from Windows.
The steps keep both within limits set once.

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
