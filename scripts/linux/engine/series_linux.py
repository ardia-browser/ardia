#!/usr/bin/env python3
"""Our series on a Linux tree, in three parts: the patches, the layers and the hooks.

Patches: the `chromium` lines of engine/patches/series, minus the `skip <patch>` lines of
scripts/linux/engine/series-linux (`except <patch> <path>...` applies one without those files, whose Linux version a
later line carries), then that file's own lines: `chromium <patch>` is a Linux-only patch in
scripts/linux/engine/patches, `win <patch>` one of scripts/windows/engine/patches a Linux build needs as it is, and
`win-widened <patch>` one whose added BUILDFLAG(IS_WIN) guards also take IS_LINUX. Each is applied strictly (git apply),
else with patch's fuzz; a patch that fails is recorded and the rest still run. Each patch that goes in is written to
.series-linux-applied beside the tree and never applied again (a later patch on the same lines would hide it from a
reverse check); a recorded patch that has left the series is reverse-applied first, newest first.

Layers (`layer`): engine/chromium's replaced files and its chrome/browser/ardia (the ac_* calls), built for Linux: the
Mac sources with scripts/windows/engine/ardia-layer-win.patch (paths through FromUTF8Unsafe/AsUTF8Unsafe, which mean the
same on Linux), the files under scripts/linux/engine/src/chrome/browser/ardia over them, and a BUILD.gn made from the
Mac one (no .mm, no external apps; pip/ with ac_pip_linux.cc for the Mac presenter; launch_switches from
//ardia/win, as Windows builds it). Then the tree's ardia/ is made
exactly: //ardia/core's portable files (the hook headers, ac_host_visibility.h (//ardia/linux defines its functions),
ac_launch_switches with the Windows port's signature rule,
the page script and the renderer side of the page channel, the mojom), //ardia/win's platform-neutral files with
ardia-win-on-linux.patch, its public/EngineApi.h and a generated table of the ac_* calls, then everything under
scripts/linux/engine/src/ardia over them (//ardia/linux, the Linux //ardia/win overlays, //ardia/core's BUILD.gn).
Only files that changed are written; files nothing names are removed.

Hooks (`hooks`): the hook blocks of engine/ardiacore/apply.sh for the files scripts/linux/engine/linux-hooks names, one
path per line, run through apply.sh's own Python helper (read from apply.sh at run time, so markers, --check and the
include line behave as on the Mac); engine/ardiacore/apply.sh itself doesn't run. With nothing setting them, Chrome
behaves as stock.

`apply` runs the three in that order and writes a table: patch, result, which files it touches.

Usage: series_linux.py apply --report TSV | layer | hooks [--check] | classify (CHROMIUM_SRC is the tree)
"""
import argparse
import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PATCHES = os.path.join(REPO, 'engine', 'patches')
WIN_DIR = os.path.join(REPO, 'scripts', 'windows', 'engine')
SOURCES = {'chromium': os.path.join(HERE, 'patches'), 'win': os.path.join(WIN_DIR, 'patches'),
           'win-widened': os.path.join(WIN_DIR, 'patches')}
SERIES_LINUX = os.path.join(HERE, 'series-linux')
LINUX_HOOKS = os.path.join(HERE, 'linux-hooks')
APPLY_SH = os.path.join(REPO, 'engine', 'ardiacore', 'apply.sh')
CORE_SRC = os.path.join(REPO, 'engine', 'ardiacore', 'src', 'ardia', 'core')
WIN_SRC = os.path.join(WIN_DIR, 'src', 'ardia', 'win')
LINUX_SRC = os.path.join(HERE, 'src', 'ardia')
WIN_ON_LINUX_PATCH = os.path.join(HERE, 'ardia-win-on-linux.patch')
ENGINE_API_H = os.path.join(REPO, 'apps', 'browser', 'windows', 'Ardia', 'EngineApi.h')
CORE_FILES = ['ac_hooks.h', 'ac_content_hooks.h', 'ac_host_visibility.h', 'ac_launch_switches.h', 'ac_page_limits.h',
              'ac_page_script.cc', 'ac_page_script.h', 'renderer/ac_content_renderer_client.cc',
              'renderer/ac_content_renderer_client.h', 'mojom/ardiacore.mojom', 'mojom/BUILD.gn']
