#!/bin/sh
state="${FAKE_STATE_DIR:-${TMPDIR:-/tmp}}"
password="correct horse battery staple"
key="fakesession0123456789abcdefKEY"
case "$1" in
  --version) echo "fake-cli 2025.10.0" ;;
  status)
    if [ "$BW_SESSION" = "$key" ]; then echo '{"status":"unlocked","userEmail":"a@example.com"}'
    elif [ -f "$state/signed-in" ]; then echo '{"status":"locked","userEmail":"a@example.com"}'
    else echo '{"status":"unauthenticated"}'; fi ;;
  login|unlock)
    if [ "$ARDIA_BW_PASSWORD" = "$password" ]; then
      touch "$state/signed-in"
      echo "You are logged in!"
      echo ""
      echo "$key"
    else
      echo "Username or password is incorrect. Try again. ($ARDIA_BW_PASSWORD)" >&2
      exit 1
    fi ;;
  lock) rm -f "$state/unlocked"; echo "Your vault is locked." ;;
  list)
    if [ "$BW_SESSION" != "$key" ]; then echo "Vault is locked." >&2; exit 1; fi
    count="${2:-3}"
    awk -v n="$count" 'BEGIN { printf "["; for (i = 1; i <= n; i++) { if (i > 1) printf ","; printf "{\"id\":\"item-%d\",\"name\":\"Site %d\",\"login\":{\"username\":\"user%d\",\"password\":\"pw-%d-secret\",\"uris\":[{\"uri\":\"https://site%d.example\"}]}}", i, i, i, i, i } printf "]\n" }' ;;
  get)
    if [ "$BW_SESSION" != "$key" ]; then echo "Vault is locked." >&2; exit 1; fi
    case "$3" in item-*) echo "pw-${3#item-}-secret" ;; *) echo "Not found." >&2; exit 1 ;; esac ;;
  sleep) echo $$ > "$state/sleeping.pid"; sleep "${2:-30}"; echo done ;;
  stream) i=1; while [ $i -le "${2:-3}" ]; do echo "line $i"; i=$((i + 1)); sleep 0.05; done; echo "warning $i" >&2 ;;
  env) env | sort ;;
  echo) echo "rejected $ARDIA_BW_PASSWORD" >&2; exit 2 ;;
  *) echo "unknown command $1" >&2; exit 64 ;;
esac
