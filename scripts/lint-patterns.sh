#!/usr/bin/env bash
# Usage: scripts/lint-patterns.sh [--test] [paths...]
# Runs the ast-grep rules in tools/lint-rules over crates/ (third_party is ignored) and exits 1 on any error-level finding.
# Warnings are printed and counted but do not fail. Findings listed in tools/lint-rules/pending.txt ("<rule> <path> <reason>")
# are reported as pending, for code another change is replacing. --test also runs each rule's valid/invalid snippets first.
# Install ast-grep with `brew install ast-grep` (or `cargo install ast-grep --locked`).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v ast-grep >/dev/null 2>&1; then
  echo "lint-patterns: ast-grep is not installed; run: brew install ast-grep" >&2
  exit 2
fi

run_tests=0
paths=()
for arg in "$@"; do
  case "$arg" in
    --test) run_tests=1 ;;
    -h|--help) sed -n '2,6s/^# \{0,1\}//p' "$0"; exit 0 ;;
    *) paths+=("$arg") ;;
  esac
done
[ ${#paths[@]} -eq 0 ] && paths=(crates)

if [ "$run_tests" -eq 1 ]; then
  ast-grep test --skip-snapshot-tests >/tmp/lint-patterns-test.$$ 2>&1 || { cat /tmp/lint-patterns-test.$$; rm -f /tmp/lint-patterns-test.$$; exit 1; }
  rm -f /tmp/lint-patterns-test.$$
fi

ast-grep scan --json=stream "${paths[@]}" 2>/dev/null | node -e '
const fs = require("fs");
const pending = new Map();
try {
  for (const line of fs.readFileSync("tools/lint-rules/pending.txt", "utf8").split("\n")) {
    const [rule, path, ...reason] = line.trim().split(/\s+/);
    if (rule && path) pending.set(`${rule} ${path}`, reason.join(" "));
  }
} catch {}
const lines = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
const counts = {};
let errors = 0, warnings = 0, held = 0;
for (const line of lines) {
  const m = JSON.parse(line);
  const where = `${m.file}:${m.range.start.line + 1}`;
  const first = m.lines.split("\n")[0].trim().slice(0, 120);
  const key = `${m.ruleId} ${m.file}`;
  counts[m.ruleId] = (counts[m.ruleId] || 0) + 1;
  if (pending.has(key)) {
    held += 1;
    console.log(`pending[${m.ruleId}]: ${where}  ${first}\n  (${pending.get(key)})`);
  } else if (m.severity === "error") {
    errors += 1;
    console.log(`error[${m.ruleId}]: ${m.message}\n  --> ${where}  ${first}\n  = ${m.note || ""}\n`);
  } else {
    warnings += 1;
    console.log(`warning[${m.ruleId}]: ${m.message}\n  --> ${where}  ${first}\n`);
  }
}
const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${rule}=${n}`).join(" ");
console.log(`lint-patterns: ${errors} error(s), ${warnings} warning(s), ${held} pending${summary ? " [" + summary + "]" : ""}`);
process.exit(errors > 0 ? 1 : 0);
'
