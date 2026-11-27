#!/usr/bin/env bash
# Fails a release whose build settings would compile in Debug-only code: DEBUG, and with it the dev-only Mac WebUI shell.
#
#   scripts/release/no-debug-build.sh --settings [<build setting>…]   refuses extra build settings that define DEBUG or
#                                                                      name ARDIA_SHELL or ARDIA_WEBUI
#   scripts/release/no-debug-build.sh --effective [--require-targets A,B]
#                                                                      reads one `xcodebuild -showBuildSettings` output,
#                                                                      stdout and stderr, on stdin. It fails when any
#                                                                      target defines DEBUG, when xcodebuild couldn't read
#                                                                      some settings or dropped the destination, when a
#                                                                      target lists no settings or isn't a macOS Release
#                                                                      build, or when a required target is missing
set -euo pipefail

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
DEBUG_TOKEN='(^|[^A-Za-z0-9_])(-D ?)?DEBUG([^A-Za-z0-9_]|$)'

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  --settings)
    shift
    refused=0
    for setting in "$@"; do
      if [[ "$setting" =~ $DEBUG_TOKEN ]] || [[ "$setting" == *ARDIA_SHELL* ]] || [[ "$setting" == *ARDIA_WEBUI* ]]; then
        echo "no-debug-build: release build setting $setting would compile in Debug-only code" >&2
        refused=1
      fi
    done
    exit "$refused"
    ;;
  --effective)
    required=""
    if [ "${2:-}" = --require-targets ]; then
      [ -n "${3:-}" ] || { usage >&2; exit 2; }
      required=$3
    fi
    awk -v token="$DEBUG_TOKEN" -v required="$required" '
      /Could not get build settings|xcodebuild: error|Ignoring provided run destination|^[ \t]*(xcodebuild:[ \t]+)?error:([ \t]|$)/ {
        print "no-debug-build: xcodebuild did not give every setting: " $0 > "/dev/stderr"; bad++; next
      }
      /^Build settings for action / { target = $0; sub(/^.* and target "?/, "", target); sub(/"?:$/, "", target); targets++; name[targets] = target; seen[target] = 1; next }
      targets && /^[ \t]+[A-Za-z_][A-Za-z0-9_]* = / { settings[targets]++ }
      targets && /^[ \t]+CONFIGURATION = / { configuration[targets] = $3 }
      targets && /^[ \t]+SDK_NAME = / { sdk[targets] = $3 }
      /^[ \t]+([A-Z_]*PREPROCESSOR_DEFINITIONS[A-Z_]*|SWIFT_ACTIVE_COMPILATION_CONDITIONS|OTHER_SWIFT_FLAGS|OTHER_CFLAGS|OTHER_CPLUSPLUSFLAGS) = / {
        value = $0; sub(/^[ \t]+[A-Z_]+ = /, "", value)
        if (value ~ token) { key = $1; print "no-debug-build: target " target " defines DEBUG in " key > "/dev/stderr"; bad++ }
      }
      END {
        if (!targets) { print "no-debug-build: no build settings to check" > "/dev/stderr"; exit 1 }
        n = split(required, wanted, ",")
        for (i = 1; i <= n; i++) if (!(wanted[i] in seen)) { print "no-debug-build: the build settings have no target " wanted[i] > "/dev/stderr"; bad++ }
        for (i = 1; i <= targets; i++) {
          t = name[i] " (block " i ")"
          if (!settings[i]) { print "no-debug-build: target " t " lists no settings" > "/dev/stderr"; bad++; continue }
          if (configuration[i] != "Release") { print "no-debug-build: target " t " is configured " (configuration[i] == "" ? "nothing" : configuration[i]) ", not Release" > "/dev/stderr"; bad++ }
          if (sdk[i] !~ /^macosx/) { print "no-debug-build: target " t " builds for " (sdk[i] == "" ? "no SDK" : sdk[i]) ", not macOS" > "/dev/stderr"; bad++ }
        }
        exit bad ? 1 : 0
      }'
    ;;
  *) usage >&2; exit 2 ;;
esac
