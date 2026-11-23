import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[3]
LINUX = REPO / 'engine/ardiacore-linux/src'
HELPER = REPO / 'scripts/linux/ardia-update'
VECTORS = json.loads((HERE.parent / 'update-vectors.json').read_text(encoding='utf-8'))
REQUIRED = os.environ.get('ARDIA_REQUIRE_LINUX_CROSSCHECK') == '1'
SPKI_PREFIX = bytes.fromhex('302a300506032b6570032100')
HELPER_FUNCTIONS = ['note', 'finish', 'fail', 'version_parts', 'newer_than', 'parse_manifest']
HELPER_SETTINGS = ['max_package', 'max_manifest', 'signature_size', 'version_pattern', 'version_line_pattern',
                   'package_line_pattern']
MANIFESTS = VECTORS['manifests']
VERSIONS = VECTORS['versions']
EMPTY_INPUT_REFUSALS = {'failed signature', 'failed manifest'}


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


def bash4():
    for candidate in [os.environ.get('BASH4'), shutil.which('bash'), '/opt/homebrew/bin/bash', '/usr/local/bin/bash']:
        if not candidate or not pathlib.Path(candidate).exists():
            continue
        major = subprocess.run([candidate, '-c', 'echo ${BASH_VERSINFO[0]}'], capture_output=True, text=True).stdout
        if major.strip().isdigit() and int(major) >= 4:
            return candidate
    return None


def helper_source():
    text = HELPER.read_text(encoding='utf-8')
    parts = []
    for name in HELPER_SETTINGS:
        found = re.search(rf'^{name}=.*$', text, re.M)
        assert found, f'{name}= is no longer in {HELPER}'
        parts.append(found.group(0))
    for name in HELPER_FUNCTIONS:
        found = re.search(rf'^{name}\(\) \{{.*?\}}$' if f'{name}() {{ ' in text else rf'^{name}\(\) \{{\n.*?^\}}$',
                          text, re.M | re.S)
        assert found, f'{name}() is no longer in {HELPER}'
        parts.append(found.group(0))
    return '\n'.join(parts)


HELPER_DRIVER = r'''
set -uo pipefail
run_case() {
  local file=$1 named_version=$2 installed=$3 kind=$4 signature=$5 key=$6 signature_ok=$7
  (
    work=$(mktemp -d)
    trap 'rm -rf -- "$work"' EXIT
    current=$installed
    version_parts "$current" >/dev/null || fail kind
    version_parts "$named_version" >/dev/null || fail manifest
    (($(wc -c <"$file") <= max_manifest)) || fail manifest
    (($(wc -c <"$signature") == signature_size)) || fail signature
    if [[ -n "$OPENSSL3" ]]; then
      "$OPENSSL3" pkeyutl -verify -pubin -inkey "$key" -rawin -in "$file" -sigfile "$signature" >/dev/null 2>&1 \
        || fail signature
    else
      [[ "$signature_ok" == 1 ]] || fail signature
    fi
    version="" package_name="" package_digest="" package_size=""
    parse_manifest "$file"
    [[ "$version" == "$named_version" ]] || fail manifest
    newer_than "$version" "$current" || fail notNewer
    [[ -n "$package_name" ]] || fail kind
    finish "ok $package_name $package_digest $package_size"
  ) 2>/dev/null
}
while IFS=$'\t' read -r file named installed kind signature key signature_ok; do
  run_case "$file" "$named" "$installed" "$kind" "$signature" "$key" "$signature_ok" | tail -n 1
done
exit 0
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

    def test_the_root_helper_installs_or_refuses_every_manifest_as_recorded(self):
        bash = bash4()
        if bash is None:
            unavailable('bash 4 or later is unavailable')
        openssl = openssl3()
        script = helper_source() + HELPER_DRIVER
        rows = []
        for case, (manifest, signature, key) in zip(MANIFESTS, self.files):
            rows.append('\t'.join([str(manifest), case['version'], case['installed'], case['kind'], str(signature),
                                   str(key), '1' if case.get('openssl', case['signatureValid']) else '0']))
        result = subprocess.run([bash, '-c', script], input='\n'.join(rows) + '\n', capture_output=True, text=True,
                                timeout=300, env={'PATH': os.environ['PATH'], 'LC_ALL': 'C', 'OPENSSL3': openssl or ''})
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout.splitlines()
        self.assertEqual(len(out), len(MANIFESTS), result.stderr)
        for case, line in zip(MANIFESTS, out):
            want = expected(case, 'helper', 'outcome')
            if not case['manifest'] and openssl:
                self.assertIn(line, EMPTY_INPUT_REFUSALS, case['name'])
            elif 'error' not in want:
                self.assertEqual(line, f'ok {want["name"]} {want["sha256"]} {want["size"]}', case['name'])
            else:
                self.assertEqual(line, f'failed {want["error"]}', case['name'])

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


if __name__ == '__main__':
    unittest.main()
