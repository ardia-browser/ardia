import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]
CORE = HERE.parents[1]
VECTORS = CORE / 'tests/import-bookmarks-vectors.json'
HOSTILE = REPO / 'scripts/security/hostile-inputs.mjs'
WEBKIT_EPOCH_OFFSET_MICROS = 11644473600000000
SWIFT_CORE = REPO / 'packages/import/ios/Core'
WINDOWS_IMPORT = REPO / 'packages/expo-windows/src/import'
REQUIRED = set(filter(None, os.environ.get('ARDIA_REQUIRE_IMPORT_CROSSCHECK', '').split(',')))

sys.path.insert(0, str(HERE))
from materialize import materialize, shape, same


def unavailable(platform, why):
    if platform in REQUIRED:
        raise AssertionError(f'{why}, and ARDIA_REQUIRE_IMPORT_CROSSCHECK asks for {platform}')
    raise unittest.SkipTest(why)


def cases():
    return json.loads(VECTORS.read_text(encoding='utf-8'))['cases']


def comparable(answer, expected):
    if 'shape' in expected and 'ok' in answer:
        return {'shape': shape(answer['ok'])}
    return answer


class CrossCheck:
    platform = None

    def command(self, profile):
        raise NotImplementedError

    def answer(self, files):
        with tempfile.TemporaryDirectory(prefix='ardia-import-bookmarks-') as scratch:
            profile = pathlib.Path(scratch)
            for name, spec in files.items():
                (profile / name).write_bytes(materialize(spec))
            done = subprocess.run(self.command(profile), capture_output=True, timeout=600)
        self.assertEqual(done.returncode, 0, done.stderr.decode(errors='replace'))
        return json.loads(done.stdout)

    def test_every_vector_matches_this_platforms_recorded_answer(self):
        for case in cases():
            with self.subTest(case['name']):
                want = case.get('platforms', {}).get(self.platform, case['expect'])
                got = comparable(self.answer(case['files']), want)
                self.assertTrue(same(got, want), f'got {json.dumps(got)[:800]}, recorded {json.dumps(want)[:800]}')


def build_rust_driver(scratch):
    cargo = shutil.which('cargo')
    compiler = shutil.which('cc') or shutil.which('clang')
    if cargo is None or compiler is None:
        unavailable('rust', 'cargo or a C compiler is unavailable')
    built = subprocess.run([cargo, 'build', '--locked', '--release', '-p', 'ardia-import-ffi'], cwd=CORE,
                           capture_output=True, text=True, timeout=900)
    if built.returncode != 0:
        raise AssertionError(built.stderr[-4000:])
    binary = pathlib.Path(scratch) / 'chromium-bookmarks'
    extra = ['-lpthread', '-ldl', '-lm'] if platform.system() == 'Linux' else []
    linked = subprocess.run([compiler, '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', str(CORE / 'include'),
                             str(HERE / 'driver.c'), str(CORE / 'target/release/libardia_import.a'), *extra,
                             '-o', str(binary)], capture_output=True, text=True, timeout=300)
    if linked.returncode != 0:
        raise AssertionError(linked.stderr[-4000:])
    return binary


def from_c_abi(answer):
    if isinstance(answer.get('error'), dict):
        return {'error': answer['error']['code']}
    return answer


class RustChromiumBookmarksThroughTheCAbi(CrossCheck, unittest.TestCase):
    platform = 'rust'

    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-rust-')
        cls.binary = build_rust_driver(cls.scratch.name)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def command(self, profile):
        return [str(self.binary), str(profile)]

    def answer(self, files):
        return from_c_abi(super().answer(files))


def webkit_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'[+-]?[0-9]+', value):
        return None
    micros = int(value)
    if micros > 2 ** 63 - 1 or micros <= WEBKIT_EPOCH_OFFSET_MICROS:
        return None
    return (micros - WEBKIT_EPOCH_OFFSET_MICROS) / 1000


def has_lone_surrogate(value):
    if isinstance(value, str):
        return any(0xD800 <= ord(c) <= 0xDFFF for c in value)
    if isinstance(value, list):
        return any(map(has_lone_surrogate, value))
    if isinstance(value, dict):
        return any(has_lone_surrogate(k) or has_lone_surrogate(v) for k, v in value.items())
    return False


def hostile_file(fragment, value):
    keyed = f',{fragment}:1' if isinstance(value, str) else ''
    root_key = f',{fragment}:{{"type":"folder","children":[{{"type":"url","url":"https://root.example/"}}]}}' \
        if isinstance(value, str) and value not in ('bookmark_bar', 'other', 'synced') else ''
    return ('{"roots":{"bookmark_bar":{"type":"folder","name":' + fragment + ',"children":['
            '{"type":"url","name":' + fragment + ',"url":"https://kept.example/"},'
            '{"type":"url","name":"url","url":' + fragment + '},'
            '{"type":' + fragment + ',"name":"type","url":"https://type.example/"},'
            '{"type":"url","name":"date","url":"https://date.example/","date_added":' + fragment + '},'
            '{"type":"folder","name":"children","children":' + fragment + '},'
            '{"type":"url","name":"keyed","url":"https://keyed.example/"' + keyed + '}'
            ']}' + root_key + '}}')


