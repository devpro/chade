#!/usr/bin/env bash
# Runs the built chade with the Node.js of Windows, from WSL, so a change is tested on native Windows without leaving Linux.
# Windows cannot start a program from a folder of the distribution, so the CLI and its dependencies are copied under %TEMP% first.
# The configuration and the store stay in that copy, so successive calls share them, and --remove deletes it all.
# --check runs what the Windows job of CI runs, in a copy of the working tree with dependencies installed by the npm of Windows,
# since node_modules holds binaries of Linux.
#
# Usage: scripts/run_on_windows.sh <chade args...>
#        scripts/run_on_windows.sh --check
#        scripts/run_on_windows.sh --remove
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
# cmd.exe refuses a Linux working directory, and falls back to C:\Windows with a warning on every call.
cd /mnt/c
win_dir="$(cmd.exe /d /c echo %TEMP% | tr -d '\r')\\chade-wintest"
dir=$(wslpath -u "$win_dir")

if [[ "${1:-}" == "--remove" ]]; then
  cmd.exe /d /c "rmdir /s /q $win_dir" || true
  cmd.exe /d /c "rmdir /s /q ${win_dir}-repo" || true
  exit 0
fi

if [[ "${1:-}" == "--check" ]]; then
  repo=$(wslpath -u "${win_dir}-repo")
  mkdir -p "$repo"
  # Tracked and new files, the ones a checkout would hold, over what an earlier check installed.
  git -C "$root" ls-files -co --exclude-standard | tar -C "$root" -cf - -T - | tar -C "$repo" -xf -
  # npm runs the scripts with cmd.exe on Windows, and they are bash scripts, as in CI.
  cmd.exe /d /c "cd /d ${win_dir}-repo && set npm_config_script_shell=C:\Program Files\Git\bin\bash.exe&& npm ci --no-audit --no-fund && npm run typecheck && npm run build && npm run test:unit && npm run test:pkg"
  exit
fi

[[ -f "$root/packages/cli/dist/bin.js" ]] || { echo "run_on_windows: packages/cli/dist is missing, task build builds it" >&2; exit 1; }
mkdir -p "$dir/node_modules"
cp -r "$root/packages/cli/bin" "$root/packages/cli/dist" "$root/packages/cli/package.json" "$dir/"
# The workspace links its dependencies, and Windows cannot follow a link of the distribution.
cp -rL "$root/node_modules/commander" "$root/node_modules/yaml" "$dir/node_modules/"

# The WSL interop escapes quotes in a way cmd.exe does not read, so the line has none, %TEMP% holding no space.
cmd.exe /d /c "cd /d $win_dir && set CHADE_CONFIG=$win_dir\\cfg\\config.yml&& node bin\\chade.js $*"
