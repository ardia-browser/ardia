#!/usr/bin/env python3
"""Applies engine/patches/series to the published series base with no fuzz and no offset, without a Chromium tree.

  series-zero-fuzz.py [--platform linux|mac|all] [--cache DIR] [--tarball FILE]... [--base DIR] [--keep DIR]
                      [--offsets fail|warn] [--strict-since REF] [--strict PATCH]... [--refresh-offsets]

The base is the tree as Helium, its substitutions and our branding leave it (step 3), cut down to the files the series
touches: series-base-pack.py packs it on a builder and scripts/engine/series-bases.tsv pins it by Chromium version,
Helium commits, platform and CPU, as engine/patches/build/env.sh and helium-pins.ini give them. The archive is fetched
from its GitHub release into --cache (default $XDG_CACHE_HOME/ardia/series-base) and checked against the table's
sha256 and the manifest's per-file sha256. --tarball (one per platform) or --base (one platform) check a local archive
or base directory instead.

Each `chromium` line must apply with `git apply` and its exact context: a hunk that would need fuzz fails, naming the
patch, its series line, the file and the hunk. Each `layer` line runs its apply.sh on the scratch copy. A file a patch
changes that the archive lacks means the archive predates that patch: re-run series-base-pack.py on the builder.

A hunk that lands at an offset from the line its header gives fails when it does so on every platform checked that
applies the patch (a patch for both platforms can sit exactly on only one when platform-only steps shift its file).
With --offsets warn that holds only for the patches --strict names or that changed since --strict-since REF (git diff
REF HEAD), so a patch a pull request edits must land exactly while the others are listed. --refresh-offsets rewrites
those hunks' headers in place, nothing else; it needs --platform all.

Exit 0: every step applies strictly. 1: a step doesn't. 2: the base is missing, stale or invalid.
"""

import argparse
import contextlib
import io
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import series_base  # noqa: E402

DEFAULT_REPO = os.environ.get("ARDIA_SERIES_BASE_REPO", "ardia-browser/ardia")
REPACK = "re-run scripts/engine/series-base-pack.py on the builder (docs/engine-build.md, \"The series base archive\")"


class Result:
    def __init__(self, step):
        self.step = step
        self.problems = []
        self.offsets = []

    @property
    def ok(self):
        return not self.problems


