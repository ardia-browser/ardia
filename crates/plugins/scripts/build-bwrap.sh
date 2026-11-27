#!/usr/bin/env bash
set -euo pipefail

BWRAP_VERSION=0.13.1
BWRAP_SHA256=0e85c8702248b8dd64144f594147553650cdd0e4c951690345faace79c217c4d
BWRAP_PATCH=bwrap-die-with-parent-race.patch
BWRAP_PATCH_SHA256=89669a62ce576330375c9f760d571a61f19bdc3ed2983759a40c6b7e8232a224
BWRAP_OUTPUT_SHA256=b5514df5347e5954b394edac20fd3445d4df0e850bc0b80a807cc7f4fc54b7c4
BWRAP_URL="https://github.com/containers/bubblewrap/releases/download/v${BWRAP_VERSION}/bubblewrap-${BWRAP_VERSION}.tar.xz"
ALPINE_IMAGE=alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
REQUIRED_FLAGS=(--ro-bind-fd --bind-fd --add-seccomp-fd --block-fd --info-fd --disable-userns --size --die-with-parent)

usage() {
  cat <<EOF
Usage: build-bwrap.sh [--out DIR] [--mode static|native] [--cache DIR]

Builds the pinned bubblewrap ${BWRAP_VERSION} (sha256 ${BWRAP_SHA256})
with ${BWRAP_PATCH} applied (sha256 ${BWRAP_PATCH_SHA256}), so a sandbox
whose bwrap monitor dies during setup exits instead of waiting forever,
as DIR/ardia-bwrap, the bwrap Ardia's plugin broker binds plugin folders with.

  --out DIR     where ardia-bwrap goes (default: ./out)
  --mode static a static musl build inside ${ALPINE_IMAGE%%@*} (pinned by digest) through docker (default)
  --mode native a build against this system's libcap with meson and ninja
  --cache DIR   where the source tarball is kept (default: ~/.cache/ardia-bwrap)

The tarball is checked against the pinned sha256 before anything is built. The build
lands in a scratch folder and reaches DIR only after it reports version ${BWRAP_VERSION},
offers ${REQUIRED_FLAGS[*]}
and, for --mode static (x86_64 only), links no loader and hashes to the pinned
${BWRAP_OUTPUT_SHA256}. Linux only. The binary is never setuid.
EOF
}

out=out
mode=static
cache="${XDG_CACHE_HOME:-$HOME/.cache}/ardia-bwrap"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --mode) mode="$2"; shift 2 ;;
    --cache) cache="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "build-bwrap.sh: unknown argument $1" >&2; usage >&2; exit 64 ;;
  esac
done
case "$mode" in static|native) ;; *) echo "build-bwrap.sh: --mode is static or native" >&2; exit 64 ;; esac
[ "$(uname -s)" = Linux ] || { echo "build-bwrap.sh: bubblewrap builds on Linux only" >&2; exit 1; }
if [ "$mode" = static ] && [ "$(uname -m)" != x86_64 ]; then
  echo "build-bwrap.sh: the pinned static output is for x86_64; $(uname -m) has no pinned hash yet" >&2
  exit 1
fi

mkdir -p "$out" "$cache"
out="$(cd "$out" && pwd)"
tarball="$cache/bubblewrap-${BWRAP_VERSION}.tar.xz"
if [ ! -f "$tarball" ] || ! echo "${BWRAP_SHA256}  $tarball" | sha256sum -c --status; then
  curl -fsSL --retry 3 --max-time 120 -o "$tarball.part" "$BWRAP_URL"
  mv "$tarball.part" "$tarball"
fi
if ! echo "${BWRAP_SHA256}  $tarball" | sha256sum -c --status; then
  echo "build-bwrap.sh: $tarball doesn't match the pinned sha256 ${BWRAP_SHA256}" >&2
  rm -f "$tarball"
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xJf "$tarball" -C "$work"
src="$work/bubblewrap-${BWRAP_VERSION}"
patch_file="$(cd "$(dirname "$0")" && pwd)/$BWRAP_PATCH"
if ! echo "${BWRAP_PATCH_SHA256}  $patch_file" | sha256sum -c --status; then
  echo "build-bwrap.sh: $patch_file doesn't match the pinned sha256 ${BWRAP_PATCH_SHA256}" >&2
  exit 1
fi
command -v patch >/dev/null || { echo "build-bwrap.sh: applying $BWRAP_PATCH needs patch" >&2; exit 1; }
patch -s -d "$src" -p1 < "$patch_file"
staged="$work/staged"
mkdir -p "$staged"
meson_options=(-Dselinux=disabled -Dman=disabled -Dtests=false -Dbash_completion=disabled -Dzsh_completion=disabled)

if [ "$mode" = static ]; then
  command -v docker >/dev/null || { echo "build-bwrap.sh: --mode static needs docker" >&2; exit 1; }
  timeout 900 docker run --rm --network=host \
    -v "$src:/src:ro" -v "$staged:/out" -e "OWNER=$(id -u):$(id -g)" \
    "$ALPINE_IMAGE" sh -euc "
      apk add --no-cache build-base meson samurai pkgconf libcap-dev libcap-static linux-headers >/dev/null
      meson setup /tmp/build /src --buildtype=release --default-library=static --prefer-static \
        -Dc_link_args=-static ${meson_options[*]} >/dev/null
      ninja -C /tmp/build bwrap >/dev/null
      install -m 0755 /tmp/build/bwrap /out/ardia-bwrap
      strip /out/ardia-bwrap
      chown \"\$OWNER\" /out/ardia-bwrap
    "
else
  for tool in meson ninja pkg-config; do
    command -v "$tool" >/dev/null || { echo "build-bwrap.sh: --mode native needs $tool (and libcap-dev)" >&2; exit 1; }
  done
  meson setup "$work/build" "$src" --buildtype=release "${meson_options[@]}" >/dev/null
  ninja -C "$work/build" bwrap >/dev/null
  install -m 0755 "$work/build/bwrap" "$staged/ardia-bwrap"
fi

binary="$staged/ardia-bwrap"
chmod u-s,g-s "$binary"
reported="$("$binary" --version)"
if [ "$reported" != "bubblewrap ${BWRAP_VERSION}" ]; then
  echo "build-bwrap.sh: the build reports \"$reported\", not bubblewrap ${BWRAP_VERSION}" >&2
  exit 1
fi
help="$("$binary" --help)"
for flag in "${REQUIRED_FLAGS[@]}"; do
  if ! grep -q -- "$flag" <<<"$help"; then
    echo "build-bwrap.sh: the build lacks $flag" >&2
    exit 1
  fi
done
if [ "$mode" = static ] && ldd "$binary" >/dev/null 2>&1; then
  echo "build-bwrap.sh: --mode static produced a dynamically linked binary" >&2
  exit 1
fi
produced="$(sha256sum "$binary" | cut -d' ' -f1)"
if [ "$mode" = static ] && [ "$produced" != "$BWRAP_OUTPUT_SHA256" ]; then
  echo "build-bwrap.sh: the static build hashes to $produced, not the pinned $BWRAP_OUTPUT_SHA256" >&2
  exit 1
fi
install -m 0755 "$binary" "$out/.ardia-bwrap.$$"
mv -f "$out/.ardia-bwrap.$$" "$out/ardia-bwrap"
binary="$out/ardia-bwrap"
echo "$binary: $reported, sha256 $(sha256sum "$binary" | cut -d' ' -f1), $(stat -c %s "$binary") bytes"
