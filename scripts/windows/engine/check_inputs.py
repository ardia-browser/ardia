#!/usr/bin/env python3
"""Checks, without a Chromium tree, that the shared engine inputs still make a Windows engine build the way
series_win.py takes them, and lists every problem with the file and line it comes from:

- the patch lists (engine/patches/series, scripts/windows/engine/series-win) parse, each patch Windows applies exists,
  each `skip` names a shared patch, and the patches Windows applies, in order, are accepted-patches.txt;
- ardia-layer-win.patch applies to engine/chromium/src/chrome/browser/ardia without fuzz;
- the layer's BUILD.gn has what the Windows build file is made from, the sources Windows compiles from it are
  accepted-layer-sources.txt and all exist, and every engine call in the Windows call table is defined in one of them;
- engine/ardiacore's ac_launch_switches.cc still has what launch_switches_source() turns into the Windows copy.

A change to an accepted list is accepted on purpose: run with --accept and commit the lists. --accept writes
nothing and fails when any input can't be read.

Usage: check_inputs.py [--accept]
"""
import argparse
import difflib
import os
import re
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import series_win as build

ACCEPTED_PATCHES = os.path.join(build.HERE, 'accepted-patches.txt')
ACCEPTED_SOURCES = os.path.join(build.HERE, 'accepted-layer-sources.txt')
CALL = re.compile(r'^AC_(?:PROFILE|ARGS|ENGINE)_CALL\((ac_\w+)', re.M)


def attempt(problems, step):
    try:
        return step()
    except build.InputError as error:
        problems.append(str(error))
    except SystemExit as error:
        problems.append(str(error.code))
    except OSError as error:
        problems.append(f'{error.filename or ""}: {error.strerror or error}')
    return None


def read_list(path):
    return [line.strip() for line in open(path)] if os.path.isfile(path) else []


def compare(problems, path, accepted, actual, what):
    if accepted == actual:
        return
    diff = [line for line in difflib.unified_diff(accepted, actual, lineterm='', n=0) if not line.startswith(('---', '+++', '@@'))]
    problems.append(f'{os.path.relpath(path, build.REPO)}: {what} changed; accept it on purpose with check_inputs.py --accept:\n'
                    + '\n'.join(f'    {line}' for line in diff))


def patch_names(problems):
    named = attempt(problems, build.names) or []
    for name, path in named:
        if not os.path.isfile(path):
            problems.append(f'{os.path.relpath(path, build.REPO)}: the Windows series applies `{name}`, which is not a file')
    shared = set(attempt(problems, lambda: build.chromium_lines(os.path.join(build.PATCHES, 'series'), build.SERIES_TAGS)) or [])
    for skip in sorted(build.skipped()):
        if skip not in shared:
            problems.append(f'{os.path.relpath(os.path.join(build.HERE, "series-win"), build.REPO)}: `skip {skip}` names no patch of '
                            'engine/patches/series, so the patch it was meant to leave out may now apply under another name')
    return [name for name, _ in named]


def layer_sources(problems):
    text = attempt(problems, build.ardia_build_file)
    sources = attempt(problems, lambda: build.windows_sources(text)) if text is not None else None
    with tempfile.TemporaryDirectory() as scratch:
        work = attempt(problems, lambda: build.patched_layer(os.path.join(scratch, 'ardia')))
        if work is None or sources is None:
            return sources
        for rel in sources:
            if not os.path.isfile(os.path.join(work, rel)):
                problems.append(f'{build.LAYER_BUILD}: Windows compiles `{rel}`, which is not in the layer')
        defined = set()
        for rel in sources:
            if rel.endswith('.cc') and os.path.isfile(os.path.join(work, rel)):
                defined.update(CALL.findall(open(os.path.join(work, rel), encoding='utf-8').read()))
        for name in attempt(problems, lambda: build.engine_calls(work)) or []:
            if name not in defined:
                problems.append(f'{build.LAYER_BUILD}: the Windows call table names `{name}`, which no source Windows compiles defines')
    return sorted(sources)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--accept', action='store_true')
    args = parser.parse_args()
    problems = []
    patches = patch_names(problems)
    sources = layer_sources(problems)
    attempt(problems, build.launch_switches_source)
    if args.accept:
        if problems or sources is None:
            for problem in problems:
                print(f'FAIL {problem}')
            print('nothing accepted: the inputs could not be read, so the accepted lists are left as they were')
            return 1
        with open(ACCEPTED_PATCHES, 'w') as f:
            f.write(''.join(f'{name}\n' for name in patches))
        with open(ACCEPTED_SOURCES, 'w') as f:
            f.write(''.join(f'{rel}\n' for rel in sources))
    compare(problems, ACCEPTED_PATCHES, read_list(ACCEPTED_PATCHES), patches, 'the patches Windows applies')
    if sources is not None:
        compare(problems, ACCEPTED_SOURCES, read_list(ACCEPTED_SOURCES), sources, 'the layer sources Windows compiles')
    for problem in problems:
        print(f'FAIL {problem}')
    print(f'{len(patches)} patches, {len(sources or [])} layer sources; {len(problems)} problem{"" if len(problems) == 1 else "s"}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