WIN_SHARED = ['ac_calls.h', 'api.h', 'external_apps.cc', 'external_apps.h', 'page_links.cc', 'page_links.h',
              'page_links_script.h', 'private_sessions.cc', 'private_sessions.h', 'profiles.cc', 'profiles.h',
              'tab_calls.cc', 'tab_calls.h', 'tab_events.cc', 'tab_events.h', 'tab_state.cc', 'tab_state.h']
LINUX_LAYER_LINE = re.compile(r'(\.mm"|"ac_external_apps\.h")')

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
        if kind not in ('skip', 'except', *SOURCES) or not name:
            sys.exit(f'series-linux:{n}: expected `skip|except|chromium|win|win-widened <patch>`: {raw.rstrip()}')
        if kind == 'except':
            name, *paths = name.split()
            if not paths:
                sys.exit(f'series-linux:{n}: `except <patch>` needs the paths it leaves out')
            out.append((kind, (name, tuple(paths))))
        else:
            out.append((kind, name))
    return out


def excepted():
    return {name: paths for kind, (name, paths) in ((k, v) for k, v in linux_lines() if k == 'except')}


def widened():
    return {name for kind, name in linux_lines() if kind == 'win-widened'}


def without_files(path, paths, scratch):
    lines = open(path, encoding='utf-8', errors='surrogateescape').read().splitlines(True)
    kept, keep, dropped = [], True, set()
    for i, line in enumerate(lines):
        if line.startswith('--- ') and i + 1 < len(lines) and lines[i + 1].startswith('+++ '):
            target = lines[i + 1][4:].split('\t')[0].strip().removeprefix('b/')
            keep = target not in paths
            if not keep:
                dropped.add(target)
        if keep:
            kept.append(line)
    missing = sorted(set(paths) - dropped)
    if missing:
        sys.exit(f'series-linux: {os.path.basename(path)} doesn\'t touch {", ".join(missing)}')
    out = os.path.join(scratch, os.path.basename(path))
    with open(out, 'w', encoding='utf-8', errors='surrogateescape') as f:
        f.write(''.join(kept))
    return out


def with_linux_guards(path, scratch):
    text = open(path, encoding='utf-8', errors='surrogateescape').read()
    lines = text.splitlines(True)
    out = [l.replace('BUILDFLAG(IS_WIN)', 'BUILDFLAG(IS_WIN) || BUILDFLAG(IS_LINUX)')
           if l.startswith('+') and not l.startswith('+++') else l for l in lines]
    target = os.path.join(scratch, os.path.basename(path))
    with open(target, 'w', encoding='utf-8', errors='surrogateescape') as f:
        f.write(''.join(out))
    return target


def as_applied(name, path, scratch):
    if name in excepted():
        path = without_files(path, excepted()[name], scratch)
    if name in widened():
        path = with_linux_guards(path, scratch)
    return path


def skipped():
    return {name for kind, name in linux_lines() if kind == 'skip'}


def names():
    skips = skipped()
    mac = win.chromium_lines(os.path.join(PATCHES, 'series'))
    unknown = sorted(skips - set(mac))
    if unknown:
        sys.exit(f'series-linux skips patches engine/patches/series doesn\'t have: {", ".join(unknown)}')
    unknown = sorted(set(excepted()) - set(mac))
    if unknown:
        sys.exit(f'series-linux excepts patches engine/patches/series doesn\'t have: {", ".join(unknown)}')
    out = [(n, os.path.join(PATCHES, n)) for n in mac if n not in skips]
    for kind, name in linux_lines():
        if kind in SOURCES:
            path = os.path.join(SOURCES[kind], name)
            if not os.path.isfile(path):
                sys.exit(f'series-linux: no {path}')
            out.append((name, path))
    return out


def find_patch(name):
    for folder in (PATCHES, *SOURCES.values()):
        if os.path.isfile(os.path.join(folder, name)):
            return os.path.join(folder, name)
    return None


def state_path(tree):
    return os.path.join(os.path.dirname(os.path.abspath(tree)), '.series-linux-applied')


def read_state(tree):
    path = state_path(tree)
    return open(path).read().split() if os.path.isfile(path) else []


def write_state(tree, recorded):
    path = state_path(tree)
    with open(path + '.tmp', 'w') as f:
        f.write(''.join(n + '\n' for n in recorded))
    os.replace(path + '.tmp', path)


def record(tree, name):
    with open(state_path(tree), 'a') as f:
        f.write(name + '\n')


