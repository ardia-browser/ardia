#!/usr/bin/env python3
import argparse
import fnmatch
import hashlib
import json
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
PLATFORMS = {'mac': 'mac', 'macos': 'mac', 'linux': 'linux', 'win': 'win', 'windows': 'win'}
ENGINES = frozenset(('mac', 'linux', 'win'))
NO_ENGINE = frozenset()
OTHERS = {'mac': ('linux', 'win'), 'linux': ('mac', 'win')}
PARSER_SELECTORS = ('all', 'mac', 'linux')
LEAVES_OUT = {'mac': 'linux', 'linux': 'mac', 'win': 'mac'}
GN_PLATFORMS = {'is_mac': 'mac', 'is_linux': 'linux', 'is_win': 'win'}
GN_TOKEN = r'\s*(\|\||&&|==|!=|<=|>=|[!()<>,\[\]]|"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_.]*|-?[0-9]+)'
GN_COMPARISONS = ('==', '!=', '<', '>', '<=', '>=')
WINDOWS_OWN_LAYERS = ('engine/chromium', 'engine/ardiacore-desktop')
GN_INTERPOLATION = r'\$(\{[^}]*\}|0x[0-9A-Fa-f]{2}|[A-Za-z_][A-Za-z0-9_]*)'
CHECKOUT = pathlib.Path(__file__).resolve().parents[1]
WIN_ROOT = 'scripts/windows/engine'
WIN_DECLARATIONS = 'scripts/windows/engine/key-inputs.json'
WIN_DECLARATIONS_V1 = 'engine/engine-key.win-v1.json'
WIN_FIRST = '991f98e9e7d382e41eee9646b94d937834bee0d2'
WIN_FIELDS = {'series': str, 'series_win': str, 'win_patches': str, 'series_tags': list, 'trees': list, 'files': list,
              'resource_lists': list, 'excluded': list, 'excluded_patterns': list}
SERIES_SELECTORS = ('all', 'mac', 'linux', 'win')


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


def selector_engines(selector):
    if selector == 'all':
        return ENGINES
    names = selector.split(',')
    return frozenset(names) if len(set(names)) == len(names) and set(names) <= ENGINES else None


def series_for(text, platform):
    lines = text.split(b'\n')
    for number, raw in enumerate(lines):
        fields = raw.split(b'#', 1)[0].split()
        if len(fields) != 3 or fields[2].decode('utf-8', 'surrogateescape') in PARSER_SELECTORS:
            continue
        engines = selector_engines(fields[2].decode('utf-8', 'surrogateescape'))
        if engines is not None:
            lines[number] = b' '.join((*fields[:2], b'all' if platform in engines else LEAVES_OUT[platform].encode()))
    return b'\n'.join(lines)


def read_series(tree, text, platform, module):
    with tempfile.TemporaryDirectory(prefix='engine-key-') as scratch:
        patches = pathlib.Path(scratch, PATCH_DIR)
        patches.mkdir(parents=True)
        (patches / 'series').write_bytes(series_for(text, platform))
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


class GnCondition:
    def __init__(self, text):
        self.tokens, self.at, rest = [], 0, text.strip()
        while rest:
            match = re.match(GN_TOKEN, rest)
            if not match:
                raise ValueError(text)
            self.tokens.append(match.group(1))
            rest = rest[match.end():]

    def peek(self):
        return self.tokens[self.at] if self.at < len(self.tokens) else None

    def take(self):
        token = self.peek()
        if token is None:
            raise ValueError('the condition ends early')
        self.at += 1
        return token

    def whole(self):
        value = self.either()
        if self.peek() is not None:
            raise ValueError(f'unexpected {self.peek()}')
        return value

    def either(self):
        true, false = self.both()
        while self.peek() == '||':
            self.take()
            more_true, more_false = self.both()
            true, false = true | more_true, false & more_false
        return true, false

    def both(self):
        true, false = self.negated()
        while self.peek() == '&&':
            self.take()
            more_true, more_false = self.negated()
            true, false = true & more_true, false | more_false
        return true, false

    def negated(self):
        if self.peek() == '!':
            self.take()
            true, false = self.negated()
            return false, true
        value = self.atom()
        if self.peek() in GN_COMPARISONS:
            self.take()
            self.atom()
            return ENGINES, ENGINES
        return value

    def atom(self):
        token = self.take()
        if token == '(':
            value = self.either()
            if self.take() != ')':
                raise ValueError('unbalanced parentheses')
            return value
        if token in GN_PLATFORMS:
            engine = frozenset((GN_PLATFORMS[token],))
            return engine, ENGINES - engine
        if token == 'true':
            return ENGINES, NO_ENGINE
        if token == 'false':
            return NO_ENGINE, ENGINES
        if token[0].isalnum() or token[0] in '_"-':
            if self.peek() == '(':
                self.take()
                depth = 1
                while depth:
                    depth += {'(': 1, ')': -1}.get(self.take(), 0)
            return ENGINES, ENGINES
        raise ValueError(f'unexpected {token}')


