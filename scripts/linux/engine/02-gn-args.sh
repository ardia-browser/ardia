#!/usr/bin/env bash
# Step 2 (Linux): writes out/Release_GN_linux_$LINUX_CPU/args.gn (default x64) from scripts/linux/engine/gn_defines.sh
# (the Mac list with the Linux changes and helium-linux's flags.linux.gn) and runs `gn gen`. Run it after step 4, and
# again whenever either list changes. It never cleans the out dir.
# Usage: scripts/linux/engine/02-gn-args.sh --apply | --help (takes the Linux chromium lock itself)
set -euo pipefail
source "$(dirname "$0")/env.sh"
source "$AC_LINUX_BUILD_DIR/step-guard.sh" "$@"
source "$AC_LINUX_BUILD_DIR/gn_defines.sh"
src="$CB/chromium_git/chromium/src"
out_dir="$src/out/$GN_OUT_CONFIGS"
mkdir -p "$out_dir"
for path in "$out_dir" "$out_dir/args.gn"; do
  if [[ -L "$path" ]] || { [[ -f "$path" ]] && [[ "$(stat -c %h "$path")" -gt 1 ]]; }; then
    echo "02-gn-args.sh: $path is a link: refusing to write through it" >&2
    exit 64
  fi
done
args_tmp=$(mktemp "$out_dir/.args.gn.XXXXXX")
printf '%s\n' "${_gn_args[@]}" | sort >"$args_tmp"
chmod 644 "$args_tmp"
mv -f "$args_tmp" "$out_dir/args.gn"
cd "$src"
gn gen "out/$GN_OUT_CONFIGS"