def git_env(tree):
    return dict(os.environ, GIT_CEILING_DIRECTORIES=os.path.dirname(os.path.abspath(tree)), LC_ALL="C",
                GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")


def run_git_apply(args, patch, tree):
    return subprocess.run(["git", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn", *args,
                           os.path.abspath(patch)],
                          cwd=tree, env=git_env(tree), capture_output=True, text=True)


def parse_offsets(output):
    current, found = None, []
    for line in output.splitlines():
        checking = re.match(r"^Checking patch (.+)\.\.\.$", line)
        if checking:
            current = checking.group(1)
            continue
        hunk = re.match(r"^Hunk #(\d+) succeeded at (\d+) \(offset (-?\d+) lines?\)\.$", line)
        if hunk:
            found.append((current, int(hunk.group(1)), int(hunk.group(2)), int(hunk.group(3))))
    return found


split_hunks = series_base.split_hunks


def failing_hunks(patch, tree):
    text = pathlib.Path(patch).read_text(encoding="utf-8", errors="surrogateescape")
    out = []
    with tempfile.TemporaryDirectory(prefix="ac-hunk-") as scratch:
        for entry in split_hunks(text):
            for number, hunk in enumerate(entry["hunks"], 1):
                single = os.path.join(scratch, "hunk.patch")
                pathlib.Path(single).write_text("".join(entry["header"] + hunk), encoding="utf-8", errors="surrogateescape")
                result = run_git_apply(["--check", "--verbose"], single, tree)
                start = re.match(r"^@@ -(\d+)", hunk[0])
                where = f"{entry['path']} hunk #{number} (at line {start.group(1) if start else '?'})"
                if entry["old"] and not os.path.lexists(os.path.join(tree, entry["old"])):
                    out.append(f"{where}: {entry['old']} isn't in the scratch tree")
                    break
                if result.returncode:
                    out.append(f"{where}: doesn't apply without fuzz")
                else:
                    for _, _, line, offset in parse_offsets(result.stderr + result.stdout):
                        out.append(f"{where}: applies only at line {line}, offset {offset:+d}")
    return out


def apply_strict(patch, tree):
    problems = []
    result = run_git_apply(["--verbose"], patch, tree)
    output = result.stderr + result.stdout
    if result.returncode == 0:
        for skipped in re.findall(r"^Skipped patch '(.+)'\.$", output, re.M):
            problems.append(f"{skipped}: git apply skipped it")
        for warning in re.findall(r"^warning: (.+)$", output, re.M):
            problems.append(f"git apply warned: {warning}")
        return problems, parse_offsets(output)
    detail = failing_hunks(patch, tree)
    problems.extend(detail or ["git apply: " + line for line in output.strip().splitlines() if line.startswith("error:")])
    lenient = run_git_apply(["--reject"], patch, tree)
    for rej in pathlib.Path(tree).rglob("*.rej"):
        rej.unlink()
    if lenient.returncode and not detail:
        problems.append("the step's other hunks could not be applied either; later steps may fail because of it")
    return problems, []


def refresh_offsets(patch, offsets):
    text = pathlib.Path(patch).read_text(encoding="utf-8", errors="surrogateescape")
    lines = text.splitlines(keepends=True)
    moves = {(path, number): (line, offset) for path, number, line, offset in offsets}
    done = set()
    for entry in split_hunks(text):
        for number, start in enumerate(entry["starts"], 1):
            move = moves.get((entry["path"], number))
            if not move:
                continue
            line, offset = move
            head = re.match(r"^@@ -(\d+)((?:,\d+)?) \+(\d+)((?:,\d+)?) @@", lines[start])
            lines[start] = f"@@ -{int(head.group(1)) + offset}{head.group(2)} +{line}{head.group(4)} @@" + lines[start][head.end():]
            done.add((entry["path"], number))
    if done != set(moves):
        raise series_base.Problem(f"{patch}: couldn't place every offset hunk ({sorted(set(moves) - done)})")
    pathlib.Path(patch).write_text("".join(lines), encoding="utf-8", errors="surrogateescape")


def apply_layer(step, tree, env):
    result = subprocess.run([os.path.join(series_base.REPO, step.name, "apply.sh")], cwd=series_base.REPO,
                            env=dict(os.environ, **env, CHROMIUM_SRC=tree), capture_output=True, text=True)
    if result.returncode == 0:
        return []
    return [line for line in (result.stderr or result.stdout).strip().splitlines()] or [f"apply.sh exited {result.returncode}"]


def missing_from_base(steps, present):
    required, _ = series_base.base_paths(steps)
    return {path: step for path, step in required.items() if path not in present}


def missing_messages(missing):
    return [f"error: {path} (changed by {step}) isn't in the series base: {REPACK}" for path, step in sorted(missing.items())]


def check_tree(steps, tree, env=None, report=print):
    results = []
    for step in steps:
        result = Result(step)
        if step.kind == "chromium":
            result.problems, result.offsets = apply_strict(step.patch, tree)
        else:
            result.problems = apply_layer(step, tree, env or {})
        results.append(result)
        if report:
            label = "FAIL" if result.problems else "offs" if result.offsets else "ok  "
            report(f"{label} {step.kind} {step.name} (series:{step.line})")
            for problem in result.problems:
                report(f"       {problem}")
            for path, number, line, offset in result.offsets:
                report(f"       {path} hunk #{number}: lands at line {line}, offset {offset:+d}, not where its header says")
    return results


def judge(runs, strict, offsets="fail"):
    per_patch, paths = {}, {}
    for platform, results in runs:
        for result in results:
            if result.step.kind == "chromium" and not result.problems:
                paths[result.step.name] = result.step.patch
                per_patch.setdefault(result.step.name, {})[platform] = \
                    {(path, number): (line, offset) for path, number, line, offset in result.offsets}
    failing, warned, moves = {}, {}, {}
    for name, per in per_patch.items():
        everywhere = sorted(set.intersection(*(set(hunks) for hunks in per.values())))
        if not everywhere:
            continue
        verdict = [(path, number, {platform: hunks[(path, number)] for platform, hunks in per.items()})
                   for path, number in everywhere]
        (failing if offsets == "fail" or name in strict else warned)[name] = verdict
        first = next(iter(per.values()))
        moves[paths[name]] = [(path, number, *first[(path, number)]) for path, number in everywhere]
    return failing, warned, moves


def describe(verdict):
    return [f"{path} hunk #{number} lands at an offset on " +
            " and ".join(f"{platform} ({offset:+d})" for platform, (_, offset) in sorted(where.items()))
            for path, number, where in verdict]


def changed_patches(ref, repo=series_base.REPO):
    result = subprocess.run(["git", "-C", str(repo), "diff", "--name-only", ref, "HEAD", "--",
                             "engine/patches/*.patch"], capture_output=True, text=True)
    if result.returncode:
        raise series_base.Problem(f"git diff {ref} HEAD: {result.stderr.strip()}")
    prefix = "engine/patches/"
    return {line[len(prefix):] for line in result.stdout.splitlines() if line.startswith(prefix)}


def copy_capped(source, sink, limit):
    length = source.headers.get("Content-Length") if hasattr(source, "headers") else None
    if length and length.isdigit() and int(length) > limit:
        raise series_base.Problem(f"the download is {length} bytes, over the {limit} a series base may be")
    total = 0
    for chunk in iter(lambda: source.read(1 << 20), b""):
        total += len(chunk)
        if total > limit:
            raise series_base.Problem(f"the download passed {limit} bytes, more than a series base may be")
        sink.write(chunk)


def fetch(row, cache, repo):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, row["asset"])
    if os.path.exists(path) and series_base.sha256_file(path) == row["sha256"]:
        return path
    url = f"https://github.com/{repo}/releases/download/{row['tag']}/{row['asset']}"
    handle, partial = tempfile.mkstemp(prefix=row["asset"] + ".", suffix=".part", dir=cache)
    os.close(handle)
    try:
        with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as handle:
            copy_capped(response, handle, series_base.MAX_ARCHIVE_BYTES)
    except series_base.Problem:
        os.unlink(partial)
        raise
    except OSError as error:
        os.unlink(partial)
        raise series_base.Problem(f"couldn't download {url}: {error}")
    try:
        series_base.check_archive_size(partial)
    except series_base.Problem:
        os.unlink(partial)
        raise
    got = series_base.sha256_file(partial)
    if got != row["sha256"]:
        os.unlink(partial)
        raise series_base.Problem(f"{row['asset']} has sha256 {got}, but series-bases.tsv pins {row['sha256']}")
    os.replace(partial, path)
    return path


