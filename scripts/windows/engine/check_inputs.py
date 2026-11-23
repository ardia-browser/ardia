#!/usr/bin/env python3
"""Checks, without a Chromium tree, that the shared engine inputs still make a Windows engine build the way
series_win.py takes them, and lists every problem with the file and line it comes from:

- the patch lists (engine/patches/series, scripts/windows/engine/series-win) parse, each patch Windows applies exists,
  each `skip` names a shared patch, and the patches Windows applies, in order, are accepted-patches.txt;
- ardia-layer-win.patch applies to engine/chromium/src/chrome/browser/ardia without fuzz;
- the layer's BUILD.gn has what the Windows build file is made from, the sources Windows compiles from it are
  accepted-layer-sources.txt and all exist, and every engine call in the Windows call table is defined in one of them;
- engine/ardiacore's ac_launch_switches.cc still has what launch_switches_source() turns into the Windows copy;
- the Windows engine key (engine/engine-key.sh --platform win, from key-inputs.json) hashes every repository file this
  build reads. It is observed, not listed. Under an audit hook that records each file opened, each folder listed and
  each path handed to a subprocess, in a scratch tree removed afterwards, three parts of the build run for real:
  series_win.py apply against an empty tree with its patching stubbed out (the patches series-win skips, read only for
  the report, aside); the offline game's packer, inline.py; and 03-helium.py's resources stage with its icon making
  and copying stubbed out, which names the resource lists the branding reads, each of which key-inputs.json must list.
  The build steps (0?-*, toolchain.sh, debuggers.sh) are followed through the scripts they source and run, as named
  through $AC_MAC_BUILD_DIR, $AC_WIN_BUILD_DIR, $AC_REPO, the script's own folder, or a variable the script sets to
  a repository folder with `cd … && pwd`; other variables point into the Chromium build tree, outside the repository.
  Each path is judged by engine-key.py's own plan, so the declaration is normalized and excluded as the key does it.

A change to an accepted list is accepted on purpose: run with --accept and commit the lists. --accept writes
nothing and fails when any input can't be read.

Usage: check_inputs.py [--accept]
"""
import argparse
import difflib
import importlib.util
import json
import os
import pathlib
import re
import runpy
import shutil
import sys
import tempfile
import types

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
    return [line.strip() for line in build.read_file(path).splitlines()] if os.path.isfile(path) else []


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
                defined.update(CALL.findall(build.read_file(os.path.join(work, rel), encoding='utf-8')))
        for name in attempt(problems, lambda: build.engine_calls(work)) or []:
            if name not in defined:
                problems.append(f'{build.LAYER_BUILD}: the Windows call table names `{name}`, which no source Windows compiles defines')
    return sorted(sources)


def under(path, prefix):
    return path == prefix or path.startswith(prefix + '/')


STEP_SCRIPT = re.compile(r'^(0\d-.+\.(sh|py)|toolchain\.sh|debuggers\.sh)$')
SCRIPT_REFERENCE = re.compile(
    r'\$\{?(AC_MAC_BUILD_DIR|AC_WIN_BUILD_DIR|AC_REPO)(?::-[^}]*)?\}?/([A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*)'
    r'|\$\(dirname "\$(?:0|\{BASH_SOURCE\[0\][^}]*\})"\)/([A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*)'
    r'|\b(HERE|MAC_DIR|REPO_ROOT|REPO)\s*/\s*[\'"]([^\'"]+)[\'"]')
