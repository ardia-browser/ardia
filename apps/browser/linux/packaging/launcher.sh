here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
binary="$here/ardia.bin"
export ARDIA_LAUNCHER="${APPIMAGE:-$(readlink -f "${BASH_SOURCE[0]}")}"
for argument in "$@"; do
  if [[ "$argument" == --no-sandbox ]]; then
    export ARDIA_SANDBOX_REASON="--no-sandbox was passed"
    exec -a ardia "$binary" "--ardia-sandbox-decision=$ARDIA_SANDBOX_REASON" "$@"
  fi
done
ardia_sandbox_decide "$binary"
decision=()
[[ ${#ARDIA_SANDBOX_FLAGS[@]} -gt 0 ]] && decision=("--ardia-sandbox-decision=$ARDIA_SANDBOX_REASON")
exec -a ardia "$binary" "${ARDIA_SANDBOX_FLAGS[@]}" "${decision[@]}" "$@"
