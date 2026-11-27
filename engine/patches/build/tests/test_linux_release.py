#!/usr/bin/env python3
import hashlib
import importlib.util
import io
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[4]
LINUX = REPO / 'scripts/linux'
VERSION = '0.2.44-nightly.3'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


sys.dont_write_bytecode = True
packaging = module('packaging', LINUX / 'package.py')


def fake_engine(root):
    output, ui = root / 'out', root / 'ui'
    output.mkdir()
    ui.mkdir()
    for name in packaging.REQUIRED:
        if name == 'locales':
            (output / name).mkdir()
            (output / name / 'en-US.pak').write_bytes(b'locale')
        else:
            (output / name).write_bytes(b'runtime')
    (output / 'chrome').chmod(0o755)
    (ui / 'index.html').write_text('<html></html>')
    return output, ui


def fake_cli(directory, version=VERSION, platform='linux-x64', top=None, sidecar=True):
    directory.mkdir(parents=True, exist_ok=True)
    name = f'ardia-cli-{version}-{platform}.tar.gz'
    top = top or f'ardia-cli-{version}'
    tarball = directory / name
    with tarfile.open(tarball, 'w:gz') as packed:
        for member, body in ((f'{top}/bin/ardia', b'#!/bin/sh\necho ardia\n'), (f'{top}/python/README', b'python')):
            info = tarfile.TarInfo(member)
            info.size = len(body)
            info.mode = 0o755
            packed.addfile(info, io.BytesIO(body))
    if sidecar:
        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        (directory / (name + '.sha256')).write_text(f'{digest}  {name}\n')
    return tarball


