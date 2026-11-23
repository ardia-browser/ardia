import base64
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]
LINUX = REPO / 'engine/ardiacore-linux/src'
FIXTURES = REPO / 'packages/sync/tests/fixtures'
VECTORS = FIXTURES / 'sync-vectors'
CASES = HERE.parent / 'phrase-cases.json'
PASSWORD_READS = HERE.parent / 'password-read-cases.json'
REQUIRED = os.environ.get('ARDIA_REQUIRE_LINUX_CROSSCHECK') == '1'
SOURCES = [LINUX / 'ardia/linux/ac_linux_sync_crypto.cc', LINUX / 'ardia/linux/ac_linux_sync_wordlist.cc', HERE / 'vectors.cc']


def h(data):
    if isinstance(data, str):
        data = data.encode()
    return data.hex() or '-'


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def unavailable(why):
    if REQUIRED:
        raise AssertionError(f'{why}, and ARDIA_REQUIRE_LINUX_CROSSCHECK=1 asks for the cross-check')
    raise unittest.SkipTest(why)


def openssl_flags():
    prefix = os.environ.get('OPENSSL_PREFIX')
    if not prefix and platform.system() == 'Darwin' and shutil.which('brew'):
        found = subprocess.run(['brew', '--prefix', 'openssl'], capture_output=True, text=True)
        prefix = found.stdout.strip() if found.returncode == 0 else None
    return (['-I', f'{prefix}/include'], ['-L', f'{prefix}/lib']) if prefix else ([], [])


class LinuxSyncVectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            unavailable('C++ compiler is unavailable')
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-linux-sync-')
        cls.binary = pathlib.Path(cls.scratch.name) / 'linux-sync-vectors'
        includes, libraries = openssl_flags()
        sanitize = ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] if platform.system() == 'Linux' else []
        built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g', *sanitize, '-I', str(LINUX),
                                *includes, *map(str, SOURCES), '-o', str(cls.binary), *libraries, '-lcrypto'],
                               capture_output=True, text=True, timeout=300)
        if built.returncode != 0 and 'openssl/' in built.stderr and 'not found' in built.stderr:
            unavailable('OpenSSL headers are unavailable')
        assert built.returncode == 0, built.stderr

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def run_lines(self, lines):
        result = subprocess.run([str(self.binary)], input='\n'.join(lines) + '\n', capture_output=True, text=True,
                                timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout.splitlines()
        self.assertEqual(len(out), len(lines))
        return out

    def test_fixed_nonce_vectors_reproduce_every_committed_byte(self):
        inputs = load(VECTORS / 'inputs.json')
        expected = load(VECTORS / 'expected.json')
        entropy = {name: value for name, value in inputs['entropies'].items()}
        payload = {name: base64.b64decode(value) for name, value in inputs['payloads'].items()}
        checks = []
        for name, chain in expected['chains'].items():
            checks.append((f'phrase {entropy[name]}', h(chain['phrase'])))
            checks.append((f'entropy {h(chain["phrase"])}', f'ok {entropy[name]}'))
            for scope, tag in chain['scopeTags'].items():
                checks.append((f'tags {entropy[name]} {h(scope)}', f'{chain["chainTag"]} {tag}'))
        tags = {}
        lines = [f'tags {entropy[f["entropy"]]} {h(f["scope"])}' for f in inputs['vaultFiles'] + inputs['damaged']]
        for file, line in zip(inputs['vaultFiles'] + inputs['damaged'], self.run_lines(lines)):
            tags[(file['entropy'], file['scope'])] = line.split(' ')[1]
        for file in inputs['vaultFiles']:
            tag = tags[(file['entropy'], file['scope'])]
            entry = next(e for e in expected['vault']['files'] if e['id'] == file['id'])
            committed = (VECTORS / entry['path']).read_bytes()
            seal = f'seal {entropy[file["entropy"]]} {h(tag)} {h(file["id"])} {file["nonce"]} {h(payload[file["payload"]])}'
            checks.append((seal, committed.hex()))
            checks.append((f'open {entropy[file["entropy"]]} {h(tag)} {h(file["id"])} {committed.hex()}',
                           f'ok {h(payload[file["payload"]])}'))
        for file in expected['vault']['damaged']:
            tag = tags[(file['entropy'], file['scope'])]
            committed = (VECTORS / file['path']).read_bytes()
            checks.append((f'open {entropy[file["entropy"]]} {h(tag)} {h(file["id"])} {committed.hex()}',
                           'authentication'))
        for state, sealed in zip(inputs['localStates'], expected['localStates']):
            seal = f'seal {entropy[state["entropy"]]} {h("local")} {h(state["fileId"])} {state["nonce"]} {h(payload[state["payload"]])}'
            checks.append((seal, base64.b64decode(sealed['sealed']).hex()))
        for login in expected['passwords']:
            key = entropy[login['entropy']]
            checks.append((f'sealpw {key} {h(login["password"])} {h(login["origin"])} {h(login["username"])}',
                           login['sealed']))
            checks.append((f'openpw {key} {h(login["sealed"])} {h(login["origin"])} {h(login["username"])}',
                           f'ok {h(login["password"])}'))
        self.check(checks)
        self.assertEqual(len(checks), 63)

    def test_random_nonce_sets_and_old_vaults_open(self):
        inputs = load(VECTORS / 'inputs.json')
        payload = {name: base64.b64decode(value) for name, value in inputs['payloads'].items()}
        checks = []
        for writer in ['swift', 'kotlin']:
            folder = VECTORS / writer
            manifest = load(folder / 'manifest.json')
            key = manifest['entropy']
            checks.append((f'phrase {key}', h(manifest['phrase'])))
            for file in manifest['files']:
                tag = manifest['scopeTags'][file['scope']]
                data = (folder / file['path']).read_bytes()
                checks.append((f'open {key} {h(tag)} {h(file["id"])} {data.hex()}', f'ok {h(payload[file["payload"]])}'))
            login = manifest['password']
            checks.append((f'sealpw {key} {h(login["password"])} {h(login["origin"])} {h(login["username"])}',
                           manifest['sealedPassword']))
            local = manifest['localState']
            checks.append((f'open {key} {h("local")} {h(local["fileId"])} {base64.b64decode(local["sealed"]).hex()}',
                           f'ok {h(payload[local["payload"]])}'))
        for writer in ['mac', 'windows']:
            manifest = load(FIXTURES / f'windows-interop/{writer}.json')
            key = manifest['entropy']
            checks.append((f'entropy {h(" ".join(manifest["words"]))}', f'ok {key}'))
            for file in manifest['files']:
                tag = manifest['scopeTags'][file['scope']]
                path = FIXTURES / 'windows-interop' / writer / manifest['chainTag'] / tag / f'{file["id"]}.nns'
                checks.append((f'open {key} {h(tag)} {h(file["id"])} {path.read_bytes().hex()}', f'ok {h(file["payload"])}'))
            local = manifest['local']
            checks.append((f'open {key} {h("local")} {h("state")} {base64.b64decode(local["sealed"]).hex()}',
                           f'ok {h(local["plain"])}'))
            login = manifest['password']
            checks.append((f'openpw {key} {h(login["sealed"])} {h(login["origin"])} {h(login["username"])}',
                           f'ok {h(login["password"])}'))
        old = base64.b64decode((FIXTURES / 'sealed-0.2.32.b64').read_text().strip())
        zero = '00' * 32
        checks.append((f'tags {zero} {h("app")}', 'gbcx4r55mk3rlaegbggknyx4ta nr4ncp5iyqzqgjn6ol4zksqtne'))
        checks.append((f'open {zero} {h("nr4ncp5iyqzqgjn6ol4zksqtne")} {h("f1")} {old.hex()}', f'ok {h("from 0.2.32")}'))
        self.check(checks)
        self.assertEqual(len(checks), 38)

    def test_phrase_cases_match_what_linux_was_recorded_doing(self):
        cases = load(CASES)['cases']
        lines = [f'entropy {h(case["input"])}' for case in cases]
        for case, line in zip(cases, self.run_lines(lines)):
            kind, _, rest = line.partition(' ')
            if kind == 'ok':
                got = {'entropy': rest}
            elif kind == 'wordCount':
                got = {'problem': kind, 'count': int(rest)}
            elif kind == 'unknownWord':
                got = {'problem': kind, 'word': bytes.fromhex(rest).decode()}
            else:
                got = {'problem': kind}
            self.assertEqual(got, case['outcomes']['linux'], case['name'])

    def test_password_reads_match_what_linux_was_recorded_doing(self):
        table = load(PASSWORD_READS)
        key = load(VECTORS / 'inputs.json')['entropies'][table['entropy']]
        cases = table['cases']
        lines = [f'openpw {key} {h(c["sealed"])} {h(c["origin"])} {h(c["username"])}' for c in cases]
        for case, line in zip(cases, self.run_lines(lines)):
            kind, _, rest = line.partition(' ')
            got = {'password': bytes.fromhex(rest).decode() if rest != '-' else ''} if kind == 'ok' else {'error': kind}
            self.assertEqual(got, case['outcomes']['linux'], case['name'])

    def check(self, checks):
        out = self.run_lines([line for line, _ in checks])
        for (line, want), got in zip(checks, out):
            self.assertEqual(got, want, line[:120])


if __name__ == '__main__':
    unittest.main()
