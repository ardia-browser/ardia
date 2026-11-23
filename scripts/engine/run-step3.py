#!/usr/bin/env python3
"""Runs step 3 (engine/patches/build/03-helium.py, every argument passed through unchanged) and stamps a full run.

  run-step3.py --apply [--platform linux|mac] [--tree DIR] [other 03-helium.py arguments]

The child's exit code and output pass through unchanged, and nothing is written or deleted before it exits. Once it
exits 0, the tree's stamp (<tree's parent>/.ardia-step3-<tree name>.json) is replaced by a new one when all of these
hold, and deleted otherwise:
- that one run started on a tree no step-3 stage had touched, and finished every stage;
- it neither narrowed nor changed step 3 (no --only, --from or --no-brand);
- the step-3 input digest (series_base.step3_digest) was the same before and after.

The stamp holds the tree's inode, the platform, the digest, the stage marker's sha256 and an id of its own.
series-base-pack.py packs only from a tree whose stamp still matches its marker, so a run that fails after starting
work leaves a stamp the marker no longer matches, and a run that fails its own checks changes nothing.
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402

sys.path.insert(0, str(series_base.BUILD))
from target_config import configuration  # noqa: E402


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise argparse.ArgumentError(None, message)


def helium_arguments(argv):
    parser = QuietParser(add_help=False)
    for name in ("--tree", "--helium", "--platform", "--cpu", "--helium-linux", "--helium-macos", "--domsub-cache",
                 "--work", "--report"):
        parser.add_argument(name)
    parser.add_argument("--only", default="")
    parser.add_argument("--from", dest="start")
    parser.add_argument("--no-brand", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--guard-extra", action="append", default=[])
    try:
        known, unknown = parser.parse_known_args(argv)
    except argparse.ArgumentError:
        return None
    return None if unknown else known


def stages_done(tree):
    marker = series_base.stage_marker(tree)
    if not os.path.isdir(tree) or not marker.is_file():
        return set()
    tokens = marker.read_text().split()
    if tokens[:1] != [f"tree-inode={os.stat(tree).st_ino}"]:
        return set()
    return set(tokens[1:])


def write_stamp(tree, platform, digest):
    path = series_base.step3_stamp(tree)
    record = {"state": "complete", "tree_inode": os.stat(tree).st_ino, "platform": platform, "inputs": digest,
              "marker_sha256": hashlib.sha256(series_base.stage_marker(tree).read_bytes()).hexdigest(),
              "run": uuid.uuid4().hex}
    partial = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    partial.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n")
    os.replace(partial, path)


def stampable(before, after, platform, digest_before, digest_after, arguments):
    mutating = set(series_base.STEP3_STAGES)
    full = arguments is not None and not arguments.only and not arguments.start and not arguments.no_brand
    return (full and not (before & mutating) and mutating <= after and f"platform={platform}" in after and
            digest_before is not None and digest_before == digest_after)


def digest_or_none():
    try:
        return series_base.step3_digest()
    except series_base.Problem:
        return None


def run(argv, helium=None):
    arguments = helium_arguments(argv)
    tree = platform = None
    if arguments is not None:
        try:
            platform = configuration(arguments.platform, arguments.cpu)["AC_TARGET_OS"]
        except ValueError:
            platform = None
        build = os.environ.get("AC_CHROMIUM_BUILD") or os.path.expanduser("~/chromium-build")
        tree = os.path.realpath(arguments.tree or os.environ.get("CHROMIUM_SRC") or
                                os.path.join(build, "chromium_git/chromium/src"))
    digest_before = digest_or_none()
    before = stages_done(tree) if tree else set()
    code = subprocess.run([sys.executable, str(helium or series_base.BUILD / "03-helium.py"), *argv]).returncode
    if code or tree is None:
        return code
    if platform and stampable(before, stages_done(tree), platform, digest_before, digest_or_none(), arguments):
        write_stamp(tree, platform, digest_before)
        print(f"run-step3: stamped {series_base.step3_stamp(tree)} (inputs {digest_before[:12]})", file=sys.stderr)
    elif stages_done(tree) != before:
        series_base.step3_stamp(tree).unlink(missing_ok=True)
        print(f"run-step3: no stamp: only one full run on a fresh tree with plain arguments is stamped, so "
              f"series-base-pack.py won't pack {tree}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] in (["-h"], ["--help"]):
        print(__doc__)
        sys.exit(0)
    sys.exit(run(sys.argv[1:]))
