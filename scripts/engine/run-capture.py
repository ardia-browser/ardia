#!/usr/bin/env python3
"""Runs `series.py capture-base` (every argument passed through unchanged) and records what it captured.

  run-capture.py [--platform linux|mac] [--cpu arm64|x64] [--force]

Run it after run-step3.py and before step 4 (04-series.sh runs capture-base again, which then adds nothing to a
base this captured). The tree
is CHROMIUM_SRC, else AC_CHROMIUM_BUILD's (default ~/chromium-build) chromium_git/chromium/src. The base is
AC_SERIES_BASE, else that build directory's series-base for the platform. Both are passed to series.py explicitly, so
the child captures from the tree whose stamp is recorded.

It captures once per step-3 run. It refuses when:
- the tree has no complete step-3 stamp;
- a capture for this stamp is already recorded beside the tree (<tree's parent>/.ardia-capture-<tree name>.json),
  which deleting the base doesn't undo;
- the base already holds files;
- the tree already carries any series step: engine/chromium's layer directory, or a patch that reverse-applies.
A new capture needs a fresh tree and a new run-step3.py run. Nothing is written or deleted before capture-base runs,
and the child's exit code and output pass through unchanged. Once capture-base exits 0, <base>/.ardia-capture.json
records the stamp's sha256 and every base file's sha256 and mode, and the marker beside the tree records the stamp.
series-base-pack.py packs only a base whose files match that record exactly.
"""

import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402

sys.path.insert(0, str(series_base.BUILD))
from target_config import configuration  # noqa: E402


def option(argv, name):
    for index, token in enumerate(argv):
        if token == name and index + 1 < len(argv):
            return argv[index + 1]
        if token.startswith(name + "="):
            return token.split("=", 1)[1]
    return None


def complete_stamp(src):
    stamp = series_base.step3_stamp(src)
    if not stamp.is_file():
        return None
    try:
        record = json.loads(stamp.read_text())
    except ValueError:
        return None
    return stamp if record.get("state") == "complete" else None


def captured_marker(src):
    tree = pathlib.Path(src)
    return tree.parent / f".ardia-capture-{tree.name}.json"


def series_started(src, steps):
    if os.path.isdir(os.path.join(src, "chrome/browser/ardia")):
        return "engine/chromium's layer (chrome/browser/ardia is in the tree)"
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    for step in steps:
        if step.kind != "chromium":
            continue
        check = subprocess.run(["git", "apply", "--check", "-R", "--whitespace=nowarn", step.patch], cwd=src, env=env,
                               capture_output=True)
        if check.returncode == 0:
            return step.name
    return None


def write_record(base, stamp_sha, files):
    path = os.path.join(base, series_base.CAPTURE_RECORD)
    partial = f"{path}.{os.getpid()}.tmp"
    with open(partial, "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"step3_stamp_sha256": stamp_sha, "files": files}, indent=1, sort_keys=True) + "\n")
    os.replace(partial, path)


def run(argv, series=None, steps=None):
    try:
        target = configuration(option(argv, "--platform"), option(argv, "--cpu"))
    except ValueError as error:
        series_base.die(str(error), 2)
    src = os.path.realpath(series_base.default_src())
    base = series_base.default_base(target["AC_TARGET_OS"], target["AC_TARGET_CPU"])
    stamp = complete_stamp(src)
    if stamp is None:
        series_base.die(f"no complete step-3 stamp for {src}: run step 3 through scripts/engine/run-step3.py on a fresh "
                        "tree first", 2)
    stamp_sha = series_base.sha256_file(stamp)
    marker = captured_marker(src)
    if marker.is_file() and stamp_sha in marker.read_text():
        series_base.die(f"{marker}: this step-3 run already has its capture; a new capture needs a fresh tree and a new "
                        "run-step3.py run", 2)
    if os.path.isdir(base) and series_base.base_file_hashes(base):
        series_base.die(f"{base} already holds files: set it aside, so the capture is the only thing in it", 2)
    if steps is None:
        steps = series_base.load_series().read_series(target["AC_TARGET_OS"])
    started = series_started(src, steps)
    if started:
        series_base.die(f"{src} already carries the series ({started}): a capture needs the tree as step 3 left it, so "
                        "start again from a fresh tree", 2)
    env = dict(os.environ, CHROMIUM_SRC=src, AC_SERIES_BASE=os.path.abspath(base))
    code = subprocess.run([sys.executable, str(series or series_base.REPO / "engine/patches/series.py"), "capture-base",
                           *argv], env=env).returncode
    if code:
        return code
    if series_base.sha256_file(stamp) != stamp_sha:
        series_base.die(f"{stamp} changed while capture-base ran: run step 3 again on a fresh tree", 2)
    write_record(base, stamp_sha, series_base.base_file_hashes(base))
    partial = marker.with_name(f"{marker.name}.{os.getpid()}.tmp")
    partial.write_text(json.dumps({"step3_stamp_sha256": stamp_sha}, sort_keys=True) + "\n")
    os.replace(partial, marker)
    print(f"run-capture: recorded {base}/{series_base.CAPTURE_RECORD}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] in (["-h"], ["--help"]):
        print(__doc__)
        sys.exit(0)
    sys.exit(run(sys.argv[1:]))