def stale_message(ident, table=series_base.TABLE):
    same_pins = [row for row in series_base.read_table(table)
                 if all(row[key] == ident[key] for key in series_base.IDENTITY if key != "inputs")]
    where = (f"{ident['platform']}/{ident['cpu']} at Chromium {ident['chromium']}, Helium {ident['helium_chromium'][:12]} + "
             f"{ident['helium_platform'][:12]}")
    if same_pins:
        return (f"step 3's inputs changed since the series base for {where} was packed (inputs "
                f"{same_pins[0]['inputs'][:12]}, now {ident['inputs'][:12]}): rebuild the builders' trees through step "
                f"3, then {REPACK} and publish it")
    return f"no series base for {where} in scripts/engine/series-bases.tsv: the pins moved, so {REPACK} and publish it"


def tree_digests(tree):
    out = {}
    for path in sorted(pathlib.Path(tree).rglob("*")):
        if path.is_file() and not path.is_symlink():
            out[path.relative_to(tree).as_posix()] = series_base.sha256_file(path)
    return out


def refresh_verified(moves, recheck, trees_before):
    originals = {patch: pathlib.Path(patch).read_bytes() for patch in moves}
    kept = False
    try:
        for patch, offsets in sorted(moves.items()):
            refresh_offsets(patch, offsets)
        codes, trees_after, failing = recheck()
        problems = []
        if max(codes, default=0):
            problems.append("a platform's check fails with the rewritten headers")
        for platform, tree in sorted(trees_before.items()):
            after = trees_after.get(platform, {})
            if after != tree:
                changed = sorted(path for path in set(tree) | set(after) if tree.get(path) != after.get(path))
                problems.append(f"on {platform} the rewritten headers change what the series produces "
                                f"({', '.join(changed[:5]) or 'the tree'}): a hunk would land on another identical "
                                "context")
        if failing:
            problems.append(f"{len(failing)} patches still land hunks at an offset on every platform")
        kept = not problems
        return problems
    finally:
        if not kept:
            for patch, text in originals.items():
                pathlib.Path(patch).write_bytes(text)


