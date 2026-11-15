#!/usr/bin/env bash
# The host tools a Linux build runs that neither the sysroot nor the checkout carries, unpacked from Ubuntu's own
# packages into $HOST_TOOLS_DIR (no root needed: apt-get download, then dpkg-deb -x); env.sh puts its usr/bin on PATH.
# Today: gperf (Blink's generated hash tables; scripts.gni runs "gperf" from PATH on a Linux host) and rsync
# (engine/chromium/apply.sh copies chrome/browser/ardia with it). Their shared libraries come from the system.
# Usage: scripts/linux/engine/host-tools.sh --apply | --help
set -euo pipefail
source "$(dirname "$0")/env.sh"
case "${1:-}" in
  -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
  --apply) ;;
  *) echo "host-tools.sh: pass --apply (--help for usage)" >&2; exit 64 ;;
esac
packages=(gperf rsync)
mkdir -p "$HOST_TOOLS_DIR/debs"
cd "$HOST_TOOLS_DIR/debs"
for package in "${packages[@]}"; do
  if ! compgen -G "${package}_*.deb" >/dev/null; then
    apt-get download "$package" < /dev/null
  fi
  dpkg-deb -x "$(compgen -G "${package}_*.deb" | head -1)" "$HOST_TOOLS_DIR"
done
gperf --version | head -1
rsync --version | head -1
