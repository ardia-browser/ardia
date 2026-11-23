#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin="${TMPDIR:-/tmp}/ardia-delivered-fixtures"
if [[ ! -x "$bin" || "$here/main.swift" -nt "$bin" || "$here/VaultDeliveredFixtures.swift" -nt "$bin" ]]; then
  xcrun swiftc -O -suppress-warnings "$here/VaultDeliveredFixtures.swift" "$here/main.swift" -o "$bin"
fi
exec "$bin" "$@"
