#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: install.sh [--prefix DIR] [--destdir DIR]
       install.sh --uninstall [--prefix DIR] [--destdir DIR]

Installs an extracted Ardia Linux package, or removes one it installed.

  --prefix DIR   absolute install prefix (default /usr)
  --destdir DIR  staging root for distribution packages (default none)
  --uninstall    remove what install.sh put under PREFIX, its polkit policy and
                 AppArmor profile; your Ardia profile and data stay

Ardia goes under PREFIX/lib/ardia with PREFIX/bin/ardia, its desktop entry
and icon. Run as root without --destdir, it makes lib/ardia/chrome-sandbox
setuid root, Chromium's sandbox where user namespaces are unavailable. The polkit policy always goes to DESTDIR/usr/share/polkit-1/actions,
the only directory polkit reads actions from, whatever the prefix.
Without --destdir it must run as root, and installed files are owned by root.
On a host whose AppArmor reads the 4.0 ABI (Ubuntu 24.04 and later), an install
without --destdir also writes /etc/apparmor.d/ardia and loads it, so the
sandbox may create the user namespaces Ubuntu otherwise denies.
An install without --destdir keeps a copy of this script at
PREFIX/lib/ardia/install.sh, so sudo PREFIX/lib/ardia/install.sh --uninstall
removes it later. It refuses to remove an Ardia that a .deb or an Arch package
installed; remove that one with apt or pacman.
USAGE
}

prefix=
destdir=
mode=install
while (($#)); do
  case "$1" in
    --prefix) prefix="${2:?--prefix needs a directory}"; shift 2 ;;
    --destdir) destdir="${2:?--destdir needs a directory}"; shift 2 ;;
    --uninstall) mode=uninstall; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

source_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [[ -z "$prefix" ]]; then
  prefix=/usr
  if [[ "$mode" == uninstall && -z "$destdir" && "$source_root" == */lib/ardia ]]; then
    prefix="${source_root%/lib/ardia}"
  fi
fi

if [[ ! "$prefix" =~ ^/[A-Za-z0-9._/+-]*$ ]]; then
  echo "install.sh: --prefix must be an absolute path of letters, digits and ._/+-: $prefix" >&2
  exit 2
