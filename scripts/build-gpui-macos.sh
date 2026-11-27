#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-gpui-macos.sh [options]

Builds the GPUI Ardia (crates/ardia-app) and packages it as a macOS app:
  <out>/Ardia.app/Contents/{MacOS/ardia, Helpers/ardia-plugin-host,
                            Frameworks/Chromium Framework.framework,
                            Resources/{AppIcon.icns, Ardia.sdef, Extensions/ublock,
                                       Extensions/ublock-lite-settings, ContentRules, HSTS},
                            Info.plist, PkgInfo}
uBlock Origin is downloaded once at the pinned version, checked against its SHA-256 and
patched (crates/ardia-app/resources/ubo.sh); without network the app is built without it.
The WebKit content rules (uBOL, crates/ardia-app/resources/ubol-webkit.sh) and Chromium's
HSTS preload list (crates/ardia-app/resources/hsts-preload.sh) are built the same way.
The Chromium Framework is cloned (copy-on-write) into the bundle, never changed in
place, and the bundle is signed ad hoc so macOS launches it.

Options:
  --release            Build with the release profile (default: debug)
  --out <dir>          Put Ardia.app in <dir> (default: target/gpui-app)
  --framework <path>   Chromium Framework.framework to bundle (default: $ARDIACORE_FRAMEWORK,
                       then ~/chromium-build/chromium_git/chromium/src/out/Release_GN_arm64)
  --link-framework     Symlink the framework instead of cloning it, and skip signing
                       (fast local iteration; the bundle can't be moved to another Mac)
  --no-framework       Package without Chromium (the app runs on the mock engine)
  --skip-build         Package the binary that's already built
  --dry-run            Print every step without running it
  -h, --help           Print this help

Environment:
  CARGO_TARGET_DIR     Where cargo builds (default: target)
  ARDIACORE_FRAMEWORK  Framework to bundle when --framework isn't given

Run it hidden, without taking focus:
  open -g -n --env ARDIA_BACKGROUND=1 --env ARDIA_DATA_DIR=/tmp/ardia-scratch <out>/Ardia.app
EOF
}

fail() {
  printf 'build-gpui-macos: %s\n' "$*" >&2
  exit 1
}

release=0
out=""
framework="${ARDIACORE_FRAMEWORK:-}"
link=0
bundle_framework=1
skip_build=0
dry=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) release=1 ;;
    --out)
      [[ $# -ge 2 && -n "$2" ]] || fail "--out needs a folder"
      out="$2"
      shift
      ;;
    --out=*) out="${1#--out=}" ;;
    --framework)
      [[ $# -ge 2 && -n "$2" ]] || fail "--framework needs a path"
      framework="$2"
      shift
      ;;
    --framework=*) framework="${1#--framework=}" ;;
    --link-framework) link=1 ;;
    --no-framework) bundle_framework=0 ;;
    --skip-build) skip_build=1 ;;
    --dry-run) dry=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option $1"
      ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || fail "this packages a macOS app; run it on a Mac"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate="$repo/crates/ardia-app"
