export AC_CHROMIUM_BUILD="${AC_CHROMIUM_BUILD:-$HOME/chromium-build-linux}"
export AC_LINUX_BUILD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export AC_REPO="${AC_REPO:-$(cd "$AC_LINUX_BUILD_DIR/../../.." && pwd)}"
export AC_MAC_BUILD_DIR="$AC_REPO/engine/patches/build"
source "$AC_MAC_BUILD_DIR/env.sh"
export LINUX_CPU="${LINUX_CPU:-x64}"
export GN_OUT_CONFIGS="Release_GN_linux_$LINUX_CPU"
export HELIUM_LINUX_TAG=0.21.2.1
export HELIUM_LINUX_DIR="$CB/helium-linux"
export HOST_TOOLS_DIR="$CB/host-tools"
export PATH="$HOST_TOOLS_DIR/usr/bin:$PATH"
export AC_LINUX_LOCK="${AC_LOCK_ROOT:-/tmp}/ac-chromium-linux.lockf"
unset -f lowprio lowprio_net
lowprio() { nice -n 19 "$@"; }
lowprio_net() { nice -n 19 "$@"; }
