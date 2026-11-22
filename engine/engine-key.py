#!/usr/bin/env python3
import argparse
import hashlib
import importlib.util
import os
import pathlib
import posixpath
import re
import subprocess
import sys
import tempfile

ROOTS = ('engine', 'apps/browser/assets/offline-game', 'apps/browser/assets/offline-game-pipeline')
TOOLING_PREFIXES = ('engine/engine-key.', 'engine/patches/build/tests/')
TOOLING_PATHSPECS = (':(exclude,glob)engine/engine-key.*', ':(exclude)engine/patches/build/tests')
SERIES = 'engine/patches/series'
PATCH_DIR = 'engine/patches'
COPIES = 'copies.tsv'
UNITS = ('.c', '.cc', '.cpp', '.m', '.mm')
PLATFORMS = {'mac': 'mac', 'macos': 'mac', 'linux': 'linux'}
OTHER = {'mac': 'linux', 'linux': 'mac'}
GN_PLATFORMS = {'is_mac': 'mac', 'is_linux': 'linux'}
CHECKOUT = pathlib.Path(__file__).resolve().parents[1]


class Problem(Exception):
    pass


def safe_relative(path):
    return bool(path) and not path.startswith('/') and '\\' not in path and all(part not in ('', '.', '..') for part in path.split('/'))


def under(path, prefix):
    return path == prefix or path.startswith(prefix + '/')


def in_roots(path):
    return any(under(path, root) for root in ROOTS)


def git(*args, check=True):
    result = subprocess.run(['git', '-C', str(CHECKOUT), *args], capture_output=True)
    if check and result.returncode != 0:
        raise Problem(f'git {" ".join(args)} failed: {result.stderr.decode(errors="replace").strip()}')
    return result


class GitTree:
    def __init__(self, rev):
        self.rev = rev
        if git('rev-parse', '--verify', '--quiet', f'{rev}^{{tree}}', check=False).returncode != 0:
            raise Problem(f"{rev} isn't a commit or tree")
        for root in ROOTS:
            if git('rev-parse', '--verify', '--quiet', f'{rev}:{root}', check=False).returncode != 0:
                raise Problem(f'{rev} has no {root}')
        self.entries = {}
        self.load(ROOTS)

    def load(self, paths):
        listing = git('ls-tree', '-r', '-z', '--full-tree', self.rev, '--', *paths).stdout
        for record in listing.split(b'\0'):
            if record:
                meta, path = record.split(b'\t', 1)
                mode, _, oid = meta.decode().split()
                self.entries[path.decode('utf-8', 'surrogateescape')] = (mode, oid)

    def read(self, path):
        entry = self.entries.get(path)
        return None if entry is None else git('cat-file', 'blob', entry[1]).stdout

    def files(self):
        return list(self.entries)


class WorkTree:
    def __init__(self):
        self.entries = set()
        self.load(ROOTS)

    def load(self, paths):
        for path in paths:
            full = CHECKOUT / path
            if full.is_file():
                self.entries.add(path)
            for top, dirs, names in os.walk(full):
                dirs[:] = [name for name in dirs if name != '.git']
                relative = pathlib.Path(top).relative_to(CHECKOUT).as_posix()
                self.entries.update(f'{relative}/{name}' for name in names)

    def read(self, path):
        return (CHECKOUT / path).read_bytes() if path in self.entries else None

    def files(self):
        return list(self.entries)


