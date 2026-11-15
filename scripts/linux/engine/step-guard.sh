step_name=$(basename "$0")
case "${1:-}" in
  -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
  --apply) ;;
  *) echo "$step_name: it changes $AC_CHROMIUM_BUILD: pass --apply to run it (--help for usage)" >&2; exit 64 ;;
esac
step_refuse() { echo "$step_name: $*" >&2; exit 64; }
step_why=$(python3 "$AC_MAC_BUILD_DIR/pathguard.py" build-root "$AC_CHROMIUM_BUILD") ||
  step_refuse "the build root $AC_CHROMIUM_BUILD must be a scratch root of its own: ${step_why:-unreadable}"
mkdir -p "$(dirname "$AC_LINUX_LOCK")"
if [[ "${AC_LINUX_LOCK_HELD:-}" != "$AC_LINUX_LOCK" ]] || flock -n "$AC_LINUX_LOCK" true; then
  AC_LINUX_LOCK_HELD="$AC_LINUX_LOCK" exec flock -w "${AC_LOCK_WAIT:-500}" -E 75 "$AC_LINUX_LOCK" "$0" "$@"
fi
mkdir -p "$CB/logs"
step_started=$(date +%s)
step_log_time() { echo "$step_name $1 $(( $(date +%s) - step_started )) s" >>"$CB/logs/step-times.log"; }
trap 'step_log_time "exit=$?"' EXIT
echo "$step_name started $(date -Is)" >>"$CB/logs/step-times.log"
unset step_why