target_dir="${CARGO_TARGET_DIR:-$repo/target}"
[[ "$target_dir" == /* ]] || target_dir="$repo/$target_dir"
profile="debug"
cargo_flags=(build -p ardia-app -p ardia-plugin-host)
if [[ $release -eq 1 ]]; then
  profile="release"
  cargo_flags+=(--release)
fi
binary="$target_dir/$profile/ardia"
plugin_host="$target_dir/$profile/ardia-plugin-host"
out="${out:-$repo/target/gpui-app}"
[[ "$out" == /* ]] || out="$PWD/$out"
out="${out%/}"
app="$out/Ardia.app"
staging_root=""
swap_lock="$out/.ardia-app-swap"
holding_swap=0
framework_name="Chromium Framework.framework"
default_framework="$HOME/chromium-build/chromium_git/chromium/src/out/Release_GN_arm64/$framework_name"
if [[ $bundle_framework -eq 1 ]]; then
  framework="${framework:-$default_framework}"
  framework="${framework%/}"
  [[ "$framework" == /* ]] || framework="$PWD/$framework"
  if [[ -d "$framework" ]]; then
    framework="$(cd "$framework" && pwd)"
  fi
  if [[ ! -x "$framework/Chromium Framework" ]]; then
    if [[ $dry -eq 1 ]]; then
      printf 'build-gpui-macos: warning: %s has no Chromium Framework binary\n' "$framework" >&2
    else
      fail "$framework has no Chromium Framework binary; pass --framework or --no-framework"
    fi
  fi
fi
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/Cargo.toml" | head -n 1)"
version="${version:-0.0.0}"
build_number="$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 1)"
icon_source="$crate/resources/AppIcon.appiconset"
icon_cache="$target_dir/gpui-app-icon/AppIcon.icns"
ubo_vendor="$target_dir/gpui-ubo"
ubol_vendor="$target_dir/gpui-ubol-webkit"
hsts_vendor="$target_dir/gpui-hsts-preload"
ubo_settings="$crate/resources/extensions/ublock-lite-settings"

run() {
  if [[ $dry -eq 1 ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

say() {
  printf '==> %s\n' "$*"
}

build_icon() {
  if [[ -f "$icon_cache" && "$icon_cache" -nt "$icon_source/Contents.json" ]]; then
    return 0
  fi
  local iconset
  iconset="$(mktemp -d "${TMPDIR:-/tmp}/ardia-icon.XXXXXX")/AppIcon.iconset"
  mkdir -p "$iconset" "$(dirname "$icon_cache")"
  local png name
  for png in "$icon_source"/icon_*_1x.png "$icon_source"/icon_*_2x.png; do
    [[ -f "$png" ]] || continue
    name="$(basename "$png" .png)"
    case "$name" in
      *_1x) cp "$png" "$iconset/${name%_1x}.png" ;;
      *_2x) cp "$png" "$iconset/${name%_2x}@2x.png" ;;
    esac
  done
  iconutil -c icns "$iconset" -o "$icon_cache"
  rm -rf "$(dirname "$iconset")"
}

if [[ $skip_build -eq 0 ]]; then
  say "building ardia-app ($profile)"
  run env CARGO_TARGET_DIR="$target_dir" cargo "${cargo_flags[@]}" --manifest-path "$repo/Cargo.toml"
fi
if [[ $dry -eq 0 && ! -x "$binary" ]]; then
  fail "$binary isn't built; drop --skip-build"
fi
if [[ $dry -eq 0 && ! -x "$plugin_host" ]]; then
  fail "$plugin_host isn't built; drop --skip-build"
fi

cleanup() {
  [[ $dry -eq 1 ]] && return 0
  if [[ -n "$staging_root" && -d "$staging_root" ]]; then
    rm -rf "$staging_root"
  fi
  if [[ $holding_swap -eq 1 ]]; then
    rmdir "$swap_lock" 2>/dev/null || true
  fi
}
trap cleanup EXIT

take_swap_lock() {
  local tries=0
  until mkdir "$swap_lock" 2>/dev/null; do
    tries=$((tries + 1))
    [[ $tries -lt 600 ]] || fail "another build has held $swap_lock for a minute; remove it if no build is running"
    sleep 0.1
  done
  holding_swap=1
}

say "assembling $app"
run mkdir -p "$out"
if [[ $dry -eq 1 ]]; then
  staging_root="$out/.ardia-app-partial.XXXXXX"
  run mktemp -d "$staging_root"
else
  staging_root="$(mktemp -d "$out/.ardia-app-partial.XXXXXX")"
fi
staging="$staging_root/Ardia.app"
contents="$staging/Contents"
run mkdir -p "$contents/MacOS" "$contents/Frameworks" "$contents/Resources" "$contents/Helpers"
run cp "$binary" "$contents/MacOS/ardia"
run cp "$plugin_host" "$contents/Helpers/ardia-plugin-host"
embed_webkit_rules() {
  if ! UBOL_VENDOR_DIR="$ubol_vendor" bash "$crate/resources/ubol-webkit.sh"; then
    printf 'build-gpui-macos: warning: the WebKit content rules could not be built; WebKit tabs have no ad blocking\n' >&2
  elif [[ -f "$ubol_vendor/rules/rulesets.json" ]]; then
    rsync -a --delete "$ubol_vendor/rules/" "$contents/Resources/ContentRules/"
  fi
  if ! HSTS_VENDOR_DIR="$hsts_vendor" bash "$crate/resources/hsts-preload.sh"; then
    printf 'build-gpui-macos: warning: the HSTS preload list could not be built; WebKit tabs upgrade only known hosts\n' >&2
  elif [[ -d "$hsts_vendor/hosts" ]]; then
    rsync -a --delete "$hsts_vendor/hosts/" "$contents/Resources/HSTS/"
  fi
}
if [[ $dry -eq 1 ]]; then
  run env UBOL_VENDOR_DIR="$ubol_vendor" bash "$crate/resources/ubol-webkit.sh"
  run rsync -a --delete "$ubol_vendor/rules/" "$contents/Resources/ContentRules/"
  run env HSTS_VENDOR_DIR="$hsts_vendor" bash "$crate/resources/hsts-preload.sh"
  run rsync -a --delete "$hsts_vendor/hosts/" "$contents/Resources/HSTS/"
else
  embed_webkit_rules
fi
if [[ $dry -eq 1 ]]; then
  run sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build_number/" "$crate/resources/Info.plist"
else
  sed -e "s/@VERSION@/$version/" -e "s/@BUILD@/$build_number/" "$crate/resources/Info.plist" >"$contents/Info.plist"
  plutil -lint "$contents/Info.plist" >/dev/null
  printf 'APPL????' >"$contents/PkgInfo"
fi
run cp "$crate/resources/Ardia.sdef" "$contents/Resources/Ardia.sdef"
if [[ $dry -eq 0 ]]; then
  xmllint --noout "$contents/Resources/Ardia.sdef"
fi
if [[ -d "$icon_source" ]]; then
  if [[ $dry -eq 1 ]]; then
    run iconutil -c icns "<AppIcon.iconset from $icon_source>" -o "$icon_cache"
  else
    build_icon
  fi
  run cp "$icon_cache" "$contents/Resources/AppIcon.icns"
fi

embed_ublock() {
  local extensions="$contents/Resources/Extensions"
  if ! UBO_VENDOR_DIR="$ubo_vendor" bash "$crate/resources/ubo.sh"; then
    printf 'build-gpui-macos: warning: uBlock Origin could not be prepared; the app has no content blocker\n' >&2
    return 0
  fi
  [[ -f "$ubo_vendor/ubo/ext/manifest.json" ]] || return 0
  mkdir -p "$extensions"
  rsync -a --delete "$ubo_vendor/ubo/ext/" "$extensions/ublock/"
  (cd "$extensions/ublock" && find . -type f ! -path './_metadata/*' -print0 | LC_ALL=C sort -z \
    | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1) >"$extensions/ublock.fingerprint"
  rsync -a --delete "$ubo_settings/" "$extensions/ublock-lite-settings/"
}

if [[ $dry -eq 1 ]]; then
  run env UBO_VENDOR_DIR="$ubo_vendor" bash "$crate/resources/ubo.sh"
  run rsync -a --delete "$ubo_vendor/ubo/ext/" "$contents/Resources/Extensions/ublock/"
else
  embed_ublock
fi

if [[ $bundle_framework -eq 1 ]]; then
  if [[ $link -eq 1 ]]; then
    say "linking $framework"
    run ln -s "$framework" "$contents/Frameworks/$framework_name"
  else
    say "cloning $framework"
    if [[ $dry -eq 1 ]]; then
      run cp -cR "$framework" "$contents/Frameworks/$framework_name"
    elif ! cp -cR "$framework" "$contents/Frameworks/$framework_name" 2>/dev/null; then
      rm -rf "$contents/Frameworks/$framework_name"
      cp -R "$framework" "$contents/Frameworks/$framework_name"
    fi
  fi
fi

if [[ $dry -eq 1 ]] || ! otool -l "$contents/MacOS/ardia" | grep -q "@executable_path/../Frameworks"; then
  run install_name_tool -add_rpath "@executable_path/../Frameworks" "$contents/MacOS/ardia"
fi

if [[ $link -eq 1 && $bundle_framework -eq 1 ]]; then
  say "signing only the binary (the framework is linked, not bundled)"
  run codesign --force --sign - "$contents/MacOS/ardia"
else
  say "signing ad hoc"
  run codesign --force --deep --sign - "$staging"
  run codesign --force --sign - --entitlements "$crate/resources/Ardia.entitlements" "$staging"
  run codesign --verify --deep --strict "$staging"
fi

if [[ $dry -eq 1 ]]; then
  run mkdir "$swap_lock"
else
  take_swap_lock
fi
run rm -rf "$app"
run mv "$staging" "$app"
run rmdir "$swap_lock"
holding_swap=0
run rmdir "$staging_root"
say "ready: $app"
