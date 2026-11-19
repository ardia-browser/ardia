chromium_src="${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}"
ardia_arch="${ARDIA_ARCH:-arm64}"
case "$ardia_arch" in
  arm64) chromium_out="out/Release_GN_arm64" ;;
  x86_64)
    chromium_out="out/Release_GN_x64"
    export AC_TARGET_CPU=x64
    ;;
  *) echo "error: ARDIA_ARCH is arm64 or x86_64, got '$ardia_arch'" >&2; exit 64 ;;
esac
engine_suffix=""
[ "$ardia_arch" = arm64 ] || engine_suffix="-$ardia_arch"
chromium_framework="${ARDIACORE_FRAMEWORK:-$chromium_src/$chromium_out/Chromium Framework.framework}"
