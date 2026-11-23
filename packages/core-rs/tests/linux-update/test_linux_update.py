import base64
import importlib.util
import json
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CORE = HERE.parents[1]
REPO = HERE.parents[3]
LINUX = REPO / 'engine/ardiacore-linux/src'
HELPER = REPO / 'scripts/linux/ardia-update'
HOSTILE = REPO / 'scripts/security/hostile-inputs.mjs'
VECTORS = json.loads((HERE.parent / 'update-vectors.json').read_text(encoding='utf-8'))
REQUIRED = os.environ.get('ARDIA_REQUIRE_LINUX_CROSSCHECK') == '1'
SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
MANIFESTS = VECTORS['manifests']
VERSIONS = VECTORS['versions']
MAX_ARGUMENT = 65536


def h(data):
    if isinstance(data, str):
        data = data.encode()
    return data.hex() or '-'


def unavailable(why):
    if REQUIRED:
        raise AssertionError(f'{why}, and ARDIA_REQUIRE_LINUX_CROSSCHECK=1 asks for the cross-check')
    raise unittest.SkipTest(why)


def ordered_pairs():
    ascending = VERSIONS['ascending']
    pairs = [(a, b, -1) for i, a in enumerate(ascending) for b in ascending[i + 1:]]
    pairs += [(b, a, 1) for a, b, _ in list(pairs)]
    pairs += [(a, b, 0) for a, b in VERSIONS['equal']]
    return pairs


def expected(case, implementation, field):
    return case.get(implementation, case[field])


def public_pem(key_hex):
    der = SPKI_PREFIX + bytes.fromhex(key_hex)
    return f'-----BEGIN PUBLIC KEY-----\n{base64.b64encode(der).decode()}\n-----END PUBLIC KEY-----\n'


def openssl3():
    candidates = [os.environ.get('OPENSSL'), shutil.which('openssl'), '/opt/homebrew/opt/openssl@3/bin/openssl',
                  '/opt/homebrew/opt/openssl/bin/openssl', '/usr/local/opt/openssl@3/bin/openssl']
    for candidate in candidates:
        if not candidate or not pathlib.Path(candidate).exists():
            continue
        version = subprocess.run([candidate, 'version'], capture_output=True, text=True).stdout
        if re.match(r'OpenSSL [3-9]\.', version):
            return candidate
    return None


def rust_tool(name):
    found = shutil.which(name)
    if found:
        return found
    installed = pathlib.Path.home() / '.cargo/bin' / name
    return str(installed) if os.access(installed, os.X_OK) else None


def cargo_target_dir():
    return pathlib.Path(os.environ.get('CARGO_TARGET_DIR') or 'target')


def verifier_binary():
    cargo = rust_tool('cargo')
    if cargo is None:
        unavailable('cargo is unavailable to build ardia-update-verify')
    built = subprocess.run([cargo, 'build', '--locked', '--release', '--quiet', '-p', 'ardia-update-verify'], cwd=CORE,
                           capture_output=True, text=True, timeout=900)
    if built.returncode != 0:
        raise AssertionError(built.stderr)
    return CORE / cargo_target_dir() / 'release' / ('ardia-update-verify.exe' if os.name == 'nt' else 'ardia-update-verify')


def verdict(binary, manifest, signature, key, version, installed, kind):
    result = subprocess.run([str(binary), 'manifest', '--key', str(key), '--manifest', str(manifest), '--signature',
                             str(signature), '--version', version, '--installed', installed, '--kind', kind],
                            capture_output=True, timeout=60)
    lines = result.stdout.decode('utf-8', 'replace').splitlines()
    return (lines[-1] if lines else ''), result.returncode


def passable(value):
    if len(value) > MAX_ARGUMENT or '\0' in value:
        return False
    try:
        os.fsencode(value)
    except UnicodeError:
        return False
    return True


