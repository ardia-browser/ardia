#!/usr/bin/env python3
"""Our series on a Windows tree: the `chromium` lines of engine/patches/series that are for every platform or whose
platforms include `mac` or `win` (Windows started from the Mac's set; `linux` lines are never applied, `linux,win`
lines are; a `layer` line it would select, untagged or naming win, is refused until this script runs series layers,
engine/chromium aside), then those of
scripts/windows/engine/series-win (when it exists; its patches in scripts/windows/engine/patches,
and its `skip <patch>` lines leave a patch of engine/patches/series out), each applied strictly (git apply), else with patch's fuzz.
A patch that fails is recorded and the rest still run. Each patch that goes in is written to .series-win-applied beside
the tree and never applied again: a later patch on the same lines would hide it from a reverse check. Of the layers, engine/chromium runs as is (its
chrome/browser/ardia gets a Windows BUILD.gn made from the shared one (its shared sources less .mm and pip/, plus the
portable files of its Mac block named in WINDOWS_FROM_MAC_BLOCK), the fixes in
ardia-layer-win.patch that make its sources build on Windows, and the files under src/chrome/browser/ardia in place of
the ones that are POSIX only), engine/ardiacore
gives the hook headers the patches include and ac_launch_switches (its Mac signature check answers no), and
scripts/windows/engine/src/ardia/win (the app in the browser process, with the app's EngineApi.h and a generated table
of the engine's ac_* calls in the sources Windows compiles) is copied to //ardia/win, only the files that changed. Writes a table: patch, result, which files it touches (Mac only, Mac and shared, OS-neutral).

Usage: series_win.py apply --report TSV | layer | classify (CHROMIUM_SRC is the tree)
"""
import argparse
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
PATCHES = os.path.join(REPO, 'engine', 'patches')
WIN_PATCHES = os.path.join(HERE, 'patches')
HOOK_HEADERS = ['ardia/core/ac_hooks.h', 'ardia/core/ac_content_hooks.h', 'ardia/core/ac_host_visibility.h']
ARDIA_LAYER = os.path.join(REPO, 'engine/chromium/src/chrome/browser/ardia')
LAUNCH_SWITCHES = 'ardia/core/ac_launch_switches'
LAYER_PATCH = os.path.join(HERE, 'ardia-layer-win.patch')
LAYER_OVERLAY = os.path.join(HERE, 'src', 'chrome', 'browser', 'ardia')
MAC_LAYER_LINE = re.compile(r'(\.mm"|"pip/|"ac_external_apps\.h")')
LIST_ENTRY_LINE = re.compile(r'^\s*"[^"$\\]*",?\s*$')
GN_PAIRS = {'(': ')', '[': ']', '{': '}'}
ENGINES = ('mac', 'linux', 'win')
WINDOWS_TAGS = ('all', 'mac', 'win')
SERIES_TAGS = ('all',) + ENGINES
WINDOWS_FROM_MAC_BLOCK = ('ac_reauth.cc',)
GN_PLATFORMS = {'is_mac': False, 'is_linux': False, 'is_win': True}
GN_TOKEN = re.compile(r'\s*(\|\||&&|[!()]|[A-Za-z_][A-Za-z0-9_]*)')
WINDOWS_OWN_LAYERS = ('engine/chromium',)
GN_LEXEME = re.compile(r'\s+|#[^\n]*|"(?:[^"\\\n]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|\+=|-=|==|!=|<=|>=|&&|\|\||[{}\[\](),.=<>!+-]')
GN_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
GN_BINARY = ('+', '-', '==', '!=', '<', '>', '<=', '>=', '&&', '||')
LAYER_ASSERT = re.compile(r'^assert\(is_mac( \|\| is_linux)?\)$', re.M)
LAYER_BUILD = 'engine/chromium/src/chrome/browser/ardia/BUILD.gn'
SERIES_REL = 'engine/patches/series'
SERIES_WIN_REL = 'scripts/windows/engine/series-win'
WIN_PATCHES_REL = 'scripts/windows/engine/patches'
ENGINE_API_REL = 'apps/browser/windows/Ardia/EngineApi.h'
KEY_INPUTS = os.path.join(HERE, 'key-inputs.json')
MAC_FILE = re.compile(r'(\.mm$|_mac(_[a-z]+)?\.(cc|h)$|/mac/|cocoa|_apple\.(cc|h|mm)$|/apple/|keychain|\.icns$|\.car$)')


