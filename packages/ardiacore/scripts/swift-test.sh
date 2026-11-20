#!/bin/bash
# Usage: scripts/swift-test.sh <name> <swiftc flags and sources...> [-- <Swift Testing options>]
# Builds the sources with Swift Testing into ${TMPDIR:-/tmp}/ardiacore-<name>-test and runs it.
# Runs with --quiet unless options follow --, for example: -- --filter "Vault store" --verbose
set -euo pipefail
usage() { sed -n '2,4s/^# //p' "$0"; }
if [[ $# -ge 1 && ( $1 == --help || $1 == -h ) ]]; then
  usage
  exit 0
fi
if [[ $# -lt 2 ]]; then
  usage >&2
  exit 2
fi
name=$1
shift
compile=()
while [[ $# -gt 0 && $1 != -- ]]; do
  compile+=("$1")
  shift
done
[[ $# -gt 0 ]] && shift
runner=("$@")
[[ ${#runner[@]} -eq 0 ]] && runner=(--quiet)
here=$(cd "$(dirname "$0")/.." && pwd)
developer=$(xcode-select -p)
frameworks=$developer/Platforms/MacOSX.platform/Developer/Library/Frameworks
libraries=$developer/Platforms/MacOSX.platform/Developer/usr/lib
plugins=$developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host/plugins/testing
binary=${TMPDIR:-/tmp}/ardiacore-$name-test
xcrun swiftc -parse-as-library -F "$frameworks" -plugin-path "$plugins" \
  -Xlinker -rpath -Xlinker "$frameworks" -Xlinker -rpath -Xlinker "$libraries" \
  "${compile[@]}" "$here/tests/support/TestingRunner.swift" -o "$binary"
exec "$binary" "${runner[@]}"
