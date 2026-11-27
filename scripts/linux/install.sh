#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install.sh [--prefix DIR] [--destdir DIR]

Installs an extracted Ardia Linux package.

  --prefix DIR   absolute install prefix (default /usr)
  --destdir DIR  staging root for distribution packages (default none)

Ardia goes under PREFIX/lib/ardia with PREFIX/bin/ardia, its desktop entries
(the hidden ones name Little Ardia, Settings and Import windows) and icon. The new lib/ardia is copied beside the old one and swapped in with
renames (one atomic exchange where mv has --exchange), so a running Ardia keeps
the files it has open and a failed copy leaves the old install whole. Run as root without --destdir, it makes lib/ardia/chrome-sandbox
setuid root, Chromium's sandbox where user namespaces are unavailable. The polkit policy always goes to DESTDIR/usr/share/polkit-1/actions,
the only directory polkit reads actions from, whatever the prefix; its update
action names PREFIX/lib/ardia/ardia-update, and is left out unless every
folder from / down to PREFIX/lib/ardia is owned by root and writable only by
root (with --destdir: unless PREFIX is /usr), since it runs that helper as
root without a password.
Without --destdir it must run as root, and installed files are owned by root.
On a host whose AppArmor reads the 4.0 ABI (Ubuntu 24.04 and later), an install
without --destdir also writes /etc/apparmor.d/ardia and loads it, so the
sandbox may create the user namespaces Ubuntu otherwise denies.
USAGE
}

prefix=/usr
destdir=
while (($#)); do
  case "$1" in
    --prefix) prefix="${2:?--prefix needs a directory}"; shift 2 ;;
    --destdir) destdir="${2:?--destdir needs a directory}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

if [[ ! "$prefix" =~ ^/[A-Za-z0-9._/+-]*$ ]]; then
  echo "install.sh: --prefix must be an absolute path of letters, digits and ._/+-: $prefix" >&2
  exit 2
fi
if [[ "/$prefix/" == */../* ]]; then
  echo "install.sh: --prefix must not contain ..: $prefix" >&2
  exit 2
fi
prefix="${prefix%/}"
[[ -n "$prefix" ]] || prefix=/usr

if [[ -z "$destdir" && "$(id -u)" != 0 ]]; then
  echo "install.sh: installing into $prefix needs root (run it with sudo), or pass --destdir to stage it" >&2
  exit 1
fi

source_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
for required in lib/ardia/chrome share/polkit-1/actions/dev.ardia.linux.policy share/applications/ardia.desktop share/apparmor.d/ardia; do
  if [[ ! -e "$source_root/$required" ]]; then
    echo "install.sh: $source_root is not an extracted Ardia package (missing $required)" >&2
    exit 1
  fi
done

target="$destdir$prefix"
installed="$target/lib/ardia"
staged="$target/lib/ardia.new-$$"
retired="$target/lib/ardia.old-$$"
launcher=""

pid_alive() { local why; [[ "$1" =~ ^[1-9][0-9]{0,9}$ ]] && (( $1 <= 2147483647 )) || return 1; why=$(LC_ALL=C; kill -0 "$1" 2>&1) || [[ "$why" == *"Operation not permitted"* ]]; }

finish() {
  if [[ -e "$retired" && ! -e "$installed" && ! -L "$installed" ]]; then
    mv -T -- "$retired" "$installed" || true
  fi
  rm -rf -- "$staged"
  [[ -z "$launcher" ]] || rm -f -- "$launcher"
}
trap finish EXIT

install -d -m 0755 "$target/lib" "$target/bin" "$target/share/applications"
for leftover in "$target"/lib/ardia.new-* "$target"/lib/ardia.old-*; do
  [[ -e "$leftover" || -L "$leftover" ]] || continue
  owner_pid=${leftover##*-}
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! pid_alive "$owner_pid"; then
    if [[ "$leftover" == */ardia.old-* && ! -e "$installed" && ! -L "$installed" ]]; then
      mv -T -- "$leftover" "$installed"
      continue
    fi
    rm -rf -- "$leftover"
  fi