class InputError(Exception):
    pass


def where(path, line):
    return f'{os.path.relpath(path, REPO)}:{line}'


def read_file(path, mode='r', **options):
    with open(path, mode, **options) as f:
        return f.read()


def checkout_path(rel):
    return os.path.join(REPO, *rel.split('/'))


def checkout_text(rel):
    path = checkout_path(rel)
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return f.read()


def chromium_lines(path, tags=WINDOWS_TAGS):
    if not os.path.isfile(path):
        return []
    with open(path) as f:
        return series_lines(f.read(), path, tags)


def selector_tags(selector):
    if selector == 'all':
        return ('all',)
    names = selector.split(',')
    return tuple(names) if len(set(names)) == len(names) and all(name in ENGINES for name in names) else None


def series_lines(text, path, tags=WINDOWS_TAGS):
    if text is None:
        return []
    out = []
    for n, raw in enumerate(io.StringIO(text), 1):
        fields = raw.split('#', 1)[0].split()
        if not fields or fields[0] not in ('chromium', 'layer'):
            continue
        if len(fields) not in (2, 3):
            raise InputError(f'{where(path, n)}: expected `{fields[0]} <name> [all|<platform>[,<platform>…]]`, platforms '
                             f'{", ".join(ENGINES)}: {raw.strip()}')
        line_tags = selector_tags(fields[2] if len(fields) == 3 else 'all')
        if line_tags is None:
            raise InputError(f'{where(path, n)}: unknown platform `{fields[2]}`; this script knows all, or one or more of '
                             f'{", ".join(ENGINES)} joined by commas')
        if fields[0] == 'layer':
            if ('all' in line_tags or 'win' in line_tags) and fields[1] not in WINDOWS_OWN_LAYERS:
                raise InputError(f'{where(path, n)}: `{fields[1]}` is a layer for win, and this script runs no series layer '
                                 f'yet but {", ".join(WINDOWS_OWN_LAYERS)}: teach it to apply the layer, or select '
                                 'platforms without win')
            continue
        if any(tag in tags for tag in line_tags):
            out.append(fields[1])
    return out


def patch_files(path):
    files = []
    for line in read_file(path, encoding='utf-8', errors='surrogateescape').splitlines(True):
        m = re.match(r'^\+\+\+ (?:b/)?(\S+)', line)
        if m and m.group(1) != '/dev/null' and m.group(1) not in files:
            files.append(m.group(1))
    return files


def classify(files):
    mac = [f for f in files if MAC_FILE.search(f)]
    if not mac:
        return 'OS-neutral'
    return 'Mac only' if len(mac) == len(files) else 'Mac and shared'


def run(cmd, cwd):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def applied(path, tree):
    return run(['git', 'apply', '--check', '-R', path], tree).returncode == 0 or \
        run(['patch', '-p1', '--dry-run', '-R', '-s', '-f', '-i', path], tree).returncode == 0


def apply_one(path, tree):
    if applied(path, tree):
        return 'already applied', ''
    p = run(['git', 'apply', '--whitespace=nowarn', path], tree)
    if p.returncode == 0:
        return 'clean', ''
    strict_error = p.stderr.strip()
    p = run(['patch', '-p1', '--forward', '--dry-run', '-i', path], tree)
    if p.returncode != 0:
        detail = ' | '.join(l for l in (strict_error + '\n' + p.stdout + p.stderr).splitlines()
                            if re.search(r'fail|error|reject|does not|can\'t find', l, re.I))
        return 'FAILED', detail[:500]
    p = run(['patch', '-p1', '--forward', '--no-backup-if-mismatch', '-i', path], tree)
    if p.returncode != 0:
        return 'FAILED', (p.stdout + p.stderr).strip()[:500]
    how = [l.strip() for l in p.stdout.splitlines() if 'fuzz' in l or 'offset' in l]
    return 'with fuzz/offset', '; '.join(how)[:500]