def series_module():
    path = CHECKOUT / 'engine/patches/series.py'
    if not path.is_file():
        raise Problem('engine/patches/series exists but engine/patches/series.py, its parser, does not')
    spec = importlib.util.spec_from_file_location('ardia_series', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_series(tree, text, platform, module):
    with tempfile.TemporaryDirectory(prefix='engine-key-') as scratch:
        patches = pathlib.Path(scratch, PATCH_DIR)
        patches.mkdir(parents=True)
        (patches / 'series').write_bytes(text)
        for path in tree.files():
            if path.startswith(PATCH_DIR + '/') and path.endswith('.patch') and '/' not in path[len(PATCH_DIR) + 1:]:
                (patches / path[len(PATCH_DIR) + 1:]).write_bytes(b'')
            if path.endswith('/apply.sh') and safe_relative(path):
                stub = pathlib.Path(scratch, path)
                stub.parent.mkdir(parents=True, exist_ok=True)
                stub.write_bytes(b'')
        module.HERE, module.REPO = str(patches), scratch
        try:
            steps = module.read_series(platform)
        except SystemExit as stop:
            raise Problem(f'engine/patches/series is invalid: {stop.code}')
    return [(step.kind, step.name) for step in steps]


def read_copies(tree, layer):
    raw = tree.read(f'{layer}/{COPIES}')
    if raw is None:
        return []
    text = raw.decode('utf-8', 'surrogateescape')
    copies = []
    for number, line in enumerate(text.split('\n'), 1):
        if line == '':
            continue
        fields = line.split('\t')
        if '\r' in line or len(fields) != 2 or not all(safe_relative(field) for field in fields):
            raise Problem(f'{layer}/{COPIES}:{number}: expected `<source>\\t<target>`, relative paths without . or ..: {line!r}')
        copies.append(fields[0])
    return copies


def gn_strings(text):
    stack, pending, index, length = ['all'], None, 0, len(text)
    while index < length:
        char = text[index]
        if char == '#':
            end = text.find('\n', index)
            index = length if end < 0 else end
            continue
        if char == '"':
            cursor, value = index + 1, []
            while cursor < length and text[cursor] != '"':
                if text[cursor] == '\\' and cursor + 1 < length:
                    value.append(text[cursor + 1])
                    cursor += 2
                    continue
                value.append(text[cursor])
                cursor += 1
            yield stack[-1], ''.join(value)
            index = cursor + 1
            continue
        word = re.match(r'[A-Za-z_][A-Za-z0-9_]*', text[index:index + 64])
        if word and (index == 0 or not (text[index - 1].isalnum() or text[index - 1] == '_')):
            name = word.group(0)
            if name == 'if':
                opening = text.find('(', index)
                depth, cursor = 0, opening
                while cursor < length:
                    if text[cursor] == '(':
                        depth += 1
                    elif text[cursor] == ')':
                        depth -= 1
                        if depth == 0:
                            break
                    cursor += 1
                condition = text[opening + 1:cursor].strip()
                pending = stack[-1] if stack[-1] != 'all' else GN_PLATFORMS.get(condition, 'all')
                index = cursor + 1
                continue
            if name == 'else':
                pending = stack[-1]
            index += len(name)
            continue
        if char == '{':
            stack.append(pending if pending is not None else stack[-1])
            pending = None
        elif char == '}' and len(stack) > 1:
            stack.pop()
        index += 1


def source_roots(files):
    return sorted({'/'.join(path.split('/')[:3]) for path in files if re.match(r'engine/[^/]+/src/', path)})


def gn_sources(value, base, roots, files):
    if value.startswith('//'):
        found = [path for path in (posixpath.normpath(f'{root}/{value[2:]}') for root in roots) if path in files]
        return found, len(found) > 1
    if value.startswith(('/', '$', ':')) or '*' in value:
        return [], False
    return [posixpath.normpath(posixpath.join(base, value))], False


def platform_units(tree):
    listed = {'mac': set(), 'linux': set(), 'all': set()}
    files = set(tree.files())
    roots = source_roots(files)
    for path in sorted(files):
        if not path.startswith('engine/') or posixpath.basename(path) != 'BUILD.gn':
            continue
        base = posixpath.dirname(path)
        for context, value in gn_strings(tree.read(path).decode('utf-8', 'surrogateescape')):
            if not value.endswith(UNITS):
                continue
            sources, ambiguous = gn_sources(value, base, roots, files)
            listed['all' if ambiguous else context].update(sources)
    shared = listed['all']
    return {'mac': listed['mac'] - listed['linux'] - shared, 'linux': listed['linux'] - listed['mac'] - shared}


class Plan:
    def __init__(self, tree, platform):
        self.platform = platform
        self.steps, self.skipped_patches, self.skipped_layers, self.borrowed = [], set(), set(), []
        text = tree.read(SERIES)
        if text is not None:
            module = series_module()
            self.steps = read_series(tree, text, platform, module)
            theirs = read_series(tree, text, OTHER[platform], module)
            for kind, name in theirs:
                if (kind, name) in self.steps:
                    continue
                if kind == 'layer':
                    self.skipped_layers.add(name)
                else:
                    self.skipped_patches.add(f'{PATCH_DIR}/{name}')
        for kind, name in self.steps:
            if kind == 'layer':
                self.borrowed.extend(read_copies(tree, name))
        self.outside = sorted({path for path in self.borrowed if not in_roots(path)})
        if self.outside:
            tree.load(self.outside)
        missing = [path for path in self.borrowed if tree.read(path) is None]
        if missing:
            raise Problem(f'a layer copies {", ".join(sorted(set(missing)))}, which is not there')
        self.foreign_units = platform_units(tree)[OTHER[platform]]
        self.lent = set(self.borrowed)

    def counts(self, path):
        if path in self.lent:
            return True
        if not in_roots(path) or path.startswith(TOOLING_PREFIXES) or path == SERIES:
            return False
        if path in self.skipped_patches or path in self.foreign_units:
            return False
        return not any(under(path, layer) for layer in self.skipped_layers)


def key(platform, rev):
    tree = GitTree(rev)
    plan = Plan(tree, platform)
    lines = [f'platform {platform}']
    lines += [f'{kind} {name}' for kind, name in plan.steps]
    lines += [f'{mode} {oid} {path}' for path, (mode, oid) in sorted(tree.entries.items()) if plan.counts(path)]
    listing = ('\n'.join(lines) + '\n').encode('utf-8', 'surrogateescape')
    return hashlib.sha1(b'blob %d\0' % len(listing) + listing).hexdigest()


def layer_excludes(tree, layer, lent):
    kept = {path for path in lent if under(path, layer)}
    if not kept:
        return [layer]
    excludes, children = [], {}
    for path in tree.files():
        if under(path, layer) and path != layer:
            child = path[len(layer) + 1:].split('/', 1)[0]
            children.setdefault(f'{layer}/{child}', path != f'{layer}/{child}')
    for child, is_dir in sorted(children.items()):
        if child in kept:
            continue
        if is_dir:
            excludes += layer_excludes(tree, child, kept)
        else:
            excludes.append(child)
    return excludes


def paths(platform):
    tree = WorkTree()
    plan = Plan(tree, platform)
    specs = list(ROOTS) + plan.outside + list(TOOLING_PATHSPECS)
    specs += [f':(exclude){path}' for path in sorted(plan.skipped_patches)]
    for layer in sorted(plan.skipped_layers):
        specs += [f':(exclude){path}' for path in layer_excludes(tree, layer, plan.lent)]
    specs += [f':(exclude){path}' for path in sorted(plan.foreign_units - plan.lent)]
    return specs


def default_platform():
    target = os.environ.get('AC_TARGET_OS')
    if target:
        return target
    system = os.uname().sysname
    if system == 'Darwin':
        return 'mac'
    if system == 'Linux':
        return 'linux'
    raise Problem(f'no engine is built on {system}: pass --platform macos or --platform linux')


def main():
    parser = argparse.ArgumentParser(prog='engine/engine-key.sh', add_help=False)
    parser.add_argument('--platform')
    parser.add_argument('--paths', action='store_true')
    parser.add_argument('commit', nargs='?', default='HEAD')
    args = parser.parse_args()
    try:
        platform = PLATFORMS.get(args.platform or default_platform())
        if platform is None:
            raise Problem(f'unknown platform {args.platform or os.environ.get("AC_TARGET_OS")}: macos or linux')
        print('\n'.join(paths(platform)) if args.paths else key(platform, args.commit))
    except Problem as problem:
        print(f'engine-key: {problem}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
