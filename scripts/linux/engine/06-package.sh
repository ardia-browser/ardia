#!/usr/bin/env bash
# Step 6 (Linux): pack out/Release_GN_linux_$LINUX_CPU into $PACKAGE_DIR/ardia-chromium-linux-$LINUX_CPU.tar.xz
# (default ~/ardia-linux/out) and update SHA256SUMS beside it. The file list is the tree's own: the chrome-linux.zip
# archive of infra/archive_config/linux-archive-rel.json, the snapshot Chromium's CI uploads (package_linux.py). The
# files are checked against `gn desc ... //chrome:chrome runtime_deps`; what the tarball lacks is listed in
# $CB/package/$LINUX_CPU/missing-runtime-deps.txt. ELF files go in without their debug info (the out dir keeps it).
# RUN.txt goes in.
# Usage: scripts/linux/engine/06-package.sh --apply | --help (takes the Linux chromium lock itself)
set -euo pipefail
source "$(dirname "$0")/env.sh"
source "$AC_LINUX_BUILD_DIR/step-guard.sh" "$@"
src="$CB/chromium_git/chromium/src"
out="out/$GN_OUT_CONFIGS"
package_dir="${PACKAGE_DIR:-$HOME/ardia-linux/out}"
work="$CB/package/$LINUX_CPU"
[[ -x "$src/$out/chrome" ]] || { echo "06-package.sh: build chrome in $out first" >&2; exit 1; }
mkdir -p "$work" "$package_dir"
cd "$src"
gn desc "$out" //chrome:chrome runtime_deps > "$work/runtime_deps.txt"
python3 "$AC_LINUX_BUILD_DIR/package_linux.py" --src "$src" --out "$out" \
  --config "$src/infra/archive_config/linux-archive-rel.json" --runtime-deps "$work/runtime_deps.txt" --work "$work" \
  --tarball "$package_dir/ardia-chromium-linux-$LINUX_CPU.tar.xz" --cpu "$LINUX_CPU" --chromium "$CHROMIUM_VERSION" \
  --helium "$HELIUM_TAG" --strip "$src/third_party/llvm-build/Release+Asserts/bin/llvm-strip"
cd "$package_dir"
sha256sum ardia-chromium-linux-*.tar.xz > SHA256SUMS
cat SHA256SUMS