done
rm -rf -- "$staged" "$retired"
cp -R --preserve=mode,timestamps,links "$source_root/lib/ardia" "$staged"
if [[ "$(id -u)" == 0 ]]; then
  chown -R 0:0 "$staged"
  if [[ -z "$destdir" && -f "$staged/chrome-sandbox" ]]; then
    chmod 4755 "$staged/chrome-sandbox"
  fi
fi
if [[ -d "$installed" && ! -L "$installed" ]] && mv --exchange -T -- "$staged" "$installed" 2>/dev/null; then
  mv -T -- "$staged" "$retired"
else
  if [[ -e "$installed" || -L "$installed" ]]; then
    mv -T -- "$installed" "$retired"
  fi
  mv -T -- "$staged" "$installed"
fi
rm -rf -- "$retired"

launcher=$(mktemp)
printf '#!/usr/bin/env sh\nexec "%s/lib/ardia/ardia-launch" "$@"\n' "$prefix" > "$launcher"
install -m 0755 "$launcher" "$target/bin/ardia"

for entry in "$source_root"/share/applications/ardia*.desktop; do
  sed "s|^Exec=ardia |Exec=$prefix/bin/ardia |" "$entry" > "$launcher"
  install -m 0644 "$launcher" "$target/share/applications/${entry##*/}"
done

icon=share/icons/hicolor/256x256/apps/ardia.png
if [[ -f "$source_root/$icon" ]]; then
  install -D -m 0644 "$source_root/$icon" "$target/$icon"
fi

update_action_is_safe() {
  if [[ -n "$destdir" ]]; then
    [[ "$prefix" == /usr ]]
    return
  fi
  local runtime="$prefix/lib/ardia" folder uid mode
  [[ "$(readlink -f -- "$runtime")" == "$runtime" ]] || return 1
  local helper
  for helper in ardia-update ardia-update-verify; do
    [[ -f "$runtime/$helper" && ! -L "$runtime/$helper" ]] || return 1
    [[ "$(stat -c '%u %a' -- "$runtime/$helper")" == "0 755" ]] || return 1
  done
  folder=$runtime
  while :; do
    [[ -d "$folder" && ! -L "$folder" ]] || return 1
    read -r uid mode < <(stat -c '%u %a' -- "$folder")
    [[ "$uid" == 0 ]] && (((8#$mode & 8#022) == 0)) || return 1
    [[ "$folder" != / ]] || return 0
    folder=$(dirname -- "$folder")
  done
}

if update_action_is_safe; then
  sed "s|>/usr/lib/ardia/ardia-update<|>$prefix/lib/ardia/ardia-update<|" \
    "$source_root/share/polkit-1/actions/dev.ardia.linux.policy" > "$launcher"
else
  echo "install.sh: $prefix/lib/ardia or a folder above it isn't root-owned and writable only by root, so Ardia won't update itself there" >&2
  sed '/<action id="dev.ardia.linux.update">/,/<\/action>/d' \
    "$source_root/share/polkit-1/actions/dev.ardia.linux.policy" > "$launcher"
fi
install -D -m 0644 "$launcher" "$destdir/usr/share/polkit-1/actions/dev.ardia.linux.policy"

if [[ -z "$destdir" && -e /etc/apparmor.d/abi/4.0 ]]; then
  sed "s|/usr/lib/ardia/chrome|$prefix/lib/ardia/chrome|" "$source_root/share/apparmor.d/ardia" > "$launcher"
  install -m 0644 "$launcher" /etc/apparmor.d/ardia
  if command -v apparmor_parser >/dev/null && [[ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" == Y ]]; then
    apparmor_parser -r /etc/apparmor.d/ardia
  fi
fi
