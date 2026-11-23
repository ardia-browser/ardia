import html
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
VECTORS = CORE / 'tests/import-netscape-vectors.json'
HOSTILE = REPO / 'scripts/security/hostile-inputs.mjs'
SWIFT_CORE = REPO / 'packages/import/ios/Core'
SWIFT_SOURCES = ['NetscapeBookmarks', 'Model', 'SecretBytes', 'ArcExtras', 'ArcSidebar', 'ChromiumFavicons', 'SQLiteSnapshot']
WINDOWS_IMPORT = REPO / 'packages/expo-windows/src/import'
LINUX_SOURCE = REPO / 'engine/ardiacore-linux/src'
LINUX_SHIM = REPO / 'engine/ardiacore-linux/tests/fixtures/import_base.h'
REQUIRED = set(filter(None, os.environ.get('ARDIA_REQUIRE_IMPORT_CROSSCHECK', '').split(',')))
WHITE_SPACE = set('\t\n\v\f\r \x85\xa0     　') | {chr(c) for c in range(0x2000, 0x200b)}
PLATFORMS = {'swift', 'windows', 'linux'}

sys.path.insert(0, str(HERE))
from materialize import materialize, shape, same


def unavailable(platform_name, why):
    if platform_name in REQUIRED:
        raise AssertionError(f'{why}, and ARDIA_REQUIRE_IMPORT_CROSSCHECK asks for {platform_name}')
    raise unittest.SkipTest(why)


def cases():
    return json.loads(VECTORS.read_text(encoding='utf-8'))['cases']


def comparable(answer, expected):
    if 'shape' in expected and 'ok' in answer:
        return {'shape': shape(answer['ok'])}
    return answer


def from_c_abi(answer):
    if isinstance(answer.get('error'), dict):
        return {'error': answer['error']['code']}
    return answer


class CrossCheck:
    platform = None

    def command(self, path):
        raise NotImplementedError

    def answer(self, spec):
        with tempfile.TemporaryDirectory(prefix='ardia-import-netscape-') as scratch:
            path = pathlib.Path(scratch) / 'bookmarks.html'
            path.write_bytes(materialize(spec))
            done = subprocess.run(self.command(path), capture_output=True, timeout=900)
        if done.returncode < 0:
            return {'error': 'crashed'}
        self.assertEqual(done.returncode, 0, done.stderr.decode(errors='replace')[-4000:])
        return json.loads(done.stdout)

    def test_every_vector_matches_this_platforms_recorded_answer(self):
        for case in cases():
            with self.subTest(case['name']):
                want = case.get('platforms', {}).get(self.platform, case['expect'])
                got = comparable(self.answer(case['file']), want)
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
    binary = pathlib.Path(scratch) / 'netscape-bookmarks'
    extra = ['-lpthread', '-ldl', '-lm'] if platform.system() == 'Linux' else []
    linked = subprocess.run([compiler, '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', str(CORE / 'include'),
                             str(HERE / 'driver.c'), str(CORE / 'target/release/libardia_import.a'), *extra,
                             '-o', str(binary)], capture_output=True, text=True, timeout=300)
    if linked.returncode != 0:
        raise AssertionError(linked.stderr[-4000:])
    return binary


class RustNetscapeBookmarksThroughTheCAbi(CrossCheck, unittest.TestCase):
    platform = 'rust'

    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-netscape-rust-')
        cls.binary = build_rust_driver(cls.scratch.name)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def command(self, path):
        return [str(self.binary), str(path)]

    def answer(self, spec):
        return from_c_abi(super().answer(spec))


class SwiftNetscapeBookmarks(CrossCheck, unittest.TestCase):
    platform = 'swift'

    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('swiftc')
        if compiler is None or sys.platform != 'darwin':
            unavailable('swift', 'swiftc on macOS is unavailable')
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-netscape-swift-')
        cls.binary = pathlib.Path(cls.scratch.name) / 'netscape-bookmarks'
        sources = [str(SWIFT_CORE / f'{name}.swift') for name in SWIFT_SOURCES]
        built = subprocess.run([compiler, '-Onone', '-module-name', 'ArdiaImportCore', '-o', str(cls.binary),
                                str(HERE / 'main.swift'), *sources, '-lsqlite3'],
                               capture_output=True, text=True, timeout=900)
        if built.returncode != 0:
            raise AssertionError(built.stderr[-4000:])

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def command(self, path):
        return [str(self.binary), str(path)]


class WindowsNetscapeBookmarks(CrossCheck, unittest.TestCase):
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

    def command(self, path):
        return [self.node, '--no-warnings', '--stack-size=984', str(HERE / 'netscape.mjs'), str(WINDOWS_IMPORT), str(path)]