def layers(tree):
    replaced = chromium_layer(tree)
    for rel in HOOK_HEADERS:
        dst = os.path.join(tree, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(REPO, 'engine/ardiacore/src', rel), dst)
    print(f'engine/chromium: {replaced} files changed; {len(HOOK_HEADERS)} ArdiaCore hook headers copied')
    win_layer(tree)


def copy_if_changed(source, target):
    data = read_file(source, 'rb')
    if os.path.isfile(target) and read_file(target, 'rb') == data:
        return 0
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'wb') as f:
        f.write(data)
    return 1


def files_under(root):
    found = {}
    for folder, _, files in os.walk(root):
        for name in files:
            if not name.startswith('.'):
                path = os.path.join(folder, name)
                found[os.path.relpath(path, root)] = path
    return found


def chromium_layer(tree):
    source_root = os.path.join(REPO, 'engine/chromium/src')
    owned = os.path.join('chrome', 'browser', 'ardia')
    changed = 0
    for rel, path in files_under(source_root).items():
        if rel == owned or rel.startswith(owned + os.sep):
            continue
        target = os.path.join(tree, rel)
        if not os.path.isfile(target):
            sys.exit(f'series_win.py: {rel} is not in the tree: engine/chromium/src replaces files, it adds none')
        changed += copy_if_changed(path, target)
    with tempfile.TemporaryDirectory() as scratch:
        work = os.path.join(scratch, 'ardia')
        prepare_layer(work)
        wanted = files_under(work)
        target_root = os.path.join(tree, owned)
        for rel, path in wanted.items():
            changed += copy_if_changed(path, os.path.join(target_root, rel))
        for rel, path in files_under(target_root).items():
            if rel not in wanted:
                os.remove(path)
                changed += 1
    return changed