fi
if [[ "/$prefix/" == */../* ]]; then
  echo "install.sh: --prefix must not contain ..: $prefix" >&2
  exit 2
fi
prefix=$(realpath -ms -- "$prefix")
prefix="${prefix%/}"
[[ -n "$prefix" ]] || prefix=/usr

if [[ -z "$destdir" && "$(id -u)" != 0 ]]; then
  if [[ "$mode" == uninstall ]]; then
    echo "install.sh: removing Ardia from $prefix needs root (run it with sudo)" >&2
  else
    echo "install.sh: installing into $prefix needs root (run it with sudo), or pass --destdir to stage it" >&2
  fi
  exit 1
fi

if [[ -z "$destdir" ]]; then
  install -d -m 0755 /var/lib/ardia
  exec 9> /var/lib/ardia/lock
  flock 9
fi

target="$destdir$prefix"
policy="$destdir/usr/share/polkit-1/actions/dev.ardia.linux.policy"
icon=share/icons/hicolor/256x256/apps/ardia.png
registry="$destdir/var/lib/ardia/installs"

package_owner() {
  if command -v dpkg-query >/dev/null && dpkg-query -S "$1" >/dev/null 2>&1; then echo apt; return; fi
  if command -v pacman >/dev/null && pacman -Qqo "$1" >/dev/null 2>&1; then echo pacman; return; fi
  if command -v rpm >/dev/null && rpm -qf "$1" >/dev/null 2>&1; then echo rpm; return; fi
  return 1
}

package_owner_of_install() {
  local chrome="$target/lib/ardia/chrome" resolved
  package_owner "$chrome" && return
  resolved=$(realpath -e -- "$chrome" 2>/dev/null) || return 1
  [[ "$resolved" != "$chrome" ]] && package_owner "$resolved"
}

remove_if_ours() {
  local path=$1 marker=$2
  if [[ -f "$path" ]] && grep -qxF -- "$marker" "$path"; then
    rm -f "$path"
    echo "removed $path"
  fi
}

profile_names_prefix() {
  awk -v chrome="$prefix/lib/ardia/chrome" '$1 == "profile" && $3 == chrome { found = 1 } END { exit !found }' "$1"
}

other_install_uses_policy() {
  [[ "$prefix" != /usr && -e "$destdir/usr/lib/ardia/chrome" ]] && return 0
  [[ -z "$destdir" ]] && package_owner "$policy" >/dev/null && return 0
  local other
  if [[ -f "$registry" ]]; then
    while IFS= read -r other; do
      [[ -n "$other" && "$other" != "$prefix" && -e "$destdir$other/lib/ardia/chrome" ]] && return 0
    done < "$registry"
  fi
  return 1
}

record_install() {
  install -d -m 0755 "$(dirname -- "$registry")"
  if [[ ! -f "$registry" ]] || ! grep -qxF -- "$prefix" "$registry"; then
    printf '%s\n' "$prefix" >> "$registry"
  fi
}

forget_install() {
  [[ -f "$registry" ]] || return 0
  local kept
  kept=$(grep -vxF -- "$prefix" "$registry" || true)
  if [[ -n "$kept" ]]; then printf '%s\n' "$kept" > "$registry"; else rm -f "$registry"; fi
}

uninstall() {
  if [[ ! -e "$target/lib/ardia/chrome" || ! -e "$target/lib/ardia/ardia-launch" ]]; then
    echo "install.sh: no Ardia installed under $prefix (missing $target/lib/ardia/chrome)" >&2
    exit 1
  fi
  local owner
  if [[ -z "$destdir" ]] && owner=$(package_owner_of_install); then
    echo "install.sh: $prefix/lib/ardia belongs to a package; remove it with $owner instead" >&2
    exit 1
  fi
  if [[ -z "$destdir" && -f /etc/apparmor.d/ardia ]] && profile_names_prefix /etc/apparmor.d/ardia; then
    if command -v apparmor_parser >/dev/null && [[ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" == Y ]]; then
      apparmor_parser -R /etc/apparmor.d/ardia >/dev/null 2>&1 || true
    fi
    rm -f /etc/apparmor.d/ardia
    echo "removed /etc/apparmor.d/ardia"
  fi
  remove_if_ours "$target/bin/ardia" "exec \"$prefix/lib/ardia/ardia-launch\" \"\$@\""
  if [[ -f "$target/share/applications/ardia.desktop" ]] && grep -qF -- "Exec=$prefix/bin/ardia " "$target/share/applications/ardia.desktop"; then
    rm -f "$target/share/applications/ardia.desktop"
    echo "removed $target/share/applications/ardia.desktop"
    if [[ -f "$target/$icon" ]]; then
      rm -f "$target/$icon"
      echo "removed $target/$icon"
    fi
  fi
  rm -rf "$target/lib/ardia"
  echo "removed $target/lib/ardia"
  forget_install
  if [[ -f "$policy" ]] && ! other_install_uses_policy; then
    rm -f "$policy"
    echo "removed $policy"
  fi
  echo "Ardia is uninstalled. Each user's profile and data stay in ~/.config/ardia; delete that folder to remove them too."
}

if [[ "$mode" == uninstall ]]; then
  uninstall
  exit 0
fi

for required in lib/ardia/chrome share/polkit-1/actions/dev.ardia.linux.policy share/applications/ardia.desktop share/apparmor.d/ardia; do
  if [[ ! -e "$source_root/$required" ]]; then
    echo "install.sh: $source_root is not an extracted Ardia package (missing $required)" >&2
    exit 1
  fi
done

install -d -m 0755 "$target/lib" "$target/bin" "$target/share/applications"
rm -rf "$target/lib/ardia"
cp -R --preserve=mode,timestamps,links "$source_root/lib/ardia" "$target/lib/ardia"
if [[ "$(id -u)" == 0 ]]; then
  chown -R 0:0 "$target/lib/ardia"
  if [[ -z "$destdir" && -f "$target/lib/ardia/chrome-sandbox" ]]; then
    chmod 4755 "$target/lib/ardia/chrome-sandbox"
  fi
fi

launcher=$(mktemp)
trap 'rm -f "$launcher"' EXIT
printf '#!/usr/bin/env sh\nexec "%s/lib/ardia/ardia-launch" "$@"\n' "$prefix" > "$launcher"
install -m 0755 "$launcher" "$target/bin/ardia"

sed "s|^Exec=ardia |Exec=$prefix/bin/ardia |" "$source_root/share/applications/ardia.desktop" > "$launcher"
install -m 0644 "$launcher" "$target/share/applications/ardia.desktop"

if [[ -f "$source_root/$icon" ]]; then
  install -D -m 0644 "$source_root/$icon" "$target/$icon"
fi

install -D -m 0644 "$source_root/share/polkit-1/actions/dev.ardia.linux.policy" \
  "$policy"

if [[ -z "$destdir" ]]; then
  install -m 0755 "$source_root/install.sh" "$target/lib/ardia/install.sh"
  record_install
fi

if [[ -z "$destdir" && -e /etc/apparmor.d/abi/4.0 ]]; then
  sed "s|/usr/lib/ardia/chrome|$prefix/lib/ardia/chrome|" "$source_root/share/apparmor.d/ardia" > "$launcher"
  install -m 0644 "$launcher" /etc/apparmor.d/ardia
  if command -v apparmor_parser >/dev/null && [[ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null)" == Y ]]; then
    apparmor_parser -r /etc/apparmor.d/ardia
  fi
fi