def packaging_module():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('ardia_linux_package', REPO / 'scripts/linux/package.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def elf(kind=2, machine=0x3e, segments=((1, 0, 120),), program_headers=None, entry=0x401000, length=None):
    count = len(segments) if program_headers is None else program_headers
    header = bytearray(b'\x7fELF\x02\x01\x01' + bytes(9))
    header += struct.pack('<HHIQQQIHHHHHH', kind, machine, 1, entry, 64, 0, 0, 64, 56, count, 64, 0, 0)
    for segment_kind, offset, size in segments:
        header += struct.pack('<IIQQQQQQ', segment_kind, 5, offset, 0x400000, 0x400000, size, size, 0x1000)
    body = bytes(header) + bytes(max(0, 512 - len(header)))
    return body if length is None else body[:length]


SIGNING_DRIVER = r'''
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
const manifests = JSON.parse(readFileSync(process.argv[2], "utf8")).map((hex) => Buffer.from(hex, "hex"));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log(JSON.stringify({
  publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex"),
  signatures: manifests.map((manifest) => sign(null, manifest, privateKey).toString("hex")),
}));
'''


NODE_DRIVER = r'''
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [vectorsPath, pairsPath, releasesPath, versionsPath] = process.argv.slice(2);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
const releases = await import(pathToFileURL(releasesPath).href);
const mac = await import(pathToFileURL(versionsPath).href);
const prefix = Buffer.from("302a300506032b6570032100", "hex");
const signatures = vectors.manifests.map((c) => {
  const signature = Buffer.from(c.signature, "hex");
  if (signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([prefix, Buffer.from(c.publicKey, "hex")]), format: "der", type: "spki" });
  try {
    return verify(null, Buffer.from(c.manifest, "utf8"), key, signature);
  } catch {
    return false;
  }
});
const pairs = JSON.parse(readFileSync(pairsPath, "utf8"));
const order = (compare) => pairs.map(([a, b]) => Math.sign(compare(a, b)) || 0);
console.log(JSON.stringify({
  signatures,
  linuxValid: vectors.versions.valid.map((v) => releases.isAppVersion(v.version)),
  linuxInvalid: vectors.versions.invalid.map((v) => releases.isAppVersion(v.version)),
  linuxChannels: vectors.versions.valid.map((v) => releases.channelOf(v.version)),
  linuxOrder: order(releases.compareVersions),
  macOrder: order(mac.compareVersions),
}));
'''


class LinuxUpdateParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-linux-update-')
        cls.dir = pathlib.Path(cls.scratch.name)
        cls.files = []
        for index, case in enumerate(MANIFESTS):
            manifest = cls.dir / f'{index}.txt'
            signature = cls.dir / f'{index}.sig'
            key = cls.dir / f'{index}.pem'
            manifest.write_bytes(case['manifest'].encode())
            signature.write_bytes(bytes.fromhex(case['signature']))
            key.write_text(public_pem(case['publicKey']))
            cls.files.append((manifest, signature, key))

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def policy_binary(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            unavailable('C++ compiler is unavailable')
        binary = self.dir / 'policy'
        if not binary.exists():
            built = subprocess.run([compiler, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', str(LINUX),
                                    str(HERE / 'policy.cc'), '-o', str(binary)], capture_output=True, text=True,
                                   timeout=300)
            self.assertEqual(built.returncode, 0, built.stderr)
        return binary

    def policy(self, lines):
        result = subprocess.run([str(self.policy_binary())], input='\n'.join(lines) + '\n', capture_output=True,
                                text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout.splitlines()
        self.assertEqual(len(out), len(lines))
        return out

    def test_the_engine_policy_parses_every_manifest_as_recorded(self):
        lines = [f'parse {h(c["manifest"])} {h(c["version"])} {c["kind"]}' for c in MANIFESTS]
        for case, line in zip(MANIFESTS, self.policy(lines)):
            want = expected(case, 'linuxPolicy', 'parse')
            if 'error' in want:
                self.assertEqual(line, f'error {want["error"]}', case['name'])
            else:
                self.assertEqual(line, f'ok {want["name"]} {want["size"]}', case['name'])

    def test_the_engine_policy_orders_and_validates_versions_as_recorded(self):
        valid = [v['version'] for v in VERSIONS['valid']]
        invalid = VERSIONS['invalid']
        out = self.policy([f'valid {h(v)}' for v in valid] + [f'valid {h(v["version"])}' for v in invalid])
        self.assertEqual(out[:len(valid)], ['1'] * len(valid))
        for entry, line in zip(invalid, out[len(valid):]):
            self.assertEqual(line, '1' if 'linuxPolicy' in entry['acceptedBy'] else '0', repr(entry['version']))
        pairs = ordered_pairs()
        out = self.policy([f'compare {h(a)} {h(b)}' for a, b, _ in pairs])
        for (a, b, want), line in zip(pairs, out):
            self.assertEqual(line, str(want), f'{a} vs {b}')

    def verifier(self):
        if not hasattr(type(self), 'binary'):
            type(self).binary = verifier_binary()
        return type(self).binary

    def test_the_root_helper_leaves_every_manifest_check_to_ardia_update_verify(self):
        text = HELPER.read_text(encoding='utf-8')
        self.assertIn('verifier="$libdir/ardia-update-verify"', text)
        self.assertIn('verify "$((left < small_copy_seconds ? left : small_copy_seconds))" manifest', text)
        self.assertIn('verify "$left" package --package "$destination"', text)
        for duplicated in ['openssl', 'pkeyutl', 'sha256sum', 'version_parts', 'parse_manifest', 'newer_than']:
            self.assertNotIn(duplicated, text)

    def test_the_root_helpers_verifier_installs_or_refuses_every_manifest_as_recorded(self):
        binary = self.verifier()
        for case, (manifest, signature, key) in zip(MANIFESTS, self.files):
            line, status = verdict(binary, manifest, signature, key, case['version'], case['installed'], case['kind'])
            want = expected(case, 'helper', 'outcome')
            if 'error' in want:
                self.assertEqual((line, status), (f'failed {want["error"]}', 1), case['name'])
            else:
                self.assertEqual((line, status), (f'ok {want["name"]} {want["sha256"]} {want["size"]}', 0),
                                 case['name'])

    def test_no_hostile_string_passes_the_verifier(self):
        node = shutil.which('node')
        if node is None:
            unavailable('node is unavailable to read scripts/security/hostile-inputs.mjs')
        listed = subprocess.run([node, '--input-type=module', '-e',
                                 f'import {{ HOSTILE_STRINGS }} from {json.dumps(HOSTILE.as_uri())};'
                                 'process.stdout.write(JSON.stringify(HOSTILE_STRINGS));'],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        hostile = json.loads(listed.stdout)
        self.assertGreater(len(hostile), 50)
        base = next(case for case in MANIFESTS if case['name'] == 'deb install, all three formats')
        deb = base['manifest'].split('\n')[2].split(' ')
        forged = []
        for entry in hostile:
            value = entry['value']
            forged += [
                (entry['id'], 'version', base['manifest'].replace('0.2.48', value)),
                (entry['id'], 'name', base['manifest'].replace(deb[1], value)),
                (entry['id'], 'digest', base['manifest'].replace(deb[2], value)),
                (entry['id'], 'size', base['manifest'].replace(f' {deb[3]}\n', f' {value}\n', 1)),
                (entry['id'], 'kind', base['manifest'].replace('deb Ardia', f'{value} Ardia')),
                (entry['id'], 'line', base['manifest'] + value + '\n'),
            ]
        encoded = [text.encode('utf-8', 'surrogatepass') for _, _, text in forged]
        hexes = self.dir / 'hostile.json'
        hexes.write_text(json.dumps([manifest.hex() for manifest in encoded]))
        script = self.dir / 'sign.mjs'
        script.write_text(SIGNING_DRIVER)
        signed = subprocess.run([node, str(script), str(hexes)], capture_output=True, text=True, timeout=300)
        self.assertEqual(signed.returncode, 0, signed.stderr)
        signed = json.loads(signed.stdout)
        key = self.dir / 'hostile.pem'
        key.write_text(public_pem(signed['publicKey']))
        binary = self.verifier()
        manifest = self.dir / 'hostile.txt'
        signature = self.dir / 'hostile.sig'
        for (name, field, _), body, sig in zip(forged, encoded, signed['signatures']):
            manifest.write_bytes(body)
            signature.write_bytes(bytes.fromhex(sig))
            self.assertEqual(verdict(binary, manifest, signature, key, '0.2.48', '0.2.47', 'deb'),
                             ('failed manifest', 1), f'{name} as the {field}')
        good = self.files[MANIFESTS.index(base)]
        self.assertEqual(verdict(binary, *good, '0.2.48', '0.2.47', 'deb')[1], 0)
        for entry in hostile:
            value = entry['value']
            if not passable(value):
                continue
            for field, args, want in [('--version', (value, '0.2.47', 'deb'), ('failed manifest', 1)),
                                      ('--installed', ('0.2.48', value, 'deb'), ('failed kind', 1)),
                                      ('--kind', ('0.2.48', '0.2.47', value), ('failed usage', 2))]:
                self.assertEqual(verdict(binary, *good, *args), want, f'{entry["id"]} as {field}')
            result = subprocess.run([str(binary), 'version', value], capture_output=True, timeout=60)
            self.assertEqual((result.stdout, result.returncode), (b'failed version\n', 1), entry['id'])

    def test_openssl_pkeyutl_verifies_exactly_the_signatures_recorded_valid(self):
        openssl = openssl3()
        if openssl is None:
            unavailable('OpenSSL 3 is unavailable')
        for case, (manifest, signature, key) in zip(MANIFESTS, self.files):
            if len(bytes.fromhex(case['signature'])) != 64 or not case['manifest']:
                continue
            result = subprocess.run([openssl, 'pkeyutl', '-verify', '-pubin', '-inkey', str(key), '-rawin', '-in',
                                     str(manifest), '-sigfile', str(signature)], capture_output=True, text=True)
            self.assertEqual(result.returncode == 0, case.get('openssl', case['signatureValid']), case['name'])

    def test_node_crypto_and_the_typescript_version_rules_agree(self):
        node = shutil.which('node')
        if node is None:
            unavailable('node is unavailable')
        stripping = subprocess.run([node, '--experimental-strip-types', '-e', '0'], capture_output=True, text=True)
        flags = ['--experimental-strip-types', '--no-warnings'] if stripping.returncode == 0 else []
        script = self.dir / 'node-driver.mjs'
        script.write_text(NODE_DRIVER)
        pairs = ordered_pairs()
        pairs_path = self.dir / 'pairs.json'
        pairs_path.write_text(json.dumps([[a, b] for a, b, _ in pairs]))
        result = subprocess.run([node, *flags, str(script), str(HERE.parent / 'update-vectors.json'), str(pairs_path),
                                 str(REPO / 'apps/desktop/src/platform/linux/updateReleases.ts'),
                                 str(REPO / 'apps/browser/src/lib/versions.ts')], capture_output=True, text=True,
                                timeout=120)
        if result.returncode != 0 and ('ERR_UNKNOWN_FILE_EXTENSION' in result.stderr or 'strip-types' in result.stderr):
            unavailable('this node cannot load TypeScript')
        self.assertEqual(result.returncode, 0, result.stderr)
        got = json.loads(result.stdout)
        for case, valid in zip(MANIFESTS, got['signatures']):
            self.assertEqual(valid, case.get('node', case['signatureValid']), case['name'])
        self.assertEqual(got['linuxValid'], [True] * len(VERSIONS['valid']))
        self.assertEqual(got['linuxChannels'], [v['channel'] for v in VERSIONS['valid']])
        for entry, valid in zip(VERSIONS['invalid'], got['linuxInvalid']):
            self.assertEqual(valid, 'linuxReleases' in entry['acceptedBy'], repr(entry['version']))
        for implementation in ['linuxOrder', 'macOrder']:
            for (a, b, want), order in zip(pairs, got[implementation]):
                self.assertEqual(order, want, f'{implementation}: {a} vs {b}')

    def test_the_vectors_cover_every_failure_reason(self):
        outcomes = {c['outcome'].get('error', 'ok') for c in MANIFESTS}
        self.assertEqual(outcomes, {'ok', 'tooLarge', 'manifest', 'signature', 'notNewer', 'kind', 'version'})
        self.assertEqual({o['outcome'] for o in VECTORS['offers']}, {'ok', 'notNewer', 'channel', 'version'})


class PackagedVerifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.packaging = packaging_module()
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-packaged-verifier-')
        cls.dir = pathlib.Path(cls.scratch.name)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def problem(self, data):
        return self.packaging.static_x86_64_executable_problem(data)

    def test_a_static_x86_64_executable_header_passes(self):
        self.assertIsNone(self.problem(elf()))
        self.assertIsNone(self.problem(elf(kind=3)))

    def test_malformed_or_dynamic_elves_are_refused(self):
        refused = {
            'an empty file': b'',
            'a truncated header': elf(length=40),
            'a 32-bit ELF': b'\x7fELF\x01' + elf()[5:],
            'a big-endian ELF': elf()[:5] + b'\x02' + elf()[6:],
            'a relocatable object': elf(kind=1),
            'a core dump': elf(kind=4),
            'an arm64 ELF': elf(machine=0xb7),
            'no entry point': elf(entry=0),
            'no program headers': elf(segments=()),
            'program headers past the end': elf(program_headers=40),
            'a segment past the end': elf(segments=((1, 0, 1 << 20),)),
            'a dynamic loader': elf(segments=((3, 0, 28), (1, 0, 120))),
            'no loadable segment': elf(segments=((6, 0, 56),)),
            'program headers cut off by truncation': elf(length=100),
        }
        for label, data in refused.items():
            self.assertIsNotNone(self.problem(data), label)

    def test_package_py_refuses_a_verifier_that_is_not_a_static_x86_64_executable(self):
        for label, data in [('ET_REL', elf(kind=1)), ('PT_INTERP', elf(segments=((3, 0, 28), (1, 0, 120)))),
                            ('truncated', elf(length=40))]:
            binary = self.dir / f'{label}-verify'
            binary.write_bytes(data)
            binary.chmod(0o755)
            with self.assertRaises(ValueError, msg=label):
                self.packaging.check_update_verify(binary)

    def test_package_py_runs_the_verifier_where_it_can(self):
        binary = self.dir / 'header-only-verify'
        binary.write_bytes(elf())
        binary.chmod(0o755)
        if self.packaging.runs_here():
            with self.assertRaisesRegex(ValueError, 'does not run here'):
                self.packaging.check_update_verify(binary)
        else:
            self.packaging.check_update_verify(binary)

    def fake_build(self, name):
        root = self.dir / name
        output, ui = root / 'out', root / 'ui'
        output.mkdir(parents=True)
        ui.mkdir()
        for required in self.packaging.REQUIRED:
            if required == 'locales':
                (output / required).mkdir()
                (output / required / 'en-US.pak').write_bytes(b'locale')
            else:
                (output / required).write_bytes(b'runtime')
        (output / 'chrome').chmod(0o755)
        (ui / 'index.html').write_text('<html></html>')
        return root, output, ui

    def test_package_py_checks_the_staged_copy_and_writes_nothing_when_it_fails(self):
        root, output, ui = self.fake_build('refused')
        broken = root / 'ardia-update-verify'
        broken.write_bytes(elf(kind=1))
        broken.chmod(0o755)
        destination = root / 'ardia.tar.xz'
        with self.assertRaisesRegex(ValueError, 'lib/ardia/ardia-update-verify'):
            self.packaging.package(output, ui, destination, update_verify=broken)
        self.assertFalse(destination.exists())

    def test_the_built_verifier_passes_the_packaging_check(self):
        if rust_tool('cargo') is None or rust_tool('rustup') is None:
            unavailable('cargo and rustup are unavailable to build the musl ardia-update-verify')
        built = subprocess.run(['bash', str(REPO / 'scripts/linux/update-verify.sh')], capture_output=True, text=True,
                               timeout=900)
        self.assertEqual(built.returncode, 0, built.stderr)
        binary = pathlib.Path(built.stdout.strip())
        self.assertIsNone(self.problem(binary.read_bytes()))
        self.packaging.check_update_verify(binary)
        root, output, ui = self.fake_build('packaged')
        archive = self.packaging.package(output, ui, root / 'ardia.tar.xz', update_verify=binary)
        with tarfile.open(archive) as packed:
            member = packed.getmember('ardia/lib/ardia/ardia-update-verify')
            self.assertEqual(member.mode & 0o777, 0o755)
            self.assertEqual(packed.extractfile(member).read(), binary.read_bytes())


if __name__ == '__main__':
    unittest.main()