SCRIPT_FOLDER = re.compile(
    r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)="?\$\(cd "\$\(dirname "\$(?:0|\{BASH_SOURCE\[0\][^}]*\})"\)(/[^"]*)?"'
    r'\s*&&\s*pwd(?: -P)?\)"?', re.M)
SCRIPT_ROOTS = {'AC_MAC_BUILD_DIR': 'engine/patches/build', 'AC_WIN_BUILD_DIR': 'scripts/windows/engine', 'AC_REPO': '',
                'MAC_DIR': 'engine/patches/build', 'REPO_ROOT': '', 'REPO': ''}


def repo_rel(path):
    full = os.path.realpath(path)
    root = os.path.realpath(build.REPO)
    if full != root and not full.startswith(root + os.sep):
        return None
    return os.path.relpath(full, root).replace(os.sep, '/')


def script_inputs():
    here = os.path.relpath(build.HERE, build.REPO).replace(os.sep, '/')
    pending = [f'{here}/{name}' for name in sorted(os.listdir(build.HERE)) if STEP_SCRIPT.match(name)]
    found = set()
    while pending:
        script = pending.pop()
        if script in found:
            continue
        found.add(script)
        if not script.endswith(('.sh', '.py')) or not os.path.isfile(build.checkout_path(script)):
            continue
        with open(build.checkout_path(script), encoding='utf-8', errors='replace') as f:
            text = f.read()
        folder = os.path.dirname(script)
        references = []
        for match in SCRIPT_REFERENCE.finditer(text):
            variable, path, sibling, python_root, python_path = match.groups()
            if variable:
                references.append((SCRIPT_ROOTS[variable], path))
            elif sibling:
                references.append((folder, sibling))
            else:
                references.append(((folder if python_root == 'HERE' else SCRIPT_ROOTS[python_root]), python_path))
        local = {name: os.path.normpath(os.path.join(folder, (rest or '/').lstrip('/'))) for name, rest in SCRIPT_FOLDER.findall(text)}
        for name, base in local.items():
            references += [(base, rest) for rest in re.findall(r'\$\{?' + name + r'\}?/([A-Za-z0-9_.@+-][A-Za-z0-9_./@+-]*)', text)]
        for base, rest in references:
            target = repo_rel(os.path.join(build.REPO, base, rest.rstrip('/.')))
            if target and target != '.' and os.path.exists(build.checkout_path(target)):
                pending.append(target)
    return found


def observe_build():
    tree = tempfile.mkdtemp(prefix='series-win-observed-')
    start = os.getcwd()
    try:
        return observe_into(tree)
    finally:
        os.chdir(start)
        shutil.rmtree(tree, ignore_errors=True)


def observe_into(tree):
    owned = os.path.join('chrome', 'browser', 'ardia')
    for rel in build.files_under(os.path.join(build.REPO, 'engine/chromium/src')):
        if rel != owned and not rel.startswith(owned + os.sep):
            target = os.path.join(tree, 'src', rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            open(target, 'w').close()
    files, folders, listings = set(), set(), set()

    def note(path, into):
        if isinstance(path, (str, bytes, os.PathLike)) and os.path.isabs(os.fsdecode(path)):
            rel = repo_rel(os.fsdecode(path))
            if rel is not None and rel != '.':
                into.add(rel)

    def hook(event, args):
        if event == 'open':
            path, mode, flags = args
            writes = (mode is not None and any(c in mode for c in 'wax+')) or \
                (mode is None and isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR))
            if not writes:
                note(path, files)
        elif event in ('os.listdir', 'os.scandir') and args:
            note(args[0], folders)
        elif event == 'shutil.copytree':
            note(args[0], folders)
        elif event == 'subprocess.Popen':
            command, cwd = args[1], args[2]
            for arg in command if isinstance(command, (list, tuple)) else [command]:
                if isinstance(arg, (str, bytes, os.PathLike)) and os.path.isabs(os.fsdecode(arg)) and os.path.exists(arg):
                    note(arg, folders if os.path.isdir(arg) else files)
            if cwd is not None:
                note(cwd, folders)

    build.apply_one = lambda path, tree: ('clean', '')
    os.environ['CHROMIUM_SRC'] = os.path.join(tree, 'src')
    os.chdir(tree)
    sys.addaudithook(hook)
    with open(os.devnull, 'w') as quiet:
        stdout, sys.stdout = sys.stdout, quiet
        try:
            build.cmd_apply(argparse.Namespace(report=os.path.join(tree, 'report.tsv')))
            game = build.checkout_path('apps/browser/assets/offline-game-pipeline/inline.py')
            argv, sys.argv = sys.argv, [game, os.path.join(tree, 'src/components/neterror/resources/game/game.html')]
            try:
                runpy.run_path(game, run_name='__main__')
            finally:
                sys.argv = argv
            branding = importlib.util.spec_from_file_location('helium_win', os.path.join(build.HERE, '03-helium.py'))
            helium = importlib.util.module_from_spec(branding)
            branding.loader.exec_module(helium)
            helium.install()
            helium.mac.generate_icons = lambda ctx: pathlib.Path(tree, 'helium-icons')

            def copy_resources(ctx, listing, roots):
                note(os.fspath(listing), listings)
                return 0

            helium.mac.copy_resources = copy_resources
            work = pathlib.Path(tree)
            helium.mac.HANDLERS['resources'](types.SimpleNamespace(no_brand=False, hc=work / 'helium', work=work,
                                                                  tree=work / 'src', platform='win'))
        finally:
            sys.stdout = stdout
    print(json.dumps({'files': sorted(files), 'folders': sorted(folders), 'resource_lists': sorted(listings)}))
    return 0


def observed_reads(problems):
    run = __import__('subprocess').run(
        [sys.executable, '-I', *(f'-W{option}' for option in sys.warnoptions),
         *(f'-X{name}' if value is True else f'-X{name}={value}' for name, value in sys._xoptions.items()),
         os.path.abspath(__file__), '--observe'], capture_output=True, text=True,
        env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
    sys.stderr.write(run.stderr)
    if run.returncode != 0:
        problems.append(f'series_win.py apply, run against an empty tree to see what it reads, failed: '
                        f'{(run.stderr or run.stdout).strip()[-600:]}')
        return None
    return json.loads(run.stdout.strip().splitlines()[-1])


def engine_key_module():
    spec = importlib.util.spec_from_file_location('engine_key', os.path.join(build.REPO, 'engine', 'engine-key.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def declared_inputs(problems):
    where = os.path.relpath(build.KEY_INPUTS, build.REPO)
    key = engine_key_module()
    try:
        with open(build.KEY_INPUTS, 'rb') as f:
            declared = key.normalized_declarations(f.read(), where)
        plan = key.WinPlan(key.WorkTree())
    except key.Problem as problem:
        problems.append(str(problem))
        return
    for field, wanted in (('series', build.SERIES_REL), ('series_win', build.SERIES_WIN_REL),
                          ('win_patches', build.WIN_PATCHES_REL), ('series_tags', list(build.WINDOWS_TAGS))):
        if declared[field] != wanted:
            problems.append(f'{where}: {field} is {declared[field]!r}, but series_win.py reads {wanted!r}')
    hashed = lambda path: path in plan.series or plan.counts(path)
    for script in sorted(script_inputs()):
        if not hashed(script):
            problems.append(f'{where}: a Windows build step runs or sources {script}, which the Windows key does not hash')
    observed = observed_reads(problems)
    if observed is None:
        return
    for listing in observed['resource_lists']:
        if listing not in declared['resource_lists']:
            problems.append(f'{where}: 03-helium.py brands with {listing}, which resource_lists does not name')
    report_only = {f'engine/patches/{name}' for name in build.skipped()}
    for path in observed['files']:
        if path not in report_only and not hashed(path):
            problems.append(f'{where}: the Windows build reads {path}, which the Windows key does not hash')
    for folder in observed['folders']:
        if not hashed(folder):
            problems.append(f'{where}: the Windows build lists {folder}, which no Windows key tree covers')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--accept', action='store_true')
    parser.add_argument('--observe', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.observe:
        return observe_build()
    problems = []
    patches = patch_names(problems)
    sources = layer_sources(problems)
    attempt(problems, build.launch_switches_source)
    declared_inputs(problems)
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
