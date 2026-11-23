#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/official-signatures.sh <fixtures dir> [team id]
Reads the code signature of every Mach-O file in each pinned macOS official-plugin tarball in <fixtures dir> (as
official-plugins.py fixtures writes them), gzip (.tar.gz) or brotli (.tar.br, unpacked by scripts/release/untar-plugin.sh). Ardia trusts these programs by their pinned SHA-256, not by signature, so:
  PASS  Developer ID Application of <team id> (default U5L5T3NGVV), hardened runtime, secure timestamp
  WARN  ad hoc, linker-signed or unsigned, or Developer ID of <team id> without the runtime or a timestamp
  FAIL  a signature that doesn't verify (codesign --verify --strict), or one from anyone but <team id>
Exits 1 on any FAIL. Warnings are printed loudly and, under GitHub Actions, also go to the job summary
(\$GITHUB_STEP_SUMMARY) and as ::warning:: annotations."
case "${1:-}" in -h | --help | "") echo "$usage"; [ -n "${1:-}" ] && exit 0 || exit 64 ;; esac
fixtures="$(cd "$1" && pwd -P)"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
team="${2:-U5L5T3NGVV}"
work="$(mktemp -d /tmp/ac-official-signatures.XXXXXX)"
trap 'rm -rf "$work"' EXIT

summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >>"$GITHUB_STEP_SUMMARY"; fi; }
annotate() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; fi; }

shopt -s nullglob
archives=("$fixtures"/*-macos-arm64.tar.gz "$fixtures"/*-macos-arm64.tar.br)
[ ${#archives[@]} -gt 0 ] || { echo "error: $fixtures has no pinned macOS tarball" >&2; exit 1; }

status=0
for archive in "${archives[@]}"; do
  name="$(basename "$(basename "$archive" -macos-arm64.tar.gz)" -macos-arm64.tar.br)"
  dest="$(mktemp -d "$work/$name.XXXXXX")"
  "$here/untar-plugin.sh" "$archive" "$dest"
  passed=0 warned=0 failed=0
  while IFS= read -r -d '' file; do
    file -b "$file" | grep -q '^Mach-O' || continue
    shown="${file#"$dest"/}"
    details="$(codesign -dv --verbose=4 "$file" 2>&1 || true)"
    if [[ "$details" == *"code object is not signed at all"* ]]; then
      echo "WARN  $shown is unsigned"
      warned=$((warned + 1))
      continue
    fi
    if ! codesign --verify --strict "$file" 2>"$work/verify.err"; then
      echo "FAIL  $shown has a signature that doesn't verify: $(head -1 "$work/verify.err")"
      failed=$((failed + 1))
      continue
    fi
    if grep -q '^Signature=adhoc' <<<"$details"; then
      echo "WARN  $shown is ad hoc signed$(grep -q 'linker-signed' <<<"$details" && echo ' (by the linker)' || true)"
      warned=$((warned + 1))
      continue
    fi
    signer_team="$(sed -n 's/^TeamIdentifier=//p' <<<"$details")"
    authority="$(sed -n 's/^Authority=//p' <<<"$details" | head -1)"
    if [ "$signer_team" != "$team" ] || [[ "$authority" != "Developer ID Application:"* ]]; then
      echo "FAIL  $shown is signed by ${authority:-an unnamed authority} (team ${signer_team:-none}), not Developer ID team $team"
      failed=$((failed + 1))
      continue
    fi
    stamp="$(sed -n 's/^Timestamp=//p' <<<"$details")"
    if grep -q '^CodeDirectory.*flags=.*runtime' <<<"$details" && [ -n "$stamp" ]; then
      echo "PASS  $shown: $authority, hardened runtime, timestamp $stamp"
      passed=$((passed + 1))
    else
      echo "WARN  $shown: $authority, but $(grep -q '^CodeDirectory.*flags=.*runtime' <<<"$details" && echo 'no secure timestamp' || echo 'no hardened runtime')"
      warned=$((warned + 1))
    fi
  done < <(find "$dest" -type f -print0 | sort -z)
  total=$((passed + warned + failed))
  if [ "$failed" -gt 0 ]; then
    echo "FAIL  $name: $failed of $total Mach-O files have a signature that is invalid or not team $team's"
    annotate error "$name: $failed of $total Mach-O files have a signature that is invalid or not team $team's"
    summary "- ❌ $name: $failed of $total Mach-O files have a signature that is invalid or not team $team's"
    status=1
  elif [ "$warned" -gt 0 ]; then
    echo "************************************************************************"
    echo "WARNING  $name: $warned of $total Mach-O files aren't Developer ID signed with the hardened runtime and a timestamp."
    echo "WARNING  Ardia still installs it (trust is the pinned SHA-256), but release a signed, notarized build of it."
    echo "************************************************************************"
    annotate warning "$name: $warned of $total Mach-O files aren't Developer ID signed (team $team) with the hardened runtime and a timestamp"
    summary "- ⚠️ $name: $warned of $total Mach-O files aren't Developer ID signed (team $team) with the hardened runtime and a timestamp. Ardia trusts it by its pinned SHA-256 only."
  elif [ "$total" -gt 0 ]; then
    echo "PASS  $name: all $total Mach-O files are Developer ID (team $team), hardened runtime, timestamped"
    summary "- $name: all $total Mach-O files Developer ID signed (team $team), hardened runtime, timestamped"
  else
    echo "PASS  $name: no Mach-O files"
    summary "- $name: no Mach-O files to sign"
  fi
done
exit $status