def retire(tree):
    recorded = read_state(tree)
    current = {n for n, _ in names()}
    gone = [n for n in recorded if n not in current]
    for name in reversed(gone):
        path = find_patch(name)
        if path is None:
            sys.exit(f'series_linux.py: {name} left the series and its file is gone: reverse it by hand')
        p = win.run(['git', 'apply', '-R', '--whitespace=nowarn', path], tree)
        if p.returncode:
            sys.exit(f'series_linux.py: {name} left the series but doesn\'t reverse-apply: {p.stderr.strip()[:400]}')
        recorded.remove(name)
        write_state(tree, recorded)
        print(f'{"reversed":16} {name} (no longer in series-linux)', flush=True)


def linux_ardia_build_file():
    text = open(os.path.join(win.ARDIA_LAYER, 'BUILD.gn'), encoding='utf-8').read()
    for needed in ('assert(is_mac)', 'config("exports_config")', '    "pip/ac_pip_mac.h",\n'):
        if text.count(needed) != 1:
            sys.exit(f'series_linux.py: chrome/browser/ardia/BUILD.gn has no single {needed.strip()}')
    text = text.replace('assert(is_mac)', 'assert(is_linux)')
    text = ''.join(line for line in text.splitlines(True) if not LINUX_LAYER_LINE.search(line))
    text = text.replace('    "pip/ac_pip_mac.h",\n', '    "pip/ac_pip_linux.cc",\n    "pip/ac_pip_mac.h",\n')
    text = re.sub(r'\n  frameworks \+?= \[[^\]]*\]\n', '\n', text)
    text = text.replace('    "//ardia/core:launch_switches",\n', '    "//ardia/win:launch_switches",\n')
    return text[:text.index('config("exports_config")')].rstrip() + '\n'


def linux_launch_switches_source():
    text = win.launch_switches_source()
    if text.count('ardia/win/test_gate.cc') != 1:
        sys.exit('series_linux.py: the launch switches no longer name ardia/win/test_gate.cc')
    return text.replace('ardia/win/test_gate.cc', 'ardia/linux/test_gate.cc')


def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


def files_of(root):
    return {rel: read_bytes(path) for rel, path in win.files_under(root).items()}


def patched(files, patch):
    with tempfile.TemporaryDirectory() as scratch:
        for rel, data in files.items():
            os.makedirs(os.path.dirname(os.path.join(scratch, rel)) or scratch, exist_ok=True)
            with open(os.path.join(scratch, rel), 'wb') as f:
                f.write(data)
        p = win.run(['patch', '-p1', '-F0', '-s', '--no-backup-if-mismatch', '-i', patch], scratch)
        if p.returncode:
            sys.exit(f'series_linux.py: {os.path.basename(patch)} does not apply: {(p.stdout + p.stderr).strip()[:600]}')
        return {rel: read_bytes(os.path.join(scratch, rel)) for rel in files}


def ardia_tree():
    wanted = {}
    for rel in CORE_FILES:
        wanted[os.path.join('core', rel)] = read_bytes(os.path.join(CORE_SRC, rel))
    wanted['core/ac_launch_switches.cc'] = linux_launch_switches_source().encode()
    shared = patched({rel: read_bytes(os.path.join(WIN_SRC, rel)) for rel in WIN_SHARED}, WIN_ON_LINUX_PATCH)
    for rel, data in shared.items():
        wanted[os.path.join('win', rel)] = data
    wanted['win/public/EngineApi.h'] = read_bytes(ENGINE_API_H)
    wanted['win/ac_calls.cc'] = win.engine_calls_source(win.engine_calls()).encode()
    for rel, data in files_of(LINUX_SRC).items():
        wanted[rel] = data
    return wanted


def sync_ardia(tree):
    target = os.path.join(tree, 'ardia')
    wanted = ardia_tree()
    changed = 0
    for rel, data in wanted.items():
        path = os.path.join(target, rel)
        if os.path.isfile(path) and read_bytes(path) == data:
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(data)
        changed += 1
    for rel, path in win.files_under(target).items():
        if rel not in wanted:
            os.remove(path)
            changed += 1
    return len(wanted), changed


