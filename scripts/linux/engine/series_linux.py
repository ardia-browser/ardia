#!/usr/bin/env python3
"""Our series on a Linux tree: the `chromium` lines of engine/patches/series, minus the `skip <patch>` lines of
scripts/linux/engine/series-linux, then that file's own lines: `chromium <patch>` is a Linux-only patch in
scripts/linux/engine/patches, `win <patch>` is one of scripts/windows/engine/patches whose fix a Linux build needs
as it is (it is not about Windows: the same Mac-only seam). Each is applied strictly (git apply), else with patch's
fuzz; a patch that fails is recorded and the rest still run. Each patch that goes in is written to
.series-linux-applied beside the tree and never applied again (a later patch on the same lines would hide it from a
reverse check). Then the layers: engine/chromium/apply.sh as it is (its chrome/browser/ardia is only built into the
Mac framework, so on Linux it sits unbuilt; its replaced files are the OS-neutral logos), and ArdiaCore's two hook
headers, which the hook patches include (`// nogncheck`); with nothing setting the hooks, Chrome behaves as stock.
engine/ardiacore/apply.sh doesn't run: it is Mac code. Writes a table: patch, result, which files it touches.

Usage: series_linux.py apply --report TSV | layer | classify (CHROMIUM_SRC is the tree)
"""
import argparse
import importlib.util
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PATCHES = os.path.join(REPO, 'engine', 'patches')
WIN_DIR = os.path.join(REPO, 'scripts', 'windows', 'engine')
SOURCES = {'chromium': os.path.join(HERE, 'patches'), 'win': os.path.join(WIN_DIR, 'patches')}
SERIES_LINUX = os.path.join(HERE, 'series-linux')
HOOK_HEADERS = ['ardia/core/ac_hooks.h', 'ardia/core/ac_content_hooks.h']

spec = importlib.util.spec_from_file_location('series_win', os.path.join(WIN_DIR, 'series_win.py'))
win = importlib.util.module_from_spec(spec)
spec.loader.exec_module(win)


def linux_lines():
    out = []
    for n, raw in enumerate(open(SERIES_LINUX), 1):
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        kind, _, name = line.partition(' ')
        name = name.strip()
        if kind not in ('skip', *SOURCES) or not name:
            sys.exit(f'series-linux:{n}: expected `skip|chromium|win <patch>`: {raw.rstrip()}')
        out.append((kind, name))
    return out


def skipped():
    return {name for kind, name in linux_lines() if kind == 'skip'}


def names():
    skips = skipped()
    mac = win.chromium_lines(os.path.join(PATCHES, 'series'))
    unknown = sorted(skips - set(mac))
    if unknown:
        sys.exit(f'series-linux skips patches engine/patches/series doesn\'t have: {", ".join(unknown)}')
    out = [(n, os.path.join(PATCHES, n)) for n in mac if n not in skips]
    for kind, name in linux_lines():
        if kind != 'skip':
            path = os.path.join(SOURCES[kind], name)
            if not os.path.isfile(path):
                sys.exit(f'series-linux: no {path}')
            out.append((name, path))
    return out


def state_path(tree):
    return os.path.join(os.path.dirname(os.path.abspath(tree)), '.series-linux-applied')


def read_state(tree):
    path = state_path(tree)
    return set(open(path).read().split()) if os.path.isfile(path) else set()


def record(tree, name):
    with open(state_path(tree), 'a') as f:
        f.write(name + '\n')


def layers(tree):
    p = subprocess.run([os.path.join(REPO, 'engine/chromium/apply.sh')], cwd=REPO, capture_output=True, text=True,
                       env=dict(os.environ, CHROMIUM_SRC=tree))
    if p.returncode:
        sys.exit(f'series_linux.py: engine/chromium/apply.sh failed: {(p.stderr or p.stdout).strip()[:600]}')
    copied = 0
    for rel in HOOK_HEADERS:
        copied += win.copy_if_changed(os.path.join(REPO, 'engine/ardiacore/src', rel), os.path.join(tree, rel))
    print(f'engine/chromium applied; {len(HOOK_HEADERS)} ArdiaCore hook headers ({copied} changed)')


def cmd_apply(args):
    tree = os.environ['CHROMIUM_SRC']
    done = read_state(tree)
    rows, failed = [], 0
    for name in sorted(skipped()):
        rows.append((name, 'skipped (series-linux)', win.classify(win.patch_files(os.path.join(PATCHES, name))), ''))
        print(f'{"skipped":16} {name}', flush=True)
    for name, path in names():
        if name in done:
            result, detail = 'already applied', 'recorded'
        else:
            result, detail = win.apply_one(path, tree)
            if result != 'FAILED':
                record(tree, name)
        failed += result == 'FAILED'
        rows.append((name, result, win.classify(win.patch_files(path)), detail))
        print(f'{result:16} {name}', flush=True)
    layers(tree)
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, 'w') as f:
        f.write('patch\tresult\tfiles\tdetail\n')
        for row in rows:
            f.write('\t'.join(row) + '\n')
    skips = sum(1 for r in rows if r[1].startswith('skipped'))
    print(f'{len(rows) - failed - skips} of {len(rows) - skips} patches in, {skips} skipped; report: {args.report}')
    return 1 if failed else 0


def cmd_layer(args):
    layers(os.environ['CHROMIUM_SRC'])
    return 0


def cmd_classify(args):
    for name, path in names():
        print(f'{win.classify(win.patch_files(path)):16} {name}')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    apply = sub.add_parser('apply')
    apply.add_argument('--report', required=True)
    sub.add_parser('classify')
    sub.add_parser('layer')
    args = parser.parse_args()
    return {'apply': cmd_apply, 'classify': cmd_classify, 'layer': cmd_layer}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