def gn_engines(condition):
    try:
        return GnCondition(condition).whole()[0]
    except ValueError:
        return ENGINES


class GnLost(Exception):
    pass


def gn_string_end(text, index):
    cursor = index + 1
    while cursor < len(text) and text[cursor] != '"':
        cursor += 2 if text[cursor] == '\\' else 1
    return cursor


def gn_condition_end(text, opening):
    depth, cursor = 0, opening
    while cursor < len(text):
        char = text[cursor]
        if char == '"':
            cursor = gn_string_end(text, cursor)
        elif char == '#':
            end = text.find('\n', cursor)
            cursor = len(text) if end < 0 else end
            continue
        elif char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                return cursor
        cursor += 1
    raise GnLost(opening)


def gn_strings(text, flat=False):
    stack, pending, index, length = [ENGINES], None, 0, len(text)
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
            if name == 'if' and not flat:
                opening = index + len(name)
                while opening < length and text[opening] in ' \t\r\n':
                    opening += 1
                if opening >= length or text[opening] != '(':
                    raise GnLost(index)
                cursor = gn_condition_end(text, opening)
                pending = stack[-1] & gn_engines(text[opening + 1:cursor])
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


def interpolated_unit(value):
    if '$' not in value:
        return False
    tail = re.split(GN_INTERPOLATION, value)[-1]
    extension = re.search(r'\.[A-Za-z0-9_+-]+$', tail)
    return extension is None or extension.group(0) in UNITS


def foreign_units(tree, platform):
    built_for, anywhere = {}, NO_ENGINE
    files = set(tree.files())
    roots = source_roots(files)
    for path in sorted(files):
        if not path.startswith('engine/') or posixpath.basename(path) != 'BUILD.gn':
            continue
        base = posixpath.dirname(path)
        text = tree.read(path).decode('utf-8', 'surrogateescape')
        try:
            strings = list(gn_strings(text))
        except GnLost:
            strings = list(gn_strings(text, flat=True))
        for context, value in strings:
            if interpolated_unit(value):
                anywhere |= context
                continue
            if not value.endswith(UNITS):
                continue
            sources, ambiguous = gn_sources(value, base, roots, files)
            for source in sources:
                built_for[source] = built_for.get(source, NO_ENGINE) | (ENGINES if ambiguous else context)
    return {path for path, engines in built_for.items() if platform not in engines | anywhere}


class Plan:
    def __init__(self, tree, platform):
        self.platform = platform
        self.steps, self.skipped_patches, self.skipped_layers, self.borrowed = [], set(), set(), []
        text = tree.read(SERIES)
        if text is not None:
            module = series_module()
            self.steps = read_series(tree, text, platform, module)
            theirs = [step for other in OTHERS[platform] for step in read_series(tree, text, other, module)]
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
        self.foreign_units = foreign_units(tree, platform)
        self.lent = set(self.borrowed)

    def counts(self, path):
        if path in self.lent:
            return True
        if not in_roots(path) or path.startswith(TOOLING_PREFIXES) or path == SERIES:
            return False
        if path in self.skipped_patches or path in self.foreign_units:
            return False
        return not any(under(path, layer) for layer in self.skipped_layers)


def repo_path(value):
    if not isinstance(value, str) or not value or value.startswith('/') or '\\' in value:
        return None
    parts = [part for part in value.split('/') if part not in ('', '.')]
    return '/'.join(parts) if parts and '..' not in parts else None


def text_of(tree, path):
    raw = tree.read(path)
    return None if raw is None else raw.decode('utf-8', 'surrogateescape').replace('\r\n', '\n').replace('\r', '\n')