def layers(tree):
    win.LAYER_OVERLAY = os.path.join(HERE, 'src', 'chrome', 'browser', 'ardia')
    win.ardia_build_file = linux_ardia_build_file
    replaced = win.chromium_layer(tree)
    count, changed = sync_ardia(tree)
    print(f'engine/chromium for Linux: {replaced} files changed; ardia/: {count} files, {changed} changed')


def apply_sh_blocks():
    text = open(APPLY_SH, encoding='utf-8').read()
    lib = re.search(r"^read -r -d '' hooklib <<'PY' \|\| true\n(.*?)\nPY\n", text, re.S | re.M)
    if not lib:
        sys.exit('series_linux.py: engine/ardiacore/apply.sh has no hooklib')
    blocks = {}
    for path, name, body in re.findall(r'^hook "\$src/([^"]+)" "([^"]+)" <<\'PY\'\n(.*?)\nPY\n', text, re.S | re.M):
        blocks.setdefault(path, []).append((name, body))
    return lib.group(1), blocks


def hook_paths():
    out = []
    for n, raw in enumerate(open(LINUX_HOOKS), 1):
        line = raw.split('#', 1)[0].strip()
        if line:
            out.append(line)
    return out


def run_hooks(tree, mode):
    lib, blocks = apply_sh_blocks()
    problems = []
    count = 0
    for path in hook_paths():
        if path not in blocks:
            sys.exit(f'linux-hooks: engine/ardiacore/apply.sh has no hook for {path}')
        for name, body in blocks[path]:
            p = subprocess.run([sys.executable, '-c', lib + '\n' + body, mode, os.path.join(tree, path), name],
                               capture_output=True, text=True)
            count += 1
            if p.stdout.strip():
                print(p.stdout.strip(), flush=True)
            if p.returncode:
                problems.append(f'{path} ({name}): ' + ((p.stderr or p.stdout).strip().splitlines() or ['failed'])[-1])
                if mode != 'check':
                    break
        if problems and mode != 'check':
            break
    for problem in problems:
        print(problem, file=sys.stderr)
    print(f'hooks: {count} blocks for {len(hook_paths())} files ({mode}), {len(problems)} problems')
    return 1 if problems else 0


def cmd_apply(args):
    tree = os.environ['CHROMIUM_SRC']
    retire(tree)
    done = set(read_state(tree))
    rows, failed = [], 0
    for name in sorted(skipped()):
        rows.append((name, 'skipped (series-linux)', win.classify(win.patch_files(os.path.join(PATCHES, name))), ''))
        print(f'{"skipped":16} {name}', flush=True)
    excepts = excepted()
    scratch = tempfile.mkdtemp(prefix='series-linux-')
    for name, path in names():
        if name in done:
            result, detail = 'already applied', 'recorded'
        else:
            result, detail = win.apply_one(as_applied(name, path, scratch), tree)
            if result != 'FAILED':
                record(tree, name)
        if name in excepts:
            detail = '; '.join(filter(None, [detail, 'without ' + ', '.join(excepts[name])]))
        if name in widened():
            detail = '; '.join(filter(None, [detail, 'IS_WIN guards widened to IS_LINUX']))
        failed += result == 'FAILED'
        rows.append((name, result, win.classify(win.patch_files(path)), detail))
        print(f'{result:16} {name}{" (" + detail + ")" if name in excepts or name in widened() else ""}', flush=True)
    shutil.rmtree(scratch, ignore_errors=True)
    layers(tree)
    hooks_failed = run_hooks(tree, 'apply')
    os.makedirs(os.path.dirname(args.report), exist_ok=True)
    with open(args.report, 'w') as f:
        f.write('patch\tresult\tfiles\tdetail\n')
        for row in rows:
            f.write('\t'.join(row) + '\n')
    skips = sum(1 for r in rows if r[1].startswith('skipped'))
    print(f'{len(rows) - failed - skips} of {len(rows) - skips} patches in, {skips} skipped; report: {args.report}')
    return 1 if failed or hooks_failed else 0


def cmd_layer(args):
    layers(os.environ['CHROMIUM_SRC'])
    return 0


def cmd_hooks(args):
    return run_hooks(os.environ['CHROMIUM_SRC'], 'check' if args.check else 'apply')


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
    hooks = sub.add_parser('hooks')
    hooks.add_argument('--check', action='store_true')
    args = parser.parse_args()
    return {'apply': cmd_apply, 'classify': cmd_classify, 'layer': cmd_layer, 'hooks': cmd_hooks}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
