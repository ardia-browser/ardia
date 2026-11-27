#!/usr/bin/env bash
# Runs ardia-crypto's known answers and the shared update vectors through the BoringSSL backend under cargo.
#
#   tests/boringssl/check.sh
#
# Chromium's GN build is the only other place the boringssl backend compiles. This builds BoringSSL at the pinned
# release with clang, as Chromium does, and with its Rust bindings, into target/boringssl-src and
# target/boringssl-build-clang. Then it builds the same crates/ardia-crypto and crates/ardia-update-core sources as
# tests/boringssl/{crypto,update} with the boringssl and ed25519 features and runs their tests. Needs git, CMake 3.27
# or later, ninja, clang and clang++, libclang and bindgen 0.73.2 (cargo install --locked bindgen-cli --version
# 0.73.2). Nothing here is an engine key input.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;; esac
done

boringssl_commit=d3bf4795ad5b79d646cddf2fec687da5b9b502db
bindgen_version=0.73.2
here=$(cd "$(dirname "$0")" && pwd -P)
core=$(cd "$here/../.." && pwd -P)
source_dir="$core/target/boringssl-src"
build_dir="$core/target/boringssl-build-clang"

for tool in git cmake ninja clang clang++ bindgen cargo; do
  command -v "$tool" >/dev/null || { echo "check.sh: $tool is required" >&2; exit 1; }
done
if [[ "$(bindgen --version)" != "bindgen $bindgen_version" ]]; then
  echo "check.sh: needs bindgen $bindgen_version, not $(bindgen --version): cargo install --locked bindgen-cli --version $bindgen_version" >&2
  exit 1
fi
cmake_version=$(cmake --version | awk 'NR == 1 { print $3 }')
if ! printf '3.27\n%s\n' "$cmake_version" | sort -V -C; then
  echo "check.sh: BoringSSL's Rust bindings need CMake 3.27 or later, not $cmake_version" >&2
  exit 1
fi

if [[ "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)" != "$boringssl_commit" ]]; then
  rm -rf "$source_dir" "$build_dir"
  git init -q "$source_dir"
  git -C "$source_dir" fetch -q --depth 1 https://boringssl.googlesource.com/boringssl "$boringssl_commit"
  git -C "$source_dir" checkout -q FETCH_HEAD
fi

quietly() {
  local log
  log=$(mktemp)
  if ! "$@" >"$log" 2>&1; then
    tail -n 80 "$log" >&2
    rm -f "$log"
    echo "check.sh: $* failed" >&2
    exit 1
  fi
  rm -f "$log"
}

target=$(rustc -vV | awk '/^host:/ { print $2 }')
quietly cmake -S "$source_dir" -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER="$(command -v clang)" -DCMAKE_CXX_COMPILER="$(command -v clang++)" \
  -DBINDGEN_EXECUTABLE="$(command -v bindgen)" -DRUST_BINDINGS="$target"
quietly ninja -C "$build_dir" crypto ssl rust_wrapper bssl_sys

export BORINGSSL_BUILD_DIR="$build_dir"
export CARGO_TARGET_DIR="$core/target/boringssl-check"
cargo test --locked --manifest-path "$here/Cargo.toml" --workspace
