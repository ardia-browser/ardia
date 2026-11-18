export CB="${AC_CHROMIUM_BUILD:-$HOME/chromium-build}"
_ac_repo="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../.." && pwd)"
[[ -f "$_ac_repo/engine/patches/series" ]] || _ac_repo="$HOME/Documents/ardia"
export AC_REPO="${AC_REPO:-$_ac_repo}"
unset _ac_repo
export DEPOT_TOOLS_UPDATE=0
export PATH="$CB/depot_tools:$PATH"
export CHROMIUM_VERSION=157.0.8103.50
export HELIUM_TAG=0.21.2
export HELIUM_MACOS_TAG=0.21.2.1
export HELIUM_DIR="$CB/helium"
export HELIUM_MACOS_DIR="$CB/helium-macos"
export HELIUM_LINUX_TAG=0.21.2.1
export HELIUM_LINUX_DIR="$CB/helium-linux"
if [[ -n "${ARDIA_ARCH:-}" && "$(uname -s)" == Darwin ]]; then
  case "$ARDIA_ARCH" in
    arm64) export AC_TARGET_CPU=arm64 ;;
    x86_64) export AC_TARGET_CPU=x64 ;;
    *) echo "env.sh: ARDIA_ARCH is arm64 or x86_64, got '$ARDIA_ARCH'" >&2; return 64 2>/dev/null || exit 64 ;;
  esac
fi
_ac_target_config=$(python3 "$(dirname "${BASH_SOURCE[0]:-$0}")/target_config.py" --shell) || return $?
eval "$_ac_target_config"
unset _ac_target_config
if [[ "$AC_TARGET_OS" == linux ]]; then
  export CHROMIUM_SRC="${CHROMIUM_SRC:-$CB/chromium_git/chromium/src}"
fi
if [[ "$AC_TARGET_OS" == mac && "$AC_TARGET_CPU" == arm64 ]]; then
  export AC_SERIES_BASE="${AC_SERIES_BASE:-$CB/series-base}"
else
  export AC_SERIES_BASE="${AC_SERIES_BASE:-$CB/series-base-$AC_TARGET_OS-$AC_TARGET_CPU}"
fi
lowprio() {
  if [[ "$(uname -s)" == Darwin ]]; then taskpolicy -b nice -n 19 "$@"; else nice -n 19 "$@"; fi
}
lowprio_net() {
  if [[ "$(uname -s)" == Darwin ]]; then taskpolicy -c utility -d throttle nice -n 19 "$@"; else nice -n 19 "$@"; fi
}
export DEPOT_TOOLS_METRICS=0
