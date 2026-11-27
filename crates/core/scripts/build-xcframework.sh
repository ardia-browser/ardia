#!/bin/bash
# Builds ArdiaCoreRS.xcframework, the Rust core for Apple (ardia-apple-ffi's static library: the sync core of ardia-ffi
# and the import parsers of ardia-import-ffi in one archive) for the Mac, the iPhone and the iPhone simulator, with
# ardia_core.h, ardia_import.h and a module map so Swift can `import ArdiaCoreRS`.
#
#   packages/core-rs/scripts/build-xcframework.sh [--force]
#
# Writes packages/sync/ios/Frameworks/ArdiaCoreRS.xcframework (ARDIA_CORE_RS_XCFRAMEWORK overrides it), where the
# ArdiaSync pod (and the ArdiaImport pod through it) and packages/sync/Package.swift pick it up. It hashes its inputs
# (the workspace manifests, the toolchain file, the headers and the sources of every crate the library links) into a
# .inputs file beside it, and does nothing while that hash is unchanged, so pod install and CI can call it every time.
# --force rebuilds anyway. Uses the toolchain in rust-toolchain.toml through rustup and adds the three Apple targets
# when they're missing.
set -euo pipefail
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi
force=0
[ "${1:-}" = "--force" ] && force=1

core="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$core/../.." && pwd)"
out="${ARDIA_CORE_RS_XCFRAMEWORK:-$repo/packages/sync/ios/Frameworks/ArdiaCoreRS.xcframework}"
mkdir -p "$(dirname "$out")"

if [ -z "${ARDIA_CORE_RS_LOCKED:-}" ]; then
  ARDIA_CORE_RS_LOCKED=1 exec /usr/bin/lockf -t "${ARDIA_CORE_RS_WAIT:-1200}" "$out.lock" "$0" "$@"
fi

targets=(aarch64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim)
library=libardia_apple.a

inputs_hash() {
  (
    cd "$core"
    {
      printf '%s\n' "${targets[@]}"
      find Cargo.toml Cargo.lock rust-toolchain.toml .cargo/config.toml include scripts/build-xcframework.sh \
        crates/ardia-crypto crates/ardia-sync-core crates/ardia-ffi crates/ardia-import-core crates/ardia-import-ffi \
        crates/ardia-apple-ffi \
        -type f ! -path '*/tests/*' -print | LC_ALL=C sort | while IFS= read -r file; do
        printf '%s %s\n' "$(shasum -a 256 < "$file" | cut -d' ' -f1)" "$file"
      done
    } | shasum -a 256 | cut -d' ' -f1
  )
}

hash="$(inputs_hash)"
if [ "$force" = 0 ] && [ -d "$out" ] && [ "$(cat "$out.inputs" 2>/dev/null)" = "$hash" ]; then
  echo "ArdiaCoreRS.xcframework is current: $out"
  exit 0
fi

[ -d "$HOME/.cargo/bin" ] && PATH="$HOME/.cargo/bin:$PATH"
command -v rustup >/dev/null || { echo "build-xcframework: rustup isn't installed (https://rustup.rs)" >&2; exit 1; }
unset SDKROOT RUSTC_WRAPPER CARGO_BUILD_TARGET RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
cd "$core"
if ! installing="$(rustup toolchain install --profile minimal --no-self-update 2>&1)"; then
  echo "$installing" >&2
  echo "build-xcframework: rustup couldn't install the toolchain in rust-toolchain.toml" >&2
  exit 1
fi
installed="$(rustup target list --installed)"
missing=()
for target in "${targets[@]}"; do
  grep -qx "$target" <<<"$installed" || missing+=("$target")
done
[ ${#missing[@]} -eq 0 ] || rustup target add "${missing[@]}"

target_dir="${CARGO_TARGET_DIR:-$core/target}"
headers="$target_dir/xcframework-headers"
rm -rf "$headers"
mkdir -p "$headers/ArdiaCoreRS"
cp include/ardia_core.h include/ardia_import.h "$headers/ArdiaCoreRS/"
printf 'module ArdiaCoreRS {\n  header "ardia_core.h"\n  header "ardia_import.h"\n  export *\n}\n' > "$headers/ArdiaCoreRS/module.modulemap"
args=()
for target in "${targets[@]}"; do
  case "$target" in
    *-darwin) export MACOSX_DEPLOYMENT_TARGET=14.0 ;;
    *) export IPHONEOS_DEPLOYMENT_TARGET=17.0 ;;
  esac
  cargo rustc --release --locked -p ardia-apple-ffi --lib --target "$target" --crate-type staticlib
  args+=(-library "$target_dir/$target/release/$library" -headers "$headers")
done

staging="$(mktemp -d "$(dirname "$out")/.ArdiaCoreRS.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
xcodebuild -create-xcframework "${args[@]}" -output "$staging/ArdiaCoreRS.xcframework" >/dev/null
rm -rf "$out"
mv "$staging/ArdiaCoreRS.xcframework" "$out"
printf '%s\n' "$hash" > "$out.inputs"
for slice in "$out"/*/; do
  printf '%s %s\n' "$(du -k "$slice$library" | cut -f1)KB" "$(basename "$slice")"
done
echo "ArdiaCoreRS.xcframework: $out"