def write_if_changed(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.isfile(path) and read_file(path, encoding='utf-8') == text:
        return 0
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return 1


def prepare_layer(work):
    patched_layer(work)
    with open(os.path.join(work, 'BUILD.gn'), 'w', encoding='utf-8') as f:
        f.write(ardia_build_file())


def patched_layer(work):
    shutil.copytree(ARDIA_LAYER, work)
    p = run(['patch', '-p1', '-F0', '-s', '--no-backup-if-mismatch', '-i', LAYER_PATCH], work)
    if p.returncode:
        raise InputError(f'{os.path.relpath(LAYER_PATCH, REPO)} does not apply to engine/chromium/src/chrome/browser/ardia '
                         f'without fuzz: {(p.stdout + p.stderr).strip()[:600]}')
    for rel, path in files_under(LAYER_OVERLAY).items():
        shutil.copyfile(path, os.path.join(work, rel))
    return work


def build_text():
    return read_file(os.path.join(REPO, LAYER_BUILD), encoding='utf-8')


def line_of(text, needle):
    return text[:text.index(needle)].count('\n') + 1 if needle in text else 1


def once(text, needle, what):
    count = text.count(needle)
    if count != 1:
        raise InputError(f'{where(os.path.join(REPO, LAYER_BUILD), line_of(text, needle))}: the Windows build needs '
                         f'{what} exactly once ({needle.strip()!r}), found {count}')


def ardia_build_file():
    text = build_text()
    asserts = LAYER_ASSERT.findall(text)
    if len(asserts) != 1:
        raise InputError(f'{where(os.path.join(REPO, LAYER_BUILD), line_of(text, "assert("))}: the Windows build needs one '
                         f'`assert(is_mac)` or `assert(is_mac || is_linux)` to turn into `assert(is_win)`')
    if not re.search(r'^ardia_sources = \[', text, re.M):
        raise InputError(f'{where(os.path.join(REPO, LAYER_BUILD), 1)}: the Windows build needs the shared source list '
                         '(`ardia_sources = [` at the top level)')
    for needle, what in (('source_set("ardia") {\n', 'the layer target'),
                         ('config("exports_config")', 'the exports config it cuts at'),
                         ('    "//ardia/core:hooks",\n', 'the hooks dependency it drops'),
                         ('    "//ardia/core:launch_switches",\n', 'the launch switches dependency it replaces')):
        once(text, needle, what)
    text = LAYER_ASSERT.sub('assert(is_win)', text)
    for number, line in enumerate(text.splitlines(), 1):
        if MAC_LAYER_LINE.search(line) and not LIST_ENTRY_LINE.match(line):
            raise InputError(f'{where(os.path.join(REPO, LAYER_BUILD), number)}: the Windows build drops Mac-only sources a list '
                             f'entry at a time, and this line holds more than one entry: {line.strip()}')
    text = ''.join(line for line in text.splitlines(True) if not MAC_LAYER_LINE.search(line))
    text = text.replace('    "//ardia/core:hooks",\n', '')
    text = text.replace('    "//ardia/core:launch_switches",\n', '    "//ardia/win:launch_switches",\n')
    taken = ''.join(f'    "{name}",\n' for name in WINDOWS_FROM_MAC_BLOCK)
    text = text.replace('source_set("ardia") {\n', f'if (is_win) {{\n  ardia_sources += [\n{taken}  ]\n}}\n\nsource_set("ardia") {{\n')
    return text[:text.index('config("exports_config")')].rstrip() + '\n'


def windows_takes(condition):
    tokens, index, condition = [], 0, condition.strip()
    while index < len(condition):
        match = GN_TOKEN.match(condition, index)
        if not match:
            return None
        tokens.append(match.group(1))
        index = match.end()

    def either(at):
        value, at = both(at)
        while at < len(tokens) and tokens[at] == '||':
            more, at = both(at + 1)
            value = None if value is None or more is None else value or more
        return value, at

    def both(at):
        value, at = negated(at)
        while at < len(tokens) and tokens[at] == '&&':
            more, at = negated(at + 1)
            value = None if value is None or more is None else value and more
        return value, at

    def negated(at):
        if at < len(tokens) and tokens[at] == '!':
            value, at = negated(at + 1)
            return None if value is None else not value, at
        if at < len(tokens) and tokens[at] == '(':
            value, at = either(at + 1)
            if at >= len(tokens) or tokens[at] != ')':
                raise ValueError(condition)
            return value, at + 1
        if at < len(tokens) and tokens[at] in GN_PLATFORMS:
            return GN_PLATFORMS[tokens[at]], at + 1
        raise ValueError(condition)

    try:
        value, at = either(0)
    except ValueError:
        return None
    return value if at == len(tokens) else None


class GnReader:
    def __init__(self, text):
        self.text, self.tokens, self.at, self.found, self.listed, self.scopes = text, [], 0, [], [], []
        index, line = 0, 1
        while index < len(text):
            match = GN_LEXEME.match(text, index)
            if not match:
                self.fail(line, f'a character it can\'t read: {text[index:index + 20]!r}')
            lexeme = match.group(0)
            if not lexeme.isspace() and not lexeme.startswith('#'):
                self.tokens.append((lexeme, line, index, match.end()))
            line += lexeme.count('\n')
            index = match.end()

    def fail(self, line, what):
        raise InputError(f'{where(os.path.join(REPO, LAYER_BUILD), line)}: the Windows build can\'t read {what}')

    def peek(self, ahead=0):
        at = self.at + ahead
        return self.tokens[at][0] if at < len(self.tokens) else None

    def line(self):
        return self.tokens[min(self.at, len(self.tokens) - 1)][1] if self.tokens else 1

    def take(self, expected=None):
        if self.at >= len(self.tokens):
            self.fail(self.line(), f'the end of the file where it expected {expected or "more"}')
        token = self.tokens[self.at]
        if expected is not None and token[0] != expected:
            self.fail(token[1], f'`{token[0]}` where it expected `{expected}`')
        self.at += 1
        return token

    def sources(self):
        self.block(True, False)
        return self.found

    def block(self, active, closed):
        while True:
            token = self.peek()
            if token is None:
                if closed:
                    self.fail(self.line(), 'a block that never closes')
                return
            if token == '}':
                if not closed:
                    self.fail(self.line(), 'a `}` that closes nothing')
                self.take()
                return
            self.statement(active)

    def statement(self, active):
        name, line, _, _ = self.take()
        if name == 'if':
            return self.conditional(active, line)
        if not GN_NAME.match(name) or name in ('else', 'true', 'false'):
            self.fail(line, f'a statement starting with `{name}`')
        if self.peek() == '(':
            self.group('(', ')')
            if self.peek() == '{':
                self.take('{')
                self.scopes.append(name)
                self.block(active, True)
                self.scopes.pop()
            return
        while self.peek() in ('.', '['):
            if self.take()[0] == '.':
                self.take()
            else:
                self.expression()
                self.take(']')
        operator = self.peek()
        if operator not in ('=', '+=', '-='):
            self.fail(line, f'`{name}` followed by `{operator}`')
        self.take()
        value = self.expression()
        if name == 'ardia_sources':
            if self.scopes:
                self.fail(line, f'`ardia_sources {operator}` inside the block of `{self.scopes[-1]}(...)`, a scope of its own '
                                'that GN drops when it closes; change the list outside it')
            if operator == '-=' or value[0] != 'list':
                self.fail(line, f'`ardia_sources {operator}` with anything but a list of names; it can\'t follow sources '
                                'taken out of the list')
            if active:
                self.listed = self.names(value[1], line) if operator == '=' else self.listed + self.names(value[1], line)
        elif name == 'sources' and 'foreach' in self.scopes:
            self.fail(line, f'`sources {operator}` inside a `foreach(...)` loop, which may run any number of times; list the '
                            'sources outside it')
        elif name == 'sources' and active:
            if operator == '=' and value == ('name', 'ardia_sources'):
                self.found.extend(self.listed)
                return
            if operator == '+=' and value[0] == 'list':
                self.found.extend(self.names(value[1], line))
                return
            self.fail(line, f'`sources {operator}` here: it only follows `sources = ardia_sources` and `sources += [...]`')

    def names(self, listed, line):
        spelled = [name for name in listed if '$' in name or '\\' in name]
        if spelled:
            self.fail(line, f'a source spelled with $ or \\ ({", ".join(spelled)}); name each source as it is')
        return list(listed)

    def conditional(self, active, line):
        taken = self.condition(line)
        self.take('{')
        self.block(active and taken, True)
        settled = taken
        while self.peek() == 'else':
            self.take()
            if self.peek() == 'if':
                branch_line = self.take()[1]
                taken = self.condition(branch_line)
                self.take('{')
                self.block(active and not settled and taken, True)
                settled = settled or taken
                continue
            self.take('{')
            self.block(active and not settled, True)
            return

    def condition(self, line):
        first = self.at + 1
        self.group('(', ')')
        inner = self.tokens[first:self.at - 1]
        shown = self.text[inner[0][2]:inner[-1][3]] if inner else ''
        taken = windows_takes(' '.join(token[0] for token in inner))
        if taken is None:
            raise InputError(f'{where(os.path.join(REPO, LAYER_BUILD), line)}: the Windows build can\'t tell whether it takes '
                             f'`if ({shown})`; it reads {", ".join(GN_PLATFORMS)} joined by !, &&, || and parentheses')
        return taken

    def group(self, opening, closing):
        self.take(opening)
        waiting = [closing]
        while waiting:
            token, line, _, _ = self.take()
            if token in GN_PAIRS:
                waiting.append(GN_PAIRS[token])
            elif token in GN_PAIRS.values():
                expected = waiting.pop()
                if token != expected:
                    self.fail(line, f'`{token}` where it expected `{expected}` to close a bracket')

    def expression(self):
        value = self.unary()
        while self.peek() in GN_BINARY:
            self.take()
            self.unary()
            value = ('other',)
        return value

    def unary(self):
        if self.peek() in ('!', '-'):
            self.take()
            self.unary()
            return ('other',)
        return self.primary()

    def primary(self):
        token, line, _, _ = self.take()
        if token == '[':
            names, plain = [], True
            while self.peek() != ']':
                item = self.expression()
                if item[0] == 'string':
                    names.append(item[1])
                else:
                    plain = False
                if self.peek() == ',':
                    self.take()
                elif self.peek() != ']':
                    self.fail(self.line(), f'`{self.peek()}` inside a list')
            self.take(']')
            return ('list', names) if plain else ('other',)
        if token == '(':
            self.expression()
            self.take(')')
            return ('other',)
        if token == '{':
            self.scopes.append('{')
            self.block(False, True)
            self.scopes.pop()
            return ('other',)
        if token.startswith('"'):
            return ('string', token[1:-1])
        if token.isdigit():
            return ('other',)
        if not GN_NAME.match(token):
            self.fail(line, f'`{token}` where it expected a value')
        value = ('name', token)
        while self.peek() in ('(', '.', '['):
            if self.peek() == '(':
                self.group('(', ')')
            elif self.take()[0] == '.':
                self.take()
            else:
                self.expression()
                self.take(']')
            value = ('other',)
        return value


def windows_sources(text):
    return GnReader(text).sources()


def launch_switches_source():
    text = read_file(os.path.join(REPO, 'engine/ardiacore/src', LAUNCH_SWITCHES + '.cc'), encoding='utf-8')
    signed = re.compile(r'bool SignedForDistribution\(\) \{\n.*?\n\}\n', re.S)
    mock = ('  if (!CommandLine().HasSwitch(os_crypt::switches::kUseMockKeychain)) {\n'
            '    return "not on the mock keychain";\n  }\n')
    native = 'return CommandLine().GetSwitchValueNative(name);'
    for needed in ('#include <Security/Security.h>\n\n', '#include "base/apple/scoped_cftyperef.h"\n', mock, native):
        if text.count(needed) != 1:
            sys.exit(f'series_win.py: {LAUNCH_SWITCHES}.cc has no {needed.strip()[:60]}')
    text = text.replace('#include <Security/Security.h>\n\n', '').replace('#include "base/apple/scoped_cftyperef.h"\n', '')
    text = text.replace(mock, '').replace(native, 'return CommandLine().GetSwitchValueUTF8(name);')
    if len(signed.findall(text)) != 1:
        sys.exit(f'series_win.py: {LAUNCH_SWITCHES}.cc has no SignedForDistribution')
    refusal = '    return "signed for distribution";\n'
    if text.count(refusal) != 1:
        sys.exit(f'series_win.py: {LAUNCH_SWITCHES}.cc has no signed-for-distribution refusal')
    text = text.replace(refusal, '    return "the engine\'s launch gate refused it (see ardia/win/test_gate.cc)";\n')
    return signed.sub('bool SignedForDistribution() {\n  return !CommandLine().HasSwitch("ardia-test-instance");\n}\n', text)


def engine_calls(layer):
    names = set()
    for rel in windows_sources(ardia_build_file()):
        if rel.endswith('.cc'):
            path = os.path.join(layer, rel)
            if not os.path.isfile(path):
                raise InputError(f'{LAYER_BUILD}: Windows compiles `{rel}`, which is not in the layer')
            text = read_file(path, encoding='utf-8')
            names.update(re.findall(r'^AC_(?:PROFILE|ARGS|ENGINE)_CALL\((ac_\w+)', text, re.M))
    return sorted(names)


def engine_calls_source(names):
    lines = ['#include "ardia/win/ac_calls.h"', '', 'extern "C" {']
    lines += [f'void {name}(const char*, const char*, ac_engine_reply_t, void*);' for name in names]
    lines += ['}', '', 'namespace ardia_win {', '', 'ac_engine_call_t FindEngineCall(std::string_view name) {',
              '  static constexpr struct {', '    std::string_view name;', '    ac_engine_call_t call;',
              '  } kCalls[] = {']
    lines += [f'      {{"{name}", &{name}}},' for name in names]
    lines += ['  };', '  for (const auto& entry : kCalls) {', '    if (entry.name == name) {',
              '      return entry.call;', '    }', '  }', '  return nullptr;', '}', '', '}', '']
    return '\n'.join(lines)


def win_layer(tree):
    source = os.path.join(HERE, 'src', 'ardia', 'win')
    target = os.path.join(tree, 'ardia', 'win')
    wanted = {}
    for root, _, files in os.walk(source):
        for name in files:
            path = os.path.join(root, name)
            wanted[os.path.relpath(path, source)] = path
    wanted[os.path.join('public', 'EngineApi.h')] = checkout_path(ENGINE_API_REL)
    copied = 0
    for rel, path in wanted.items():
        dst = os.path.join(target, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.isfile(dst) or read_file(dst, 'rb') != read_file(path, 'rb'):
            shutil.copyfile(path, dst)
            copied += 1
    names = engine_calls(os.path.join(tree, 'chrome', 'browser', 'ardia'))
    generated = {'ac_calls.cc': engine_calls_source(names)}
    for rel, text in generated.items():
        copied += write_if_changed(os.path.join(target, rel), text)
    for root, _, files in os.walk(target):
        for name in files:
            path = os.path.join(root, name)
            rel = os.path.relpath(path, target)
            if rel not in wanted and rel not in generated:
                os.remove(path)
    copied += write_if_changed(os.path.join(tree, LAUNCH_SWITCHES + '.cc'), launch_switches_source())
    shutil.copyfile(os.path.join(REPO, 'engine/ardiacore/src', LAUNCH_SWITCHES + '.h'),
                    os.path.join(tree, LAUNCH_SWITCHES + '.h'))
    print(f'ardia/win: {len(wanted) + len(generated)} files, {len(names)} engine calls, {copied} changed')


def skip_names(text):
    if text is None:
        return set()
    return {l.split(None, 1)[1].strip() for l in (r.split('#', 1)[0].strip() for r in io.StringIO(text))
            if l.startswith('skip ')}


def skipped():
    return skip_names(checkout_text(SERIES_WIN_REL))


def plan_patches(read):
    skips = skip_names(read(SERIES_WIN_REL))
    shared = [n for n in series_lines(read(SERIES_REL), checkout_path(SERIES_REL)) if n not in skips]
    own = series_lines(read(SERIES_WIN_REL), checkout_path(SERIES_WIN_REL))
    return [(n, f'engine/patches/{n}') for n in shared] + [(n, f'{WIN_PATCHES_REL}/{n}') for n in own]


def names():
    return [(n, checkout_path(rel)) for n, rel in plan_patches(checkout_text)]


def state_path(tree):
    return os.path.join(os.path.dirname(os.path.abspath(tree)), '.series-win-applied')


def read_state(tree):
    path = state_path(tree)
    return set(read_file(path).split()) if os.path.isfile(path) else set()


def record(tree, name):
    with open(state_path(tree), 'a') as f:
        f.write(name + '\n')


def cmd_apply(args):
    tree = os.environ['CHROMIUM_SRC']
    done = read_state(tree)
    rows, failed = [], 0
    for name in sorted(skipped()):
        rows.append((name, 'skipped (series-win)', classify(patch_files(os.path.join(PATCHES, name))), ''))
        print(f'{"skipped":16} {name}', flush=True)
    for name, path in names():
        if name in done:
            result, detail = 'already applied', 'recorded'
        else:
            result, detail = apply_one(path, tree)
            if result != 'FAILED':
                record(tree, name)
        failed += result == 'FAILED'
        rows.append((name, result, classify(patch_files(path)), detail))
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
        print(f'{classify(patch_files(path)):16} {name}')
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
