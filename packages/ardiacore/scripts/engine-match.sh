#!/bin/bash
# Reads, resolves and acts on an engine record, the line fetch-engine.sh writes to engine-match beside the framework it
# fetched. The record holds what doesn't change for an engine:
#   match=exact|nearest|unknown key=<engine key> version=<release> source=<commit it was published from>
#   public_tree=<content hash of engine/ardiacore/src/ardia/core/public as that engine was built>
# A framework with no record is match=local (an engine built here, or ARDIACORE_FRAMEWORK pointing at one); unknown is
# an engine whose release couldn't be looked up.
#
#   engine-match.sh get <field> <line>             prints one field (match is local when the line has none)
#   engine-match.sh public-hash <root> [<commit>]  the hash of the public headers' paths, modes and contents at
#                                                  <commit>, or on disk: the files git tracks or shows as untracked
#                                                  (every file there when <root> has no git, as in a build slot)
#   engine-match.sh resolve <root> <line>          the record judged against the tree in <root>, as it is on disk:
#                                                  match recomputed when <root> is a git checkout, all from one pinned
#                                                  commit (refused if HEAD moves meanwhile), plus
#                                                  public=same|changed|unknown
#   engine-match.sh record-of <framework>          the record beside the framework's real path (symlinks followed);
#                                                  match=local only for a framework outside the prebuilt stores, and
#                                                  match=unknown with nothing recorded for one inside them
#   engine-match.sh check <resolved line>          fails unless the engine is local or its public headers match the
#                                                  tree's (an engine whose headers nothing records fails too)
#   engine-match.sh plist <resolved line> <Info.plist>
#                                                  checks, then writes ArdiaEngineMatch, ArdiaEngineKey,
#                                                  ArdiaEngineVersion and ArdiaEngineSource into the app's Info.plist
#
# ARDIACORE_ALLOW_PUBLIC_MISMATCH=1 lets check and plist pass a mismatch: for engine work that builds against an
# older engine on purpose, and for CI, which compiles anyway and fails after the build.
set -euo pipefail
public_dir=engine/ardiacore/src/ardia/core/public
die() { echo "error: $*" >&2; exit 1; }

field() {
  local want=$1 pair
  for pair in $2; do
    if [[ "${pair%%=*}" == "$want" ]]; then
      printf '%s\n' "${pair#*=}"
      return 0
    fi
  done
  [[ "$want" == match ]] && echo local
  return 0
}

match_of() {
  local match
  match=$(field match "$1")
  case "$match" in
    exact | nearest | local | unknown) echo "$match" ;;
    *) die "engine match line has match=$match, not exact, nearest, local or unknown: $1" ;;
  esac
}

is_checkout() {
  local top
  top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  [[ "$(cd "$top" && pwd -P)" == "$(cd "$1" && pwd -P)" ]]
}

public_files() {
  local root=$1
  if is_checkout "$root"; then
    git -C "$root" ls-files -z -co --exclude-standard -- "$public_dir"
  elif [[ -d "$root/$public_dir" ]]; then
    (cd "$root" && find "$public_dir" \( -type f -o -type l \) -print0)
  fi
}

disk_entry() {
  local file=$1
  if [[ -L "$file" ]]; then
    printf '%s 120000 %s\n' "$file" "$(printf '%s' "$(readlink "$file")" | git hash-object --stdin)"
  elif [[ -f "$file" && -x "$file" ]]; then
    printf '%s 100755 %s\n' "$file" "$(git hash-object --no-filters -- "$file")"
  elif [[ -f "$file" ]]; then
    printf '%s 100644 %s\n' "$file" "$(git hash-object --no-filters -- "$file")"
  fi
}

public_tree() {
  local root=$1 commit=${2:-}
  if [[ -n "$commit" ]]; then
    git -C "$root" ls-tree -r -z "$commit" -- "$public_dir" | while IFS= read -r -d '' entry; do
      read -r mode _ blob <<<"${entry%%$'\t'*}"
      printf '%s %s %s\n' "${entry#*$'\t'}" "$mode" "$blob"
    done
  else
    public_files "$root" | (cd "$root" && while IFS= read -r -d '' file; do disk_entry "$file"; done)
  fi | LC_ALL=C sort | shasum -a 256 | cut -c1-64
}