class PackageVersionAndCliTests(unittest.TestCase):
    def test_release_package_carries_version_cli_installer_and_digest(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            output, ui = fake_engine(root)
            tarball = fake_cli(root / 'cli')
            archive = packaging.package(output, ui, root / 'ardia.tar.xz', version=VERSION, cli=tarball)
            with tarfile.open(archive) as packed:
                version = packed.getmember('ardia/lib/ardia/VERSION')
                self.assertEqual(packed.extractfile(version).read().decode(), VERSION + '\n')
                self.assertEqual(version.mode & 0o777, 0o644)
                installer = packed.getmember('ardia/lib/ardia/cli/ardia-cli-install.sh')
                self.assertEqual(installer.mode & 0o777, 0o755)
                self.assertEqual(packed.extractfile(installer).read(), (REPO / 'apps/cli/install.sh').read_bytes())
                shipped = packed.getmember(f'ardia/lib/ardia/cli/{tarball.name}')
                self.assertEqual(shipped.mode & 0o777, 0o644)
                self.assertEqual(packed.extractfile(shipped).read(), tarball.read_bytes())
                digest = packed.extractfile('ardia/lib/ardia/cli/ardia-cli.sha256').read().decode().split()
                self.assertEqual(digest, [hashlib.sha256(tarball.read_bytes()).hexdigest(), tarball.name])
                self.assertEqual(packed.getmember('ardia/lib/ardia/cli').mode & 0o777, 0o755)

    def test_dev_package_has_neither_version_nor_cli(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            output, ui = fake_engine(root)
            archive = packaging.package(output, ui, root / 'dev.tar.xz')
            with tarfile.open(archive) as packed:
                names = packed.getnames()
            self.assertNotIn('ardia/lib/ardia/VERSION', names)
            self.assertFalse(any(name.startswith('ardia/lib/ardia/cli') for name in names))
            archive = packaging.package(output, ui, root / 'versioned.tar.xz', version='1.2.3')
            with tarfile.open(archive) as packed:
                self.assertEqual(packed.extractfile('ardia/lib/ardia/VERSION').read(), b'1.2.3\n')
                self.assertFalse(any(name.startswith('ardia/lib/ardia/cli') for name in packed.getnames()))

    def test_versions_follow_the_contract(self):
        for good in ('0.2.44', '0.2.44-nightly.3', '10.20.30-rc.1'):
            self.assertEqual(packaging.check_version(good), good)
        for bad in ('0.2', 'v0.2.44', '0.2.44-nightly', '0.2.44-Nightly.1', '0.2.44-nightly.1.2', '0.2.44\n', '', None):
            with self.assertRaises(ValueError):
                packaging.check_version(bad)

    def test_cli_tarball_must_match_version_platform_digest_and_layout(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            output, ui = fake_engine(root)
            cases = {
                'other version': (fake_cli(root / 'a', version='0.2.43'), 'not ardia-cli-0.2.44-nightly.3-linux-x64'),
                'mac tarball': (fake_cli(root / 'b', platform='macos-arm64'), 'linux-x64'),
                'stray top': (fake_cli(root / 'c', top='other'), 'outside ardia-cli-0.2.44-nightly.3/'),
            }
            for label, (tarball, message) in cases.items():
                with self.subTest(label), self.assertRaisesRegex(ValueError, message):
                    packaging.package(output, ui, root / f'{label}.tar.xz', version=VERSION, cli=tarball)
            with self.assertRaisesRegex(ValueError, 'needs --version'):
                packaging.package(output, ui, root / 'unversioned.tar.xz', cli=fake_cli(root / 'd'))
            tampered = fake_cli(root / 'e')
            (root / 'e' / (tampered.name + '.sha256')).write_text('0' * 64 + '  ' + tampered.name + '\n')
            with self.assertRaisesRegex(ValueError, 'says'):
                packaging.package(output, ui, root / 'tampered.tar.xz', version=VERSION, cli=tampered)
            unchecked = fake_cli(root / 'f', sidecar=False)
            self.assertTrue(packaging.package(output, ui, root / 'unchecked.tar.xz', version=VERSION, cli=unchecked).is_file())
            self.assertFalse((root / 'other version.tar.xz').exists())

    def test_command_line_requires_version_with_cli(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            output, ui = fake_engine(root)
            tarball = fake_cli(root / 'cli')
            base = [sys.executable, '-I', str(LINUX / 'package.py'), '--out', str(output), '--ui', str(ui)]
            refused = subprocess.run(base + ['--destination', str(root / 'a.tar.xz'), '--cli', str(tarball)], capture_output=True, text=True, timeout=60)
            self.assertEqual(refused.returncode, 2)
            self.assertIn('--cli needs --version', refused.stderr)
            bad = subprocess.run(base + ['--destination', str(root / 'b.tar.xz'), '--version', '1.2'], capture_output=True, text=True, timeout=60)
            self.assertEqual(bad.returncode, 2)
            self.assertIn('bad version', bad.stderr)
            made = subprocess.run(base + ['--destination', str(root / 'c.tar.xz'), '--version', VERSION, '--cli', str(tarball)], capture_output=True, text=True, timeout=120)
            self.assertEqual(made.returncode, 0, made.stderr)
            self.assertTrue((root / 'c.tar.xz').is_file())

    def test_system_install_carries_version_and_cli(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch)
            output, ui = fake_engine(root)
            tarball = fake_cli(root / 'cli')
            archive = packaging.package(output, ui, root / 'ardia.tar.xz', version=VERSION, cli=tarball)
            with tarfile.open(archive) as packed:
                packed.extractall(root / 'extracted', filter='tar')
            result = subprocess.run([str(root / 'extracted/ardia/install.sh'), '--prefix', '/opt/ardia', '--destdir', str(root / 'stage')],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            installed = root / 'stage/opt/ardia/lib/ardia'
            self.assertEqual((installed / 'VERSION').read_text(), VERSION + '\n')
            self.assertEqual((installed / 'cli/ardia-cli-install.sh').stat().st_mode & 0o777, 0o755)
            self.assertEqual((installed / f'cli/{tarball.name}').read_bytes(), tarball.read_bytes())
            self.assertTrue((installed / 'cli/ardia-cli.sha256').is_file())


class ArchPackageTests(unittest.TestCase):
    def source(self, pkgver):
        result = subprocess.run(['bash', '-c', 'source "$1" && pkgver=$2 && source <(grep "^source=" "$1") && printf "%s" "${source[0]}"',
                                 'bash', str(LINUX / 'arch/PKGBUILD'), pkgver], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_source_is_the_release_tarball_of_the_package_version(self):
        release = 'https://github.com/ardia-browser/ardia/releases/download'
        self.assertEqual(self.source('0.2.44nightly.3'), f'ardia-bin-0.2.44nightly.3.tar.xz::{release}/v{VERSION}/Ardia-{VERSION}-linux-x64.tar.xz')
        self.assertEqual(self.source('0.2.45'), f'ardia-bin-0.2.45.tar.xz::{release}/v0.2.45/Ardia-0.2.45-linux-x64.tar.xz')


@unittest.skipUnless(shutil.which('shasum'), 'shasum')
class PublishLinuxAssetsTests(unittest.TestCase):
    STABLE = '0.2.48'
    NAMES = ('Ardia-{v}-linux-x64.tar.xz', 'Ardia-{v}-linux-x64.deb', 'Ardia-{v}-linux-x64.rpm', 'Ardia-{v}-linux-x64.AppImage',
             'Ardia-{v}-linux-x64.flatpak', 'ardia-bin-{v}.src.tar.gz', 'ardia-cli-{v}-linux-x64.tar.gz')

    def linux_section(self):
        script = (REPO / '.claude/skills/release/scripts/publish.sh').read_text()
        return script[script.index('linux="$dist/linux"'):script.index('windows="$dist/windows"')]

    def publish(self, dist):
        script = 'die() { echo "error: $*" >&2; exit 1; }\nassets=()\n' + self.linux_section() + 'printf "asset %s\\n" "${assets[@]##*/}"\n'
        return subprocess.run(['bash', '-c', script], capture_output=True, text=True, timeout=30,
                              env={**os.environ, 'dist': str(dist), 'version': self.STABLE}, cwd=dist)

    def assets(self, result):
        return {line.split(' ', 1)[1] for line in result.stdout.splitlines() if line.startswith('asset ')}

    def dist(self, scratch, provenance_extra=''):
        dist = pathlib.Path(scratch)
        linux = dist / 'linux'
        linux.mkdir()
        for template in self.NAMES:
            name = template.format(v=self.STABLE)
            (linux / name).write_bytes(name.encode())
            (linux / f'{name}.sha256').write_text(f'{hashlib.sha256(name.encode()).hexdigest()}  {name}\n')
        (linux / 'provenance.txt').write_text(f'engine key {"a" * 40} (exact), from /engine\n{provenance_extra}')
        return dist, linux

    def test_every_linux_asset_and_its_digest_join_the_release(self):
        with tempfile.TemporaryDirectory() as scratch:
            dist, _ = self.dist(scratch)
            result = self.publish(dist)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = {template.format(v=self.STABLE) + suffix for template in self.NAMES for suffix in ('', '.sha256')}
            self.assertEqual(self.assets(result), expected)

    def test_the_arch_source_package_is_required(self):
        with tempfile.TemporaryDirectory() as scratch:
            dist, linux = self.dist(scratch)
            (linux / f'ardia-bin-{self.STABLE}.src.tar.gz').unlink()
            result = self.publish(dist)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f'has no ardia-bin-{self.STABLE}.src.tar.gz', result.stderr)

    def test_a_missing_deb_fails_unless_the_release_dropped_it(self):
        with tempfile.TemporaryDirectory() as scratch:
            dist, linux = self.dist(scratch)
            (linux / f'Ardia-{self.STABLE}-linux-x64.deb').unlink()
            (linux / f'Ardia-{self.STABLE}-linux-x64.deb.sha256').unlink()
            result = self.publish(dist)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(f'has no Ardia-{self.STABLE}-linux-x64.deb', result.stderr)
            with (linux / 'provenance.txt').open('a') as provenance:
                provenance.write('deb dropped: it failed scripts/linux/deb-install-test.sh in run 1\n')
            result = self.publish(dist)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(f'Ardia-{self.STABLE}-linux-x64.deb', self.assets(result))
            self.assertIn(f'Ardia-{self.STABLE}-linux-x64.AppImage', self.assets(result))
            self.assertIn('ships without the .deb', result.stdout)

    def test_a_missing_rpm_or_flatpak_fails_unless_the_release_dropped_it(self):
        for suffix, reason in (('rpm', 'it failed scripts/linux/rpm-install-test.sh in run 1'), ('flatpak', 'building it failed (flatpak-build.log)')):
            with self.subTest(suffix), tempfile.TemporaryDirectory() as scratch:
                dist, linux = self.dist(scratch)
                name = f'Ardia-{self.STABLE}-linux-x64.{suffix}'
                (linux / name).unlink()
                (linux / f'{name}.sha256').unlink()
                result = self.publish(dist)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'has no {name}', result.stderr)
                with (linux / 'provenance.txt').open('a') as provenance:
                    provenance.write(f'{suffix} dropped: {reason}\n')
                result = self.publish(dist)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn(name, self.assets(result))
                self.assertIn(f'Ardia-{self.STABLE}-linux-x64.deb', self.assets(result))
                self.assertIn(f'ships without the .{suffix}', result.stdout)

    def test_a_wrong_digest_fails(self):
        with tempfile.TemporaryDirectory() as scratch:
            dist, linux = self.dist(scratch)
            (linux / f'ardia-bin-{self.STABLE}.src.tar.gz').write_bytes(b'changed')
            result = self.publish(dist)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("don't match their .sha256 files", result.stderr)


class ReleaseScriptTests(unittest.TestCase):
    def run_release(self, *args):
        return subprocess.run(['bash', str(LINUX / 'release.sh'), *args], capture_output=True, text=True, timeout=60, cwd=REPO)

    def test_help_and_argument_errors(self):
        usage = self.run_release('--help')
        self.assertEqual(usage.returncode, 0)
        for text in ('--engine exact', '--allow-dirty', 'gh release upload', 'dist/<version>/linux'):
            self.assertIn(text, usage.stdout)
        self.assertEqual(self.run_release().returncode, 64)
        self.assertEqual(self.run_release('0.2.44', '--bogus').returncode, 64)
        self.assertIn('neither a stable', self.run_release('0.2.44-rc.1').stderr)
        self.assertIn('MARKETING_VERSION', self.run_release('99.0.0').stderr)
        self.assertIn('needs exact, nearest or a directory', self.run_release('99.0.0', '--engine').stderr)

    def test_script_is_valid_bash_without_comments(self):
        source = (LINUX / 'release.sh').read_text()
        self.assertEqual(subprocess.run(['bash', '-n', str(LINUX / 'release.sh')]).returncode, 0)
        lines = [line.strip() for line in source.splitlines()[1:]]
        self.assertFalse([line for line in lines if line.startswith('#')])
        self.assertTrue(os.access(LINUX / 'release.sh', os.X_OK))


STUB_PYTHON = {
    'scripts/release/official-plugins.py': '''
import hashlib, pathlib, sys
if sys.argv[1] == 'describe':
    print('plugin cli 0.0.0 fixture')
    sys.exit(0)
out = pathlib.Path(sys.argv[3])
out.write_bytes(b'cli')
pathlib.Path(f'{out}.sha256').write_text(f'{hashlib.sha256(b"cli").hexdigest()}  {out.name}\\n')
''',
    'scripts/linux/runtime_files.py': 'import sys\nsys.exit(0)\n',
    'scripts/linux/package.py': '''
import pathlib, sys
args = sys.argv[1:]
for flag in ('--destination', '--deb', '--appimage', '--rpm'):
    if flag in args:
        pathlib.Path(args[args.index(flag) + 1]).write_bytes(flag.encode())
''',
    'scripts/linux/linux_formats.py': '''
import os, pathlib, sys
args = sys.argv[1:]
for flag, fails in (('--rpm', 'FAKE_RPM_BUILD'), ('--flatpak', 'FAKE_FLATPAK_BUILD')):
    if flag in args:
        if os.environ.get(fails) == 'fail':
            print(f'{flag} build failed', file=sys.stderr)
            sys.exit(1)
        pathlib.Path(args[args.index(flag) + 1]).write_bytes(flag.encode())
''',
}

STUB_NODE = {
    'scripts/lib/release-note.mjs': 'process.exit(0);\n',
    'scripts/linux/smoke.mjs': '''
import { mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const pkg = args[args.indexOf("--package") + 1];
mkdirSync(args[args.indexOf("--results") + 1], { recursive: true });
const failing = (process.env.FAKE_SMOKE_FAILS ?? "").split(",").filter(Boolean);
process.exit(failing.some((suffix) => pkg.endsWith(suffix)) ? 1 : 0);
''',
    'scripts/linux/sign-update.mjs': '''
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(`${args[args.indexOf("--dir") + 1]}/Ardia-${args[args.indexOf("--version") + 1]}-linux-update.txt`, "manifest\\n");
''',
}

STUB_SHELL = {
    'engine/engine-key.sh': 'echo fixturekey\n',
    'scripts/linux/update-verify.sh': 'echo "$(cd "$(dirname "$0")" && pwd)/update-verify.sh"\n',
    'scripts/linux/fetch-ubo.sh': 'echo "$(cd "$(dirname "$0")" && pwd)"\n',
    'scripts/linux/arch/update-pkgbuild.sh': 'while [ $# -gt 0 ]; do [ "$1" = --out ] && out=$2; shift; done\nmkdir -p "$out"\necho pkgbuild > "$out/PKGBUILD"\n',
}

REAL_TOOLS = ('bash', 'sh', 'env', 'node', 'python3', 'sha256sum', 'tar', 'xz', 'gzip', 'git', 'sed', 'awk', 'cut', 'grep', 'mktemp',
              'dirname', 'basename', 'ls', 'rm', 'mkdir', 'find', 'du', 'cat', 'sort', 'head', 'tail', 'cp', 'mv', 'chmod', 'tr', 'wc', 'pwd', 'timeout')
RPM_TOOLS = ('rpmbuild', 'rpm', 'rpm2cpio', 'cpio')


@unittest.skipUnless(all(shutil.which(tool) for tool in ('node', 'git', 'sha256sum', 'xz')), 'needs node, git, sha256sum and xz')
class ReleaseOptionalRpmTests(unittest.TestCase):
    VERSION = '0.2.44-nightly.3'

    def fake_repo(self, root):
        repo = root / 'repo'
        (repo / 'scripts/lib').mkdir(parents=True)
        (repo / 'scripts/linux').mkdir()
        shutil.copy(LINUX / 'release.sh', repo / 'scripts/linux/release.sh')
        shutil.copy(REPO / 'scripts/lib/releases.sh', repo / 'scripts/lib/releases.sh')
        pbx = repo / 'apps/browser/macos/Ardia.xcodeproj/project.pbxproj'
        pbx.parent.mkdir(parents=True)
        pbx.write_text(f'MARKETING_VERSION = {self.VERSION};\n')
        notes = repo / f'docs/release-notes/{self.VERSION}.md'
        notes.parent.mkdir(parents=True)
        notes.write_text('notes\n')
        for stubs in (STUB_PYTHON, STUB_NODE, STUB_SHELL):
            for name, body in stubs.items():
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(('#!/usr/bin/env bash\n' if stubs is STUB_SHELL else '') + body.lstrip('\n'))
                path.chmod(0o755)
        engine = root / 'engine'
        engine.mkdir()
        (engine / 'manifest.json').write_text('{"engine_key": "fixturekey", "chromium_version": "157.0.0.0", "source_commit": "abc"}')
        git = ['git', '-C', str(repo), '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid']
        subprocess.run([*git, 'init', '-q'], check=True)
        subprocess.run([*git, 'add', '-A'], check=True)
        subprocess.run([*git, 'commit', '-q', '-m', 'fixture'], check=True)
        return repo, engine

    def tools(self, root, rpm_tools=True):
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        for tool in REAL_TOOLS:
            found = shutil.which(tool)
            if found:
                (bin_dir / tool).symlink_to(found)
        for tool in ('pnpm', 'dpkg-deb', 'readelf', *(RPM_TOOLS if rpm_tools else ())):
            (bin_dir / tool).write_text('#!/bin/sh\nexit 0\n')
            (bin_dir / tool).chmod(0o755)
        return bin_dir

    def release(self, rpm_tools=True, **fails):
        root = pathlib.Path(tempfile.mkdtemp(prefix='ardia-release-rpm-'))
        self.addCleanup(shutil.rmtree, root, True)
        repo, engine = self.fake_repo(root)
        out = root / 'out'
        env = {'PATH': str(self.tools(root, rpm_tools)), 'HOME': str(root), **{key: value for key, value in fails.items()}}
        result = subprocess.run(['bash', str(repo / 'scripts/linux/release.sh'), self.VERSION, '--engine', str(engine), '--out', str(out)],
                                capture_output=True, text=True, timeout=120, cwd=repo, env=env)
        provenance = (out / 'provenance.txt').read_text() if (out / 'provenance.txt').exists() else ''
        return result, out, provenance

    def name(self, suffix):
        return f'Ardia-{self.VERSION}-linux-x64.{suffix}'

    def assert_rest_ships(self, result, out, provenance):
        self.assertEqual(result.returncode, 0, result.stderr)
        for suffix in ('tar.xz', 'deb', 'AppImage', 'flatpak'):
            self.assertTrue((out / self.name(suffix)).is_file(), suffix)
            self.assertTrue((out / f'{self.name(suffix)}.sha256').is_file(), suffix)
            self.assertIn(self.name(suffix), result.stdout.split('gh release upload')[-1])
        self.assertTrue((out / f'Ardia-{self.VERSION}-linux-update.txt').is_file(), 'the update manifest is written')
        self.assertRegex(provenance, r'(?m)^deb [0-9a-f]{64}  ')

    def assert_rpm_dropped(self, result, out, provenance, reason):
        self.assert_rest_ships(result, out, provenance)
        self.assertFalse((out / self.name('rpm')).exists())
        self.assertFalse((out / f'{self.name("rpm")}.sha256').exists())
        self.assertIn(f'rpm dropped: {reason}', provenance)
        self.assertNotRegex(provenance, r'(?m)^rpm [0-9a-f]{64}')
        self.assertNotIn(self.name('rpm'), result.stdout.split('gh release upload')[-1])
        self.assertIn('the .rpm is left out of this release', result.stderr)

    def test_a_good_rpm_ships_with_the_rest(self):
        result, out, provenance = self.release()
        self.assert_rest_ships(result, out, provenance)
        self.assertTrue((out / self.name('rpm')).is_file())
        self.assertRegex(provenance, rf'(?m)^rpm [0-9a-f]{{64}}  {self.name("rpm")}$')
        self.assertIn(self.name('rpm'), result.stdout.split('gh release upload')[-1])

    def test_an_rpm_that_fails_to_build_is_left_out_and_the_rest_ships(self):
        self.assert_rpm_dropped(*self.release(FAKE_RPM_BUILD='fail'), 'building it failed (rpm-build.log)')

    def test_an_rpm_that_fails_the_smoke_gate_is_left_out_and_the_rest_ships(self):
        self.assert_rpm_dropped(*self.release(FAKE_SMOKE_FAILS='.rpm'), 'it failed the smoke gate (smoke-rpm/results.json)')

    def test_without_the_rpm_tools_the_rpm_is_left_out_and_the_rest_ships(self):
        self.assert_rpm_dropped(*self.release(rpm_tools=False), 'building it needs rpmbuild rpm rpm2cpio cpio')

    def test_a_deb_that_fails_the_smoke_gate_still_stops_the_release(self):
        result, out, _ = self.release(FAKE_SMOKE_FAILS='.deb')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('the smoke gate failed for the .deb', result.stderr)
        self.assertFalse((out / f'Ardia-{self.VERSION}-linux-update.txt').exists())


if __name__ == '__main__':
    unittest.main()