def win_declarations(tree, rev):
    raw, origin, first = tree.read(WIN_DECLARATIONS), f'{rev}:{WIN_DECLARATIONS}', False
    if raw is None:
        path = CHECKOUT / WIN_DECLARATIONS_V1
        if not path.is_file():
            raise Problem(f'{rev} has no {WIN_DECLARATIONS}, and {WIN_DECLARATIONS_V1}, the first Windows plan, is not in this checkout')
        raw, origin, first = path.read_bytes(), WIN_DECLARATIONS_V1, True
    return normalized_declarations(raw, origin), origin, first


def normalized_declarations(raw, origin):
    try:
        data = json.loads(raw)
    except ValueError as error:
        raise Problem(f'{origin} is not JSON: {error}')
    if not isinstance(data, dict) or set(data) != set(WIN_FIELDS):
        raise Problem(f'{origin}: expected exactly the fields {", ".join(sorted(WIN_FIELDS))}')
    for name, kind in WIN_FIELDS.items():
        value = data[name]
        values = value if kind is list else [value]
        paths = [repo_path(item) for item in values] if isinstance(value, kind) else [None]
        if None in paths:
            raise Problem(f'{origin}: {name} must be {"a list of relative paths" if kind is list else "a relative path"} without ..')
        data[name] = paths if kind is list else paths[0]
    unknown = [tag for tag in data['series_tags'] if tag not in SERIES_SELECTORS]
    if unknown:
        raise Problem(f'{origin}: series_tags names {", ".join(unknown)}; the series knows {", ".join(SERIES_SELECTORS)}')
    return data


def chromium_names(text, origin, tags, takes=()):
    names = []
    for number, raw in enumerate((text or '').split('\n'), 1):
        fields = raw.split('#', 1)[0].split()
        if not fields or fields[0] not in ('chromium', 'layer'):
            continue
        if len(fields) not in (2, 3):
            raise Problem(f'{origin}:{number}: expected `{fields[0]} <name> [all|<platform>[,<platform>…]]`, platforms '
                          f'{", ".join(sorted(ENGINES))}: {raw.strip()}')
        tag = fields[2] if len(fields) == 3 else 'all'
        engines = selector_engines(tag)
        if engines is None:
            raise Problem(f'{origin}:{number}: unknown platform `{tag}`; the series knows all, or one or more of '
                          f'{", ".join(sorted(ENGINES))} joined by commas')
        if fields[0] == 'layer':
            if 'win' in engines and fields[1] not in WINDOWS_OWN_LAYERS:
                raise Problem(f'{origin}:{number}: `{fields[1]}` is a layer for win, and the Windows build runs no series '
                              f'layer yet but {", ".join(WINDOWS_OWN_LAYERS)}: teach series_win.py to apply it, or select '
                              'platforms without win')
            continue
        if not safe_relative(fields[1]) or '/' in fields[1]:
            raise Problem(f'{origin}:{number}: `{fields[1]}` is not a patch file name')
        if (tag == 'all' and 'all' in tags) or (tag != 'all' and any(engine in tags for engine in engines)) or fields[1] in takes:
            names.append(fields[1])
    return names


def directive_names(text, directive):
    return {line.split(None, 1)[1].strip() for line in (raw.split('#', 1)[0].strip() for raw in (text or '').split('\n'))
            if line.startswith(directive + ' ')}


def skip_names(text):
    return directive_names(text, 'skip')


def take_names(text):
    return directive_names(text, 'take')


def resource_sources(text, origin):
    sources = []
    for number, line in enumerate((text or '').splitlines(), 1):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        source = repo_path(parts[0]) if len(parts) == 2 else None
        if source is None:
            raise Problem(f'{origin}:{number}: expected `<source> <dest>`, a relative source without ..')
        sources.append(source)
    return sources


def tracked_under(tree, roots):
    if isinstance(tree.entries, dict):
        return set()
    listing = git('ls-files', '-z', '--full-name', '--', *roots, check=False).stdout
    return {path.decode('utf-8', 'surrogateescape') for path in listing.split(b'\0') if path}