def hostile_tree(value):
    def link(title, url, added=None):
        node = {'type': 'url', 'title': title, 'url': url}
        if added is not None:
            node['dateAdded'] = added
        return node

    text = value if isinstance(value, str) else None
    children = [link(text or '', 'https://kept.example/')]
    if text:
        children.append(link('url', text))
    if text == 'url':
        children.append(link('type', 'https://type.example/'))
    elif text == 'folder':
        children.append({'type': 'folder', 'title': 'type', 'children': []})
    children.append(link('date', 'https://date.example/', webkit_date(value)))
    children.append({'type': 'folder', 'title': 'children', 'children': []})
    children.append(link('keyed', 'https://keyed.example/'))
    bar = {'type': 'folder', 'title': text or 'Bookmarks Bar', 'children': children, 'role': 'toolbar'}
    return {'ok': {'type': 'folder', 'title': 'Bookmarks', 'children': [bar]}}


class HostileInputsThroughTheCAbi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which('node')
        if node is None:
            unavailable('rust', 'node is unavailable to read scripts/security/hostile-inputs.mjs')
        listed = subprocess.run([node, '--input-type=module', '-e',
                                 f'import {{ HOSTILE_VALUES }} from {json.dumps(HOSTILE.as_uri())};'
                                 'process.stdout.write(JSON.stringify(HOSTILE_VALUES.map(({ id, value }) => '
                                 '({ id, json: JSON.stringify(value) ?? "null" }))));'],
                                capture_output=True, text=True, timeout=120)
        if listed.returncode != 0:
            raise AssertionError(listed.stderr)
        cls.values = json.loads(listed.stdout)
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-hostile-')
        cls.binary = build_rust_driver(cls.scratch.name)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def test_every_hostile_value_reaches_the_tree_verbatim_or_not_at_all(self):
        self.assertGreater(len(self.values), 80)
        for entry in self.values:
            with self.subTest(entry['id']):
                value = json.loads(entry['json'])
                with tempfile.TemporaryDirectory(prefix='ardia-import-hostile-case-') as profile:
                    (pathlib.Path(profile) / 'Bookmarks').write_bytes(hostile_file(entry['json'], value).encode())
                    done = subprocess.run([str(self.binary), profile], capture_output=True, timeout=120)
                self.assertEqual(done.returncode, 0)
                got = from_c_abi(json.loads(done.stdout))
                want = {'error': 'unreadable'} if has_lone_surrogate(value) else hostile_tree(value)
                self.assertTrue(same(got, want), f'got {json.dumps(got)[:600]}, want {json.dumps(want)[:600]}')


def build_apple_library(scratch):
    cargo = shutil.which('cargo')
    if cargo is None:
        unavailable('swift', 'cargo is unavailable to build libardia_apple')
    built = subprocess.run([cargo, 'build', '--locked', '--release', '-p', 'ardia-apple-ffi'], cwd=CORE,
                           capture_output=True, text=True, timeout=900)
    if built.returncode != 0:
        raise AssertionError(built.stderr[-4000:])
    modules = pathlib.Path(scratch) / 'modules'
    modules.mkdir()
    headers = ''.join(f'  header {json.dumps(str(CORE / "include" / name))}\n' for name in ('ardia_core.h', 'ardia_import.h'))
    (modules / 'module.modulemap').write_text('module ArdiaCoreRS {\n' + headers + '  export *\n}\n')
    return modules, CORE / 'target/release/libardia_apple.a'


class SwiftChromiumBookmarks(CrossCheck, unittest.TestCase):
    platform = 'swift'

    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('swiftc')
        if compiler is None or sys.platform != 'darwin':
            unavailable('swift', 'swiftc on macOS is unavailable')
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-swift-')
        modules, library = build_apple_library(cls.scratch.name)
        cls.binary = pathlib.Path(cls.scratch.name) / 'chromium-bookmarks'
        sources = sorted(map(str, SWIFT_CORE.glob('*.swift')))
        built = subprocess.run([compiler, '-Onone', '-module-name', 'ArdiaImportCore', '-o', str(cls.binary),
                                '-I', str(modules), str(HERE / 'main.swift'), *sources, str(library), '-lsqlite3'],
                               capture_output=True, text=True, timeout=600)
        if built.returncode != 0:
            raise AssertionError(built.stderr[-4000:])

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def command(self, profile):
        return [str(self.binary), str(profile)]


class WindowsChromiumBookmarks(CrossCheck, unittest.TestCase):
    platform = 'windows'

    @classmethod
    def setUpClass(cls):
        node = shutil.which('node')
        if node is None:
            unavailable('windows', 'node is unavailable')
        version = subprocess.run([node, '-p', 'process.versions.node'], capture_output=True, text=True).stdout.strip()
        if tuple(map(int, version.split('.')[:2])) < (22, 18):
            unavailable('windows', f'node {version} cannot strip TypeScript types and register module hooks')
        cls.node = node

    def command(self, profile):
        return [self.node, '--no-warnings', str(HERE / 'chromium.mjs'), str(WINDOWS_IMPORT), str(profile)]


class VectorsAreWellFormed(unittest.TestCase):
    def test_every_case_names_known_platforms_and_outcomes(self):
        names = set()
        for case in cases():
            self.assertNotIn(case['name'], names)
            names.add(case['name'])
            self.assertLessEqual(set(case['files']), {'Bookmarks', 'AccountBookmarks'})
            self.assertLessEqual(set(case.get('platforms', {})), {'swift', 'windows', 'linux'})
            for outcome in [case['expect'], *case.get('platforms', {}).values()]:
                self.assertEqual(len(outcome), 1)
                self.assertIn(next(iter(outcome)), {'ok', 'error', 'shape'})


if __name__ == '__main__':
    unittest.main()