def tarball_for(tarballs, platform):
    for tarball in tarballs:
        if series_base.read_manifest(tarball).get("platform") == platform:
            return tarball
    raise series_base.Problem(f"no --tarball for {platform}")


def stage_base(args, ident, scratch):
    if args.base:
        for path in series_base.base_paths(args.steps)[0].keys() | series_base.base_paths(args.steps)[1].keys():
            source = os.path.join(args.base, path)
            if os.path.lexists(source):
                os.makedirs(os.path.dirname(os.path.join(scratch, path)), exist_ok=True)
                shutil.copy2(source, os.path.join(scratch, path), follow_symlinks=False)
        return {"source": args.base, "files": {}}
    if args.tarball:
        tarball = tarball_for(args.tarball, ident["platform"])
    else:
        row = series_base.find_row(ident)
        if row is None:
            raise series_base.Problem(stale_message(ident))
        tarball = fetch(row, args.cache, args.repo)
    manifest = series_base.extract(tarball, scratch)
    series_base.require_provenance(manifest, tarball)
    for key in series_base.IDENTITY:
        if manifest.get(key) != ident[key]:
            raise series_base.Problem(f"{tarball} is for {key} {manifest.get(key)}, not {ident[key]}")
    return dict(manifest, source=tarball)


def check_platform(args, platform):
    series = series_base.load_series()
    cpu = args.cpu or series_base.DEFAULT_CPU[platform]
    env = series.configuration(platform, cpu)
    steps = series.read_series(platform)
    args.steps = steps
    ident = series_base.identity(platform, cpu)
    print(f"== {platform}/{cpu}: {len(steps)} steps on Chromium {ident['chromium']}, Helium "
          f"{ident['helium_chromium'][:12]} + {ident['helium_platform'][:12]}")
    scratch = tempfile.mkdtemp(prefix=f"ac-series-{platform}-", dir=args.keep)
    try:
        try:
            manifest = stage_base(args, ident, scratch)
        except series_base.Problem as error:
            print(f"error: {error}")
            return 2, []
        print(f"base: {manifest['source']}")
        present = set(manifest["files"]) if not args.base else \
            {p for p in series_base.base_paths(steps)[0] if os.path.lexists(os.path.join(scratch, p))}
        missing = missing_from_base(steps, present)
        for message in missing_messages(missing):
            print(message)
        results = check_tree(steps, scratch, env)
        failed = [r for r in results if not r.ok]
        if missing:
            print(f"STALE BASE: {len(missing)} files the series changes aren't in the archive")
            return 2, results
        if failed:
            print(f"FAIL: {len(failed)} of {len(steps)} steps need fuzz or don't apply")
            return 1, results
        print(f"{platform}: all {len(steps)} steps apply with zero fuzz")
        args.final_trees[platform] = tree_digests(scratch)
        return 0, results
    finally:
        if args.keep:
            print(f"scratch kept: {scratch}")
        else:
            shutil.rmtree(scratch, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--platform", choices=("linux", "mac", "all"), default="all")
    parser.add_argument("--cpu", choices=("arm64", "x64"))
    parser.add_argument("--cache", default=os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                                                        "ardia", "series-base"))
    parser.add_argument("--repo", default=DEFAULT_REPO, help="GitHub repo holding the release (default %(default)s)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--tarball", action="append", default=[], help="a local series base archive, one per platform")
    source.add_argument("--base", help="a local series base directory (AC_SERIES_BASE) instead of an archive")
    parser.add_argument("--keep", metavar="DIR", help="keep each scratch tree under DIR")
    parser.add_argument("--offsets", choices=("fail", "warn"), default="fail")
    parser.add_argument("--strict", action="append", default=[], metavar="PATCH",
                        help="with --offsets warn, a patch whose offsets still fail")
    parser.add_argument("--strict-since", metavar="REF", help="with --offsets warn, patches changed since REF still fail")
    parser.add_argument("--refresh-offsets", action="store_true")
    args = parser.parse_args()
    args.strict = set(args.strict)
    args.final_trees = {}
    if args.strict_since:
        try:
            args.strict |= changed_patches(args.strict_since)
        except series_base.Problem as error:
            series_base.die(str(error), 2)
        if args.offsets == "warn":
            print(f"patches changed since {args.strict_since}: {', '.join(sorted(args.strict)) or 'none'}")
    platforms = ["linux", "mac"] if args.platform == "all" else [args.platform]
    if (args.base or args.cpu) and len(platforms) > 1:
        parser.error("--base and --cpu need one --platform")
    if args.refresh_offsets and len(platforms) < 2:
        parser.error("--refresh-offsets needs --platform all: a patch for both platforms is judged on both")
    if args.keep:
        os.makedirs(args.keep, exist_ok=True)
    try:
        runs = [(platform, check_platform(args, platform)) for platform in platforms]
    except series_base.Problem as error:
        series_base.die(str(error), 2)
    codes = [code for _, (code, _) in runs]
    failing, warned, moves = judge([(platform, results) for platform, (_, results) in runs], args.strict, args.offsets)
    if warned:
        print(f"== warning: {len(warned)} patches you didn't change land "
              f"{sum(len(v) for v in warned.values())} hunks at an offset on every platform that applies them; "
              "--refresh-offsets rewrites their headers")
    for name, verdict in sorted(failing.items()):
        print(f"FAIL offset {name}")
        for line in describe(verdict):
            print(f"       {line}")
    if args.refresh_offsets and max(codes) == 0 and moves:
        trees_before = dict(args.final_trees)

        def recheck():
            args.final_trees = {}
            with contextlib.redirect_stdout(io.StringIO()):
                again = [(platform, check_platform(args, platform)) for platform in platforms]
                still, _, _ = judge([(platform, results) for platform, (_, results) in again], set())
            return [code for _, (code, _) in again], args.final_trees, still

        problems = refresh_verified(moves, recheck, trees_before)
        for problem in problems:
            print(f"FAIL refresh: {problem}")
        if problems:
            print("left every patch as it was")
            codes.append(1)
        else:
            for patch, offsets in sorted(moves.items()):
                print(f"refreshed {len(offsets)} hunk headers in {os.path.basename(patch)}")
            print("checked again on every platform: the series produces the same files, every hunk landing exactly on "
                  "at least one platform")
            failing = {}
    if args.refresh_offsets and max(codes):
        print("not refreshing: a platform's check failed, so its offsets are unknown")
    if failing:
        print(f"FAIL: {len(failing)} patches land hunks at an offset on every platform that applies them")
        codes.append(1)
    if max(codes) == 0:
        print(f"OK: {', '.join(platforms)}: every step applies with zero fuzz, and every hunk lands exactly on at least "
              "one platform" + (" (offsets above are warnings)" if warned else ""))
    sys.exit(max(codes))


if __name__ == "__main__":
    main()