class WinPlan:
    def __init__(self, tree, rev='the tree', complete=True):
        tree.load((WIN_ROOT,))
        if not any(under(path, WIN_ROOT) for path in tree.files()):
            raise Problem(f'{rev} has no {WIN_ROOT}')
        data, origin, first = win_declarations(tree, rev)
        self.trees = tuple(data['trees'])
        self.series = (data['series'], data['series_win'])
        tree.load(sorted({*data['trees'], *data['files'], *data['resource_lists'], *self.series, data['win_patches']}))
        modes = tree.entries if isinstance(tree.entries, dict) else {}
        linked = [path for path in (WIN_DECLARATIONS, *self.series, *data['resource_lists']) if modes.get(path, ('',))[0] == '120000']
        if linked:
            raise Problem(f'{rev}: {", ".join(linked)} {"is a symlink" if len(linked) == 1 else "are symlinks"}; the key reads '
                          'these as text and would hash the link, not the list the build reads')
        stray = [path for path in data['excluded']
                 if not any(under(path, tree_root) and path != tree_root for tree_root in data['trees'])]
        if stray:
            raise Problem(f'{origin}: excluded must name paths inside a declared tree, not {", ".join(stray)}')
        series_win = text_of(tree, data['series_win'])
        skips = skip_names(series_win)
        takes = take_names(series_win)
        shared = [name for name in chromium_names(text_of(tree, data['series']), f'{rev}:{data["series"]}', data['series_tags'], takes)
                  if name not in skips]
        own = chromium_names(series_win, f'{rev}:{data["series_win"]}', data['series_tags'])
        self.patches = [f'{posixpath.dirname(data["series"])}/{name}' for name in shared] + [f'{data["win_patches"]}/{name}' for name in own]
        resources = []
        for listing in data['resource_lists']:
            resources += resource_sources(text_of(tree, listing), f'{rev}:{listing}')
        tree.load(sorted(set(resources)))
        applied = set(self.patches)
        self.listed = frozenset({*data['files'], *data['resource_lists'], *self.patches, *resources})
        files = set(tree.files()) | tracked_under(tree, data['trees'])
        excluded = set(data['excluded'])
        excluded |= {path for path in files if under(path, data['win_patches']) and path not in applied}
        excluded |= {path for path in files if any(fnmatch.fnmatchcase(path, pattern) for pattern in data['excluded_patterns'])}
        self.excluded = sorted(excluded)
        clash = sorted(path for path in self.listed if any(under(path, out) for out in excluded)
                       or any(fnmatch.fnmatchcase(path, pattern) for pattern in data['excluded_patterns']))
        if clash:
            raise Problem(f'{origin}: the Windows build reads {", ".join(clash)}, which the key inputs exclude')
        self.steps = [('chromium', path) for path in self.patches]
        linked = sorted(path for path, (mode, _) in modes.items() if mode == '120000' and self.counts(path))
        if linked:
            raise Problem(f'{rev}: the Windows key inputs {", ".join(linked)} are symlinks; the build copies what they point at, '
                          'which the key would not hash: commit the file itself')
        missing = sorted(path for path in self.listed if path not in tree.entries)
        if missing and complete:
            if first:
                raise Problem(f'{rev} predates {WIN_DECLARATIONS}; the first Windows plan ({WIN_DECLARATIONS_V1}) keys commits '
                              f'from {WIN_FIRST[:9]} on, and {rev} lacks {", ".join(missing)}')
            raise Problem(f'the Windows build reads {", ".join(missing)}, which is not there')

    def counts(self, path):
        if path in self.series:
            return False
        if path in self.listed:
            return True
        return any(under(path, tree) for tree in self.trees) and not any(under(path, out) for out in self.excluded)

    def pathspecs(self):
        specs = list(self.trees) + list(self.series)
        specs += sorted(path for path in self.listed if not any(under(path, tree) for tree in self.trees))
        return specs + [f':(exclude){path}' for path in self.excluded]


def key(platform, rev):
    tree = GitTree(rev)
    plan = WinPlan(tree, rev) if platform == 'win' else Plan(tree, platform)
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
    if platform == 'win':
        return WinPlan(tree, complete=False).pathspecs()
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
    raise Problem(f'no engine is built on {system}: pass --platform macos, --platform linux or --platform win')


def main():
    parser = argparse.ArgumentParser(prog='engine/engine-key.sh', add_help=False)
    parser.add_argument('--platform')
    parser.add_argument('--paths', action='store_true')
    parser.add_argument('commit', nargs='?', default='HEAD')
    args = parser.parse_args()
    try:
        platform = PLATFORMS.get(args.platform or default_platform())
        if platform is None:
            raise Problem(f'unknown platform {args.platform or os.environ.get("AC_TARGET_OS")}: macos, linux or win')
        print('\n'.join(paths(platform)) if args.paths else key(platform, args.commit))
    except Problem as problem:
        print(f'engine-key: {problem}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
