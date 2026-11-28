#!/usr/bin/env bash
# Linux hosts only (a no-op elsewhere): makes the Windows toolchain readable in the Chromium tree at <src> before a
# step runs gn or the compilers. The SDK's includes are written with the case Windows ignores, so the toolchain is
# read through Chromium's ciopfs, a FUSE mount of win_toolchain/vs_files.ciopfs at win_toolchain/vs_files. Step 1's
# win_toolchain hook mounts it, but the mount is lost when the host reboots or when the systemd unit or session that
# started it ends; this mounts it again when it is missing, then raises the open-file limit of every ciopfs serving
# the tree (it inherits 1024 otherwise, and 16 compiles ran out).
# Usage: scripts/windows/engine/toolchain-mount.sh <src> | --help
set -euo pipefail
case "${1:-}" in
  -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
  "") echo "usage: scripts/windows/engine/toolchain-mount.sh <src>" >&2; exit 64 ;;
esac
[[ "$(uname -s)" == Linux ]] || exit 0
src=$(cd "$1" && pwd)
toolchain="$src/third_party/depot_tools/win_toolchain"
if [[ -d "$toolchain/vs_files.ciopfs" ]] && ! mountpoint -q "$toolchain/vs_files"; then
  mkdir -p "$toolchain/vs_files"
  (ulimit -n "$(ulimit -Hn)" && "$src/build/ciopfs" -o use_ino "$toolchain/vs_files.ciopfs" "$toolchain/vs_files") ||
    { echo "toolchain-mount.sh: could not mount the toolchain at $toolchain/vs_files" >&2; exit 1; }
  echo "toolchain-mount.sh: mounted the toolchain's case-insensitive view at $toolchain/vs_files" >&2
fi
for mount in $(pgrep -u "$(id -u)" -f "ciopfs .*$src/third_party/depot_tools/win_toolchain/" || true); do
  prlimit --pid "$mount" --nofile="$(ulimit -Hn)" ||
    echo "toolchain-mount.sh: could not raise the open-file limit of ciopfs $mount" >&2
done
