#!/usr/bin/env bash
# Packs the tarball, installs it into an empty project, and runs the binary the way someone who typed `npm install -g chade` would.
#
# The unit tests import ../src directly and never go near the packaged layout,
# so a missing `bin` entry, a file left out of `files`, a bin that is not executable or a dependency the bundle expects but the manifest omits
# all pass them and fail on the first real install.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tarball=$(cd "$here" && npm pack --pack-destination "$tmp" --silent)
cd "$tmp"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "$tmp/$tarball" >/dev/null 2>&1

fail() { echo "smoke: $1" >&2; exit 1; }

# Git Bash on Windows, where chade reads and writes Windows paths, and runs commands through cmd.exe.
windows=false
case $OSTYPE in msys* | cygwin*) windows=true ;; esac
native() { if $windows; then cygpath -w "$1"; else echo "$1"; fi; }

chade=./node_modules/.bin/chade
# npm links this from the package's `bin`, so its absence means the manifest, not the code, is wrong.
[ -x "$chade" ] || fail 'node_modules/.bin/chade was not created or is not executable'

# Runs through the shim, which is what exercises the shebang.
version=$("$chade" --version) || fail 'chade --version failed'
# Read from its own folder, as the Node.js of Windows reads no path of Git Bash.
[ "$version" = "$(cd "$here" && node -p "require('./package.json').version")" ] || fail "reported version $version does not match package.json"

# A home of its own, so neither the configuration nor the git identity of the machine running it takes part.
export HOME="$tmp/home" CHADE_CONFIG; CHADE_CONFIG=$(native "$tmp/home/.chade/config.yml")
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.test GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.test
mkdir -p "$HOME"
if $windows; then export USERPROFILE; USERPROFILE=$(native "$HOME"); fi

out=$("$chade" snapshot 2>&1 || true)
case $out in
  *'chade init creates it'*) ;;
  *'Cannot find module'*|*'ERR_MODULE_NOT_FOUND'*) fail "the bundle is incomplete: $out" ;;
  *) fail "snapshot without a configuration should point to init, got: $out" ;;
esac

"$chade" init --store "$(native "$tmp/store")" >/dev/null || fail 'chade init failed'
[ -d "$tmp/store/.git" ] || fail 'chade init did not create the store as a git repository'
grep -q '^store: ' "$CHADE_CONFIG" || fail 'chade init did not write the store in the configuration'

# A single section, with a fixed machine name, so a run on WSL never reaches the Windows host.
printf 'secret: hunter2\n' > "$HOME/.app.conf"
if $windows; then
  section="windows:
  files: ['%USERPROFILE%\\.app.conf']
  inventories: [{ name: kernel, command: ver }]"
  kernel='Microsoft Windows'
else
  section="linux:
  files: [~/.app.conf]
  inventories: [{ name: kernel, command: uname -s }]"
  kernel='Linux'
fi
cat > "$CHADE_CONFIG" <<CONFIG
store: '$(native "$tmp/store")'
machine: smoke
$section
cleanup:
  - name: hello
    command: echo cleaned by the smoke test
CONFIG

"$chade" snapshot --no-secret-scan >/dev/null || fail 'chade snapshot failed'
# The folder is linux, wsl-<distribution> on WSL, or windows, where a file lands under its drive letter.
system=$(ls "$tmp/store/smoke")
if $windows; then path=$(cygpath -m "$HOME/.app.conf"); path=/${path/:/}; else path="$HOME/.app.conf"; fi
stored="$tmp/store/smoke/$system/files$path"
[ "$(cat "$stored")" = 'secret: ***' ] || fail "the snapshot of .app.conf is not redacted: $(cat "$stored")"
grep -q "$kernel" "$tmp/store/smoke/$system/inventories/kernel.txt" || fail 'the custom inventory was not written'
[ "$(git -C "$tmp/store" rev-list --count HEAD)" = 1 ] || fail 'the snapshot was not committed'

"$chade" snapshot --no-secret-scan | grep -q 'No change' || fail 'a second snapshot of an unchanged system should commit nothing'
"$chade" diff --stat | grep -q 'kernel.txt' || fail 'chade diff does not show the first snapshot'

# A custom step only, which removes nothing, and --yes, since stdin is no terminal here.
"$chade" clean --dry-run | grep -q 'echo cleaned by the smoke test' || fail 'chade clean --dry-run does not show the custom step'
"$chade" clean --yes | tr -d '\r' | grep -q '^cleaned by the smoke test$' || fail 'chade clean --yes did not run the custom step'

# The report reads the machine as it is, the Windows host included on WSL, and changes nothing.
"$chade" report --json | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!r.sections.some((s) => s.title === "Memory")) process.exit(1)' \
  || fail 'chade report --json does not give a report with a Memory section'

echo "smoke: $tarball installs, links chade, initializes a store, snapshots, redacts, diffs, cleans and reports (v$version)"