class LinuxNetscapeBookmarks(CrossCheck, unittest.TestCase):
    platform = 'linux'

    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            unavailable('linux', 'a C++ compiler is unavailable')
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-netscape-linux-')
        root = pathlib.Path(cls.scratch.name)
        (root / 'include/base').mkdir(parents=True)
        shutil.copy(LINUX_SHIM, root / 'include/import_base.h')
        (root / 'include/base/values.h').write_text('#include "import_base.h"\n')
        cls.binary = root / 'netscape-bookmarks'
        sanitize = ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] if platform.system() == 'Linux' else []
        built = subprocess.run([compiler, '-std=c++20', '-O1', '-Wall', '-Wextra', '-Werror', *sanitize, '-I', str(root / 'include'),
                                '-I', str(LINUX_SOURCE), str(LINUX_SOURCE / 'ardia/linux/ac_linux_import_formats.cc'),
                                str(HERE / 'linux.cc'), '-o', str(cls.binary)], capture_output=True, text=True, timeout=600)
        if built.returncode != 0:
            raise AssertionError(built.stderr[-4000:])

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def command(self, path):
        return [str(self.binary), str(path)]


def trimmed(text):
    start, end = 0, len(text)
    while start < end and text[start] in WHITE_SPACE:
        start += 1
    while end > start and text[end - 1] in WHITE_SPACE:
        end -= 1
    return text[start:end]


def escaped(text):
    return ''.join(f'&#x{ord(c):X};' if 0xD800 <= ord(c) <= 0xDFFF else html.escape(c, quote=True) for c in text)


def received(text):
    return ''.join(f'&#x{ord(c):X};' if 0xD800 <= ord(c) <= 0xDFFF else c for c in text)


def seconds(raw):
    text = raw.strip(' \t\n\r\f\v')
    if not re.fullmatch(r'-?[0-9]+', text):
        return None
    value = int(text)
    return float(value) * 1000.0 if 0 < value < 2 ** 63 else None


def hostile_file(value):
    text = escaped(value)
    return ('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n'
            f'<DT><H3 ADD_DATE="{text}" ID="{text}">{text}</H3>\n<DL><p>\n'
            f'<DT><A HREF="https://kept.example/" ADD_DATE="{text}">{text}</A>\n'
            f'<DT><A HREF="{text}">url</A>\n'
            f'<DD>{text}\n'
            '<DT><A HREF="https://after.example/">after</A>\n'
            '</DL><p>\n</DL><p>\n')


def hostile_tree(value):
    def link(title, url, added=None):
        node = {'type': 'url', 'title': title, 'url': url}
        if added is not None:
            node['dateAdded'] = added
        return node

    text = trimmed(received(value))
    added = seconds(escaped(value))
    children = [link(text or 'https://kept.example/', 'https://kept.example/', added)]
    if text and not text.lower().startswith('place:'):
        children.append(link('url', text))
    children.append(link('after', 'https://after.example/'))
    folder = {'type': 'folder', 'title': text, 'children': children}
    if added is not None:
        folder['dateAdded'] = added
    return {'ok': {'type': 'folder', 'title': 'Bookmarks', 'children': [folder]}}


class HostileInputsThroughTheCAbi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        node = shutil.which('node')
        if node is None:
            unavailable('rust', 'node is unavailable to read scripts/security/hostile-inputs.mjs')
        listed = subprocess.run([node, '--input-type=module', '-e',
                                 f'import {{ HOSTILE_VALUES }} from {json.dumps(HOSTILE.as_uri())};'
                                 'process.stdout.write(JSON.stringify(HOSTILE_VALUES.map(({ id, value }) => '
                                 '({ id, text: typeof value === "string" ? value : JSON.stringify(value) ?? "null" }))));'],
                                capture_output=True, text=True, timeout=120)
        if listed.returncode != 0:
            raise AssertionError(listed.stderr)
        cls.values = json.loads(listed.stdout)
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-import-netscape-hostile-')
        cls.binary = build_rust_driver(cls.scratch.name)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def test_every_hostile_value_reaches_the_tree_verbatim_or_not_at_all(self):
        self.assertGreater(len(self.values), 80)
        for entry in self.values:
            with self.subTest(entry['id']):
                with tempfile.TemporaryDirectory(prefix='ardia-import-netscape-hostile-case-') as scratch:
                    path = pathlib.Path(scratch) / 'bookmarks.html'
                    path.write_bytes(hostile_file(entry['text']).encode())
                    done = subprocess.run([str(self.binary), str(path)], capture_output=True, timeout=120)
                self.assertEqual(done.returncode, 0)
                got = from_c_abi(json.loads(done.stdout))
                want = hostile_tree(entry['text'])
                self.assertTrue(same(got, want), f'got {json.dumps(got)[:600]}, want {json.dumps(want)[:600]}')


class VectorsAreWellFormed(unittest.TestCase):
    def test_every_case_names_known_platforms_and_outcomes(self):
        names = set()
        for case in cases():
            self.assertNotIn(case['name'], names)
            names.add(case['name'])
            self.assertLessEqual(set(case['file']), {'text', 'hex', 'bom', 'padTo', 'nestedFolders', 'nestedLists',
                                                     'unclosedLists', 'links', 'insideFolders'})
            self.assertLessEqual(set(case.get('platforms', {})), PLATFORMS)
            for outcome in [case['expect'], *case.get('platforms', {}).values()]:
                self.assertEqual(len(outcome), 1)
                self.assertIn(next(iter(outcome)), {'ok', 'error', 'shape'})
            for name, outcome in case.get('platforms', {}).items():
                self.assertFalse(same(outcome, case['expect']), f'{case["name"]}: {name} repeats expect')


if __name__ == '__main__':
    unittest.main()
