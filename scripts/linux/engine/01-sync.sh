#!/usr/bin/env bash
# Step 1 (Linux): check out Chromium $CHROMIUM_VERSION (env.sh) for a Linux target into
# $AC_CHROMIUM_BUILD (default ~/chromium-build-linux), without history, and run its hooks (clang, Rust, the Debian
# sysroot the build links against, node, the PGO profiles); no build. Also clones depot_tools, helium-chromium and
# helium-linux at the commits helium-pins.ini names, and the host tools the build runs outside the sysroot
# (host-tools.sh). Then steps 3, 4, 2, 5.
# Usage: scripts/linux/engine/01-sync.sh --apply | --help (takes the Linux chromium lock itself)
set -euo pipefail
source "$(dirname "$0")/env.sh"
source "$AC_LINUX_BUILD_DIR/step-guard.sh" "$@"
if [[ ! -x "$CB/depot_tools/gclient" ]]; then
  git clone --depth=1 https://chromium.googlesource.com/chromium/tools/depot_tools.git "$CB/depot_tools"
fi
[[ -f "$CB/depot_tools/python3_bin_reldir.txt" ]] || "$CB/depot_tools/ensure_bootstrap" < /dev/null
python3 "$AC_LINUX_BUILD_DIR/pins.py" checkout "$CB"
"$AC_LINUX_BUILD_DIR/host-tools.sh" --apply
rm -rf "$CB/series-base"
mkdir -p "$CB/chromium_git/chromium"
cd "$CB/chromium_git/chromium"
cat > .gclient <<GCLIENT
solutions = [{'managed': False, 'name': 'src',
  'url': 'https://chromium.googlesource.com/chromium/src.git@refs/tags/$CHROMIUM_VERSION',
  'custom_vars': {'checkout_pgo_profiles': True, 'source_tarball': False, 'siso_version': 'latest'},
  'custom_deps': {}, 'deps_file': 'DEPS', 'safesync_url': ''}]
target_os = ['linux']
target_os_only = True
GCLIENT
if [ -d src/.git ]; then
  timeout 3600 git -C src fetch --depth=1 --no-tags origin "refs/tags/$CHROMIUM_VERSION:refs/tags/$CHROMIUM_VERSION"
  git -C src -c advice.detachedHead=false checkout -q -f "refs/tags/$CHROMIUM_VERSION"
fi
timeout 7200 gclient sync --no-history --nohooks --reset --force -D -j 16 < /dev/null
gclient runhooks < /dev/null
