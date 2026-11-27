#!/usr/bin/env bash
# Usage: scripts/check-fast.sh [--all-files] [--no-clippy] [--no-fmt]
# Cheap static checks for the GPUI app, meant to finish in about a minute on a warm target dir:
#   1. ast-grep pattern rules (scripts/lint-patterns.sh --test) and the render-reach pass (scripts/lint-render-reach.mjs)
#   2. cargo clippy on our crates with the workspace lints, --all-targets, -D warnings (third_party is not linted)
#   3. rustfmt --check on .rs files under crates/ changed since the last run, plus last run's failures (--all-files checks every file)
# Honours CARGO_TARGET_DIR and CARGO_BUILD_JOBS. Exits 1 when any step fails.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

clippy=1
fmt=1
all_files=0
for arg in "$@"; do
  case "$arg" in
    --no-clippy) clippy=0 ;;
    --no-fmt) fmt=0 ;;
    --all-files) all_files=1 ;;
    -h|--help) sed -n '2,7s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) echo "check-fast: unknown option $arg" >&2; exit 2 ;;
  esac
done

crates=(
  ardia-theme ardia-state ardia-engine ardia-ui ardia-app ardia-telemetry ardia-profile
  ardia-crypto ardia-ffi ardia-import-core ardia-import-ffi ardia-sync-core ardia-sync-vectors
  ardia-update-core ardia-update-ffi ardia-shell-migration ardia-apple-ffi
)

scratch="$(mktemp -d "${TMPDIR:-/tmp}/check-fast.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
started=$(date +%s)
failed=()

step() {
  local name="$1"
  shift
  local began=$(date +%s)
  if "$@" >"$scratch/$name.log" 2>&1; then
    echo "ok   $name ($(( $(date +%s) - began ))s)" >"$scratch/$name.status"
  else
    echo "FAIL $name ($(( $(date +%s) - began ))s)" >"$scratch/$name.status"
  fi
}

step patterns scripts/lint-patterns.sh --test &
step reach node scripts/lint-render-reach.mjs &

state_dir="${CARGO_TARGET_DIR:-$root/target}/check-fast"
mkdir -p "$state_dir"
fmt_stamp="$state_dir/fmt-stamp"
fmt_failed="$state_dir/fmt-failed"
touch "$scratch/fmt-stamp-next"

fmt_check() {
  local status=0
  rustfmt --edition 2024 --check "$@" >"$scratch/fmt-output" 2>&1 || status=$?
  cat "$scratch/fmt-output"
  sed -n 's|^Diff in \(.*\):[0-9]*:$|\1|p' "$scratch/fmt-output" | sed "s|^$root/||" | sort -u >"$fmt_failed"
  mv "$scratch/fmt-stamp-next" "$fmt_stamp"
  return $status
}

if [ "$fmt" -eq 1 ]; then
  if [ "$all_files" -eq 1 ]; then
    git ls-files 'crates/*.rs' >"$scratch/fmt-files"
  else
    { git diff --name-only HEAD -- 'crates/*.rs'; git ls-files --others --exclude-standard -- 'crates/*.rs'; } | sort -u >"$scratch/fmt-files"
  fi
  : >"$scratch/fmt-wanted"
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    if [ "$all_files" -eq 1 ] || [ ! -f "$fmt_stamp" ] || [ "$file" -nt "$fmt_stamp" ]; then
      echo "$file" >>"$scratch/fmt-wanted"
    fi
  done <"$scratch/fmt-files"
  [ "$all_files" -eq 0 ] && [ -f "$fmt_failed" ] && cat "$fmt_failed" >>"$scratch/fmt-wanted"
  existing=()
  while IFS= read -r file; do
    [ -f "$file" ] && existing+=("$file")
  done < <(sort -u "$scratch/fmt-wanted")
  if [ ${#existing[@]} -gt 0 ]; then
    step fmt fmt_check "${existing[@]}" &
  else
    mv "$scratch/fmt-stamp-next" "$fmt_stamp"
    echo "ok   fmt (nothing changed since the last check)" >"$scratch/fmt.status"
  fi
fi

if [ "$clippy" -eq 1 ]; then
  packages=()
  for crate in "${crates[@]}"; do packages+=(-p "$crate"); done
  step clippy cargo clippy "${packages[@]}" --no-deps --all-targets --message-format=short -- -D warnings
fi
wait

for name in patterns reach fmt clippy; do
  [ -f "$scratch/$name.status" ] || continue
  status="$(cat "$scratch/$name.status")"
  echo "$status"
  case "$status" in
    FAIL*)
      failed+=("$name")
      case "$name" in
        clippy) grep -E '^(crates|error|warning)' "$scratch/$name.log" | grep -v '^warning: build failed' | head -60 ;;
        fmt) head -80 "$scratch/$name.log" ;;
        *) tail -60 "$scratch/$name.log" ;;
      esac
      ;;
    *)
      case "$name" in
        patterns|reach) tail -1 "$scratch/$name.log" | sed 's/^/     /' ;;
      esac
      ;;
  esac
done

echo "check-fast: $(( $(date +%s) - started ))s"
if [ ${#failed[@]} -gt 0 ]; then
  echo "check-fast: failed: ${failed[*]}"
  exit 1
fi
