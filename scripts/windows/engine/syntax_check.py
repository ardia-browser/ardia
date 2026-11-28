#!/usr/bin/env python3
"""Compile-check Windows engine sources without building: each file runs through its target's real clang-cl line
from the out dir's .ninja files with -fsyntax-only, so nothing under out/ is written and siso's state is untouched.
Use it when the Windows tree is behind the checkout (its //ardia/win copy or its series is older) and a full
04-series.sh plus 05-build.sh would rebuild far more than the change: this checkout's scripts/windows/engine/src,
engine/ardiacore-linux/src and engine/ardiacore-desktop/src are searched before the tree's own copies, so the
checkout's headers win. A //ardia/win source is named by its path under scripts/windows/engine/src (ardia/win/...);
any other file is checked as the tree source named by --as, so a patched scratch copy of a Chromium file compiles
with that file's flags (and the same shadowing, for its //ardia includes).

Usage: scripts/windows/engine/syntax_check.py [--repo DIR] [--out DIR] SOURCE... | --as TREE_PATH SCRATCH_FILE
  --repo  the checkout whose sources shadow the tree's (default: the one holding this script)
  --out   the out dir (default: $AC_CHROMIUM_BUILD or ~/chromium-build-win, chromium_git/chromium/src/out/
          Release_GN_win_$WIN_CPU, WIN_CPU defaulting to x64)
  --as    check SCRATCH_FILE with the flags of the tree source TREE_PATH (e.g. chrome/browser/ui/views/frame/browser_view.cc)
Exits 1 when any file has an error, printing the first errors of each.
"""
import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

MODULE_FLAGS = {"-fmodules", "/clang:-fno-implicit-module-maps", "-fno-implicit-modules",
                "-fmodules-local-submodule-visibility"}
DROPPED_PREFIXES = ("-fmodule-file=", "-fmodule-map-file=", "-fmodule-name=", "/Fo", "/Fd", "/showIncludes")
SHADOWED_ROOTS = ("scripts/windows/engine/src", "engine/ardiacore-linux/src", "engine/ardiacore-desktop/src")


def ninja_variables(path):
    found = {}
    for line in path.read_text().splitlines():
        match = re.match(r"^(\w+) = (.*)$", line)
        if match:
            found[match.group(1)] = match.group(2)
    return found


def cxx_rule(out):
    lines = (out / "toolchain.ninja").read_text().splitlines()
    for index, line in enumerate(lines):
        if line == "rule cxx":
            for body in lines[index + 1:]:
                if body.strip().startswith("command ="):
                    return body.split("=", 1)[1].strip()
    raise SystemExit("syntax_check.py: no cxx rule in toolchain.ninja")


def ninja_for(out, tree_path):
    needle = f"../../{tree_path}"
    for ninja in (out / "obj").rglob("*.ninja"):
        text = ninja.read_text(errors="replace")
        if needle + " " in text or needle + "\n" in text:
            return ninja
    raise SystemExit(f"syntax_check.py: no .ninja file builds {tree_path}")


def command(rule, variables, source, shadow):
    line = (rule.replace("${defines}", variables.get("defines", ""))
            .replace("${include_dirs}", "\0INCLUDES\0 " + variables.get("include_dirs", ""))
            .replace("${cflags}", variables.get("cflags", ""))
            .replace("${cflags_cc}", variables.get("cflags_cc", ""))
            .replace("${module_deps}", "")
            .replace("${in}", "\0SOURCE\0")
            .replace("$:", ":"))
    kept = []
    for token in shlex.split(line):
        if token == "\0INCLUDES\0":
            kept.extend(f"-I{root}" for root in shadow)
            continue
        if token == "\0SOURCE\0":
            kept.append(str(source))
            continue
        if token in MODULE_FLAGS or token.startswith(DROPPED_PREFIXES) or "${" in token:
            if kept and kept[-1] == "-Xclang":
                kept.pop()
            continue
        kept.append(token)
    return kept + ["-fsyntax-only"]


def check(out, rule, tree_path, source, shadow):
    variables = ninja_variables(ninja_for(out, tree_path))
    result = subprocess.run(command(rule, variables, source, shadow), cwd=out, capture_output=True, text=True)
    errors = [line for line in (result.stdout + result.stderr).splitlines() if "error" in line]
    print(f"{tree_path}: {'ok' if result.returncode == 0 else f'{len(errors)} errors'}")
    for line in errors[:12]:
        print(f"    {line[:400]}")
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("-h", "--help", action="store_true")
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[3]))
    parser.add_argument("--out")
    parser.add_argument("--as", dest="tree_path")
    parser.add_argument("sources", nargs="*")
    args = parser.parse_args()
    if args.help or not args.sources:
        print(__doc__.strip())
        return 0 if args.help else 64
    build = Path(os.environ.get("AC_CHROMIUM_BUILD", Path.home() / "chromium-build-win"))
    out = Path(args.out) if args.out else build / "chromium_git/chromium/src/out" / f"Release_GN_win_{os.environ.get('WIN_CPU', 'x64')}"
    repo = Path(args.repo).resolve()
    shadow = [repo / root for root in SHADOWED_ROOTS]
    rule = cxx_rule(out)
    passed = True
    if args.tree_path:
        if len(args.sources) != 1:
            raise SystemExit("syntax_check.py: --as takes exactly one scratch file")
        passed = check(out, rule, args.tree_path, Path(args.sources[0]).resolve(), shadow)
    else:
        for source in args.sources:
            relative = Path(source)
            passed &= check(out, rule, relative.as_posix(), repo / "scripts/windows/engine/src" / relative, shadow)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
