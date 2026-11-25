#!/usr/bin/env bash
set -euo pipefail
usage='usage: scripts/linux/update-verify.sh

Builds lib/ardia/ardia-update-verify, the verifier lib/ardia/ardia-update checks
every update manifest and package with, from packages/core-rs: a static
x86_64-unknown-linux-musl release build linked with rust-lld, so it runs on any
x86-64 Linux whatever its libc, and builds the same from macOS. Prints the
binary'"'"'s path, under CARGO_TARGET_DIR when it is set. Needs cargo and
rustup (the toolchain packages/core-rs/rust-toolchain.toml pins, plus the musl
target, which it adds).'

case "${1:-}" in
  -h|--help) echo "$usage"; exit 0 ;;
  "") ;;
  *) echo "$usage" >&2; exit 64 ;;
esac

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
core="$root/packages/core-rs"
target=x86_64-unknown-linux-musl
PATH="$PATH:$HOME/.cargo/bin"
for tool in cargo rustup; do
  command -v "$tool" >/dev/null || { echo "update-verify.sh: $tool is required (https://rustup.rs)" >&2; exit 1; }
done

cd "$core"
rustup target add "$target" >/dev/null 2>&1 || rustup target add "$target" >&2
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld CARGO_PROFILE_RELEASE_STRIP=symbols \
  cargo build --locked --release --quiet -p ardia-update-verify --target "$target" >&2
target_dir=${CARGO_TARGET_DIR:-target}
[[ "$target_dir" == /* ]] || target_dir="$core/$target_dir"
binary="$target_dir/$target/release/ardia-update-verify"
[[ -x "$binary" ]] || { echo "update-verify.sh: cargo built no $binary" >&2; exit 1; }
printf '%s\n' "$binary"
