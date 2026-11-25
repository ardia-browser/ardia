import base64
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
CORE = HERE.parents[1]
REPO = HERE.parents[3]
HOSTILE = REPO / 'scripts/security/hostile-inputs.mjs'
VECTORS = json.loads((HERE.parent / 'update-vectors.json').read_text(encoding='utf-8'))
REQUIRED = os.environ.get('ARDIA_REQUIRE_WINDOWS_CROSSCHECK') == '1'
SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
WINDOWS = VECTORS['windows']
PUBLISHED_UNDER = 'https://github.com/ardia-browser/ardia/releases/download/'
MAX_ARGUMENT = 65536


def unavailable(why):
    if REQUIRED:
        raise AssertionError(f'{why}, and ARDIA_REQUIRE_WINDOWS_CROSSCHECK=1 asks for the cross-check')
    raise unittest.SkipTest(why)


def expected(case, implementation, field):
    return case.get(implementation, case[field])


def public_pem(key_hex):
    der = SPKI_PREFIX + bytes.fromhex(key_hex)
    return f'-----BEGIN PUBLIC KEY-----\n{base64.b64encode(der).decode()}\n-----END PUBLIC KEY-----\n'


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


def verdict(binary, manifest, signature, key, published_under, cpu, current_build):
    result = subprocess.run([str(binary), 'windows-manifest', '--key', str(key), '--manifest', str(manifest),
                             '--signature', str(signature), '--published-under', published_under, '--cpu', cpu,
                             '--current-build', str(current_build)], capture_output=True, timeout=60)
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
const [vectorsPath, manifestTsPath] = process.argv.slice(2);
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8"));
const win = await import(pathToFileURL(manifestTsPath).href);
const prefix = Buffer.from("302a300506032b6570032100", "hex");
const results = vectors.windows.map((c) => {
  const sig = Buffer.from(c.signature, "hex");
  let sigOk = false;
  if (sig.length === 64) {
    try {
      const key = createPublicKey({ key: Buffer.concat([prefix, Buffer.from(c.publicKey, "hex")]), format: "der", type: "spki" });
      sigOk = verify(null, Buffer.from(c.manifest, "utf8"), key, sig);
    } catch {
      sigOk = false;
    }
  }
  const parsed = win.readManifest(c.manifest, c.publishedUnder);
  const inst = parsed ? (c.cpu === "x64" || c.cpu === "arm64" ? parsed.installers[c.cpu] ?? null : null) : null;
  const parseOut = parsed
    ? (inst ? { version: parsed.version, build: parsed.build, url: inst.url, sha256: inst.sha256, bytes: inst.bytes } : { error: "kind" })
    : { error: c.manifest.length > 65536 ? "tooLarge" : "manifest" };
  return { sigOk, parseOut };
});
console.log(JSON.stringify(results));
'''


class WindowsUpdateParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-windows-update-')
        cls.dir = pathlib.Path(cls.scratch.name)
        cls.files = []
        for index, case in enumerate(WINDOWS):
            manifest = cls.dir / f'{index}.json'
            signature = cls.dir / f'{index}.sig'
            key = cls.dir / f'{index}.pem'
            manifest.write_bytes(case['manifest'].encode())
            signature.write_bytes(bytes.fromhex(case['signature']))
            key.write_text(public_pem(case['publicKey']))
            cls.files.append((manifest, signature, key))

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def verifier(self):
        if not hasattr(type(self), 'binary'):
            type(self).binary = verifier_binary()
        return type(self).binary

    def test_the_windows_verifier_matches_every_shared_vector(self):
        binary = self.verifier()
        for case, (manifest, signature, key) in zip(WINDOWS, self.files):
            line, status = verdict(binary, manifest, signature, key, case['publishedUnder'], case['cpu'],
                                   case['currentBuild'])
            want = expected(case, 'helper', 'outcome')
            if 'error' in want:
                self.assertEqual((line, status), (f'failed {want["error"]}', 1), case['name'])
            else:
                self.assertEqual(
                    (line, status),
                    (f'ok {want["version"]} {want["build"]} {want["url"]} {want["sha256"]} {want["bytes"]}', 0),
                    case['name'],
                )

    def test_node_crypto_and_typescript_manifest_parser_agree_with_core_vectors(self):
        node = shutil.which('node')
        if node is None:
            unavailable('node is unavailable')
        stripping = subprocess.run([node, '--experimental-strip-types', '-e', '0'], capture_output=True, text=True)
        flags = ['--experimental-strip-types', '--no-warnings'] if stripping.returncode == 0 else []
        script = self.dir / 'node-driver.mjs'
        script.write_text(NODE_DRIVER)
        result = subprocess.run([node, *flags, str(script), str(HERE.parent / 'update-vectors.json'),
                                 str(REPO / 'packages/expo-windows/src/updater/manifest.ts')],
                                capture_output=True, text=True, timeout=120)
        if result.returncode != 0 and ('ERR_UNKNOWN_FILE_EXTENSION' in result.stderr or 'strip-types' in result.stderr):
            unavailable('this node cannot load TypeScript')
        self.assertEqual(result.returncode, 0, result.stderr)
        got = json.loads(result.stdout)
        self.assertEqual(len(got), len(WINDOWS))
        for case, entry in zip(WINDOWS, got):
            self.assertEqual(entry['sigOk'], case['signatureValid'], case['name'])
            self.assertEqual(entry['parseOut'], case['parse'], case['name'])

    def test_no_hostile_string_passes_the_windows_verifier(self):
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
        base_case = next(case for case in WINDOWS if case['name'] == 'x64 install, both CPUs')
        base_obj = json.loads(base_case['manifest'])
        forged = []
        for entry in hostile:
            value = entry['value']
            forged += [
                (entry['id'], 'raw', value),
                (entry['id'], 'version', json.dumps({**base_obj, 'version': value})),
                (entry['id'], 'url', json.dumps({**base_obj, 'x64': {**base_obj['x64'], 'url': value}})),
                (entry['id'], 'url_suffix', json.dumps({**base_obj, 'x64': {**base_obj['x64'], 'url': f'{PUBLISHED_UNDER}windows-alpha/{value}.exe'}})),
                (entry['id'], 'sha256', json.dumps({**base_obj, 'x64': {**base_obj['x64'], 'sha256': value}})),
                (entry['id'], 'key', json.dumps({**base_obj, value: 1})),
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
        manifest = self.dir / 'hostile.json.body'
        signature = self.dir / 'hostile.json.sig'
        self.assertEqual(len(encoded), len(forged))
        self.assertEqual(len(signed['signatures']), len(forged))
        for (name, field, _), body, sig in zip(forged, encoded, signed['signatures']):
            manifest.write_bytes(body)
            signature.write_bytes(bytes.fromhex(sig))
            line, status = verdict(binary, manifest, signature, key, PUBLISHED_UNDER, 'x64', 59)
            if field == 'url_suffix' and status == 0:
                tokens = line.split(' ')
                self.assertEqual(len(tokens), 6, f'{name} as {field}: {line}')
                self.assertTrue(tokens[3].startswith(f'{PUBLISHED_UNDER}windows-alpha/'), f'{name}: {tokens[3]}')
                self.assertTrue(tokens[3].endswith('.exe'), f'{name}: {tokens[3]}')
                suffix = tokens[3][len(f'{PUBLISHED_UNDER}windows-alpha/'):-4]
                self.assertRegex(suffix, r'^[0-9A-Za-z][0-9A-Za-z._+-]*$', f'{name}: {tokens[3]}')
            else:
                self.assertEqual((line, status), ('failed manifest', 1), f'{name} as {field}')
        good = self.files[WINDOWS.index(base_case)]
        self.assertEqual(verdict(binary, *good, PUBLISHED_UNDER, 'x64', 59)[1], 0)
        for entry in hostile:
            value = entry['value']
            if not passable(value):
                continue
            self.assertEqual(verdict(binary, *good, value, 'x64', 59), ('failed manifest', 1),
                             f'{entry["id"]} as --published-under')
            self.assertEqual(verdict(binary, *good, PUBLISHED_UNDER, value, 59), ('failed usage', 2),
                             f'{entry["id"]} as --cpu')
            self.assertEqual(verdict(binary, *good, PUBLISHED_UNDER, 'x64', value), ('failed usage', 2),
                             f'{entry["id"]} as --current-build')

    def test_windows_vectors_cover_every_expected_outcome(self):
        outcomes = {c['outcome'].get('error', 'ok') for c in WINDOWS}
        self.assertEqual(outcomes, {'ok', 'tooLarge', 'manifest', 'signature', 'notNewer', 'kind'})


if __name__ == '__main__':
    unittest.main()
