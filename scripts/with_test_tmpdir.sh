#!/usr/bin/env bash
# Runs a test command with TMPDIR pointed at a directory of its own, removed when the command ends, whatever its result.
# The tests make their stores and fixtures with mkdtemp under os.tmpdir() and leave them,
# so one directory per run also covers a test written later and a run killed half-way.
#
# Usage: scripts/with_test_tmpdir.sh <command> [args...]
set -uo pipefail

dir=$(mktemp -d "${TMPDIR:-/tmp}/chade-test-run-XXXXXX") || exit 1
trap 'rm -rf "$dir"' EXIT
TMPDIR="$dir" "$@"