resolve() {
  local root=$1 line=$2 match key want public pinned current_key pathspec clean
  local -a key_paths=()
  match=$(match_of "$line")
  [[ "$match" == local ]] && { echo "match=local"; return 0; }
  key=$(field key "$line")
  want=$(field public_tree "$line")
  if [[ "$match" != unknown && -n "$key" ]] && is_checkout "$root"; then
    pinned=$(git -C "$root" rev-parse --verify 'HEAD^{commit}') || die "$root has no commit to judge the engine against"
    current_key=$("$root/engine/engine-key.sh" --platform macos "$pinned" 2>/dev/null || true)
    while IFS= read -r pathspec; do
      [[ -z "$pathspec" ]] || key_paths+=("$pathspec")
    done < <("$root/engine/engine-key.sh" --platform macos --paths 2>/dev/null || true)
    clean=0
    if [[ ${#key_paths[@]} -gt 0 ]] && git -C "$root" diff --quiet --no-ext-diff "$pinned" -- "${key_paths[@]}" 2>/dev/null &&
      [[ -z "$(git -C "$root" ls-files -z --others --exclude-standard -- "${key_paths[@]}" 2>/dev/null)" ]]; then
      clean=1
    fi
    [[ -n "$current_key" && "$current_key" == "$key" && "$clean" == 1 ]] && match=exact || match=nearest
  fi
  public=unknown
  [[ -z "$want" ]] || { [[ "$(public_tree "$root")" == "$want" ]] && public=same || public=changed; }
  if [[ -n "${pinned:-}" && "$(git -C "$root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" != "$pinned" ]]; then
    die "$root moved off ${pinned:0:10} while its engine was judged; run the build again"
  fi
  [[ "$match" == exact && "$public" == changed ]] && match=nearest
  echo "match=$match key=$key version=$(field version "$line") source=$(field source "$line") public_tree=$want public=$public"
}

record_of() {
  local framework=$1 real cache
  real=$(cd "$framework" 2>/dev/null && pwd -P) || { echo "match=local"; return 0; }
  if [[ -f "$(dirname "$real")/engine-match" ]]; then
    head -n 1 "$(dirname "$real")/engine-match"
    return 0
  fi
  cache=$(cd "${AC_APP_CACHE:-$HOME/ardia-scratch/app-cache}" 2>/dev/null && pwd -P || true)
  case "$real/" in
    */build-ardiacore/prebuilt/*) echo "match=unknown key=" ;;
    *) if [[ -n "$cache" && "$real/" == "$cache/"* ]]; then echo "match=unknown key="; else echo "match=local"; fi ;;
  esac
}

check() {
  local line=$1 match public engine problem
  match=$(match_of "$line")
  [[ "$match" == local ]] && return 0
  public=$(field public "$line")
  [[ "$public" == same ]] && return 0
  engine="engine $(field key "$line" | cut -c1-12)"
  [[ -z "$(field version "$line")" ]] || engine="$(field version "$line")'s engine (published from $(field source "$line" | cut -c1-10))"
  if [[ "$public" == changed ]]; then
    problem="this tree's $public_dir differs from that of $engine, so the app can't match it"
  else
    problem="nothing records the $public_dir that $engine was built with, so the app can't be checked against it"
  fi
  if [[ "${ARDIACORE_ALLOW_PUBLIC_MISMATCH:-}" == 1 ]]; then
    echo "warning: $problem (building anyway: ARDIACORE_ALLOW_PUBLIC_MISMATCH=1)" >&2
    return 0
  fi
  echo "error: $problem." >&2
  echo "error: build the engine (docs/engine-build.md) and set ARDIACORE_FRAMEWORK to it, check out a commit with a published engine, or set ARDIACORE_ALLOW_PUBLIC_MISMATCH=1 to build anyway." >&2
  return 1
}

plist() {
  local line=$1 file=$2 match name value plist_key
  [[ -f "$file" ]] || die "no Info.plist at $file"
  check "$line"
  match=$(match_of "$line")
  plutil -replace ArdiaEngineMatch -string "$match" "$file"
  for name in key version source; do
    value=$(field "$name" "$line")
    plist_key="ArdiaEngine$(tr '[:lower:]' '[:upper:]' <<<"${name:0:1}")${name:1}"
    if [[ "$match" != local && -n "$value" ]]; then
      plutil -replace "$plist_key" -string "$value" "$file"
    else
      plutil -remove "$plist_key" "$file" >/dev/null 2>&1 || true
    fi
  done
}

case "${1:-}" in
  get) [[ $# -eq 3 ]] || die "usage: engine-match.sh get <field> <line>"; field "$2" "$3" ;;
  public-hash) [[ $# -eq 2 || $# -eq 3 ]] || die "usage: engine-match.sh public-hash <root> [<commit>]"; public_tree "$2" "${3:-}" ;;
  record-of) [[ $# -eq 2 ]] || die "usage: engine-match.sh record-of <framework>"; record_of "$2" ;;
  resolve) [[ $# -eq 3 ]] || die "usage: engine-match.sh resolve <root> <line>"; resolve "$2" "$3" ;;
  check) [[ $# -eq 2 ]] || die "usage: engine-match.sh check <line>"; check "$2" ;;
  plist) [[ $# -eq 3 ]] || die "usage: engine-match.sh plist <line> <Info.plist>"; plist "$2" "$3" ;;
  -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" ;;
  *) die "usage: engine-match.sh get|public-hash|record-of|resolve|check|plist … (--help)" ;;
esac
