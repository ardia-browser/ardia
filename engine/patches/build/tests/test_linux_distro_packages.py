#!/usr/bin/env python3
import datetime
import importlib.util
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree

REPO = pathlib.Path(__file__).resolve().parents[4]
LINUX = REPO / 'scripts/linux'
ARCH = LINUX / 'arch'
ELF = pathlib.Path(shutil.which('true') or '/usr/bin/true')
DIGEST = 'ab' * 32

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('linux_formats', LINUX / 'linux_formats.py')
formats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(formats)


def run(*args):
    return subprocess.run([str(arg) for arg in args], capture_output=True, text=True)


class DebVersionTests(unittest.TestCase):
    def test_a_nightly_sorts_before_its_stable(self):
        self.assertEqual(formats.deb_version('0.2.47'), '0.2.47')
        self.assertEqual(formats.deb_version('0.2.47-nightly.3'), '0.2.47~nightly.3')
        for bad in ('0.2', None):
            with self.assertRaisesRegex(ValueError, 'bad version'):
                formats.deb_version(bad)

    @unittest.skipUnless(shutil.which('dpkg'), 'dpkg')
    def test_dpkg_upgrades_a_nightly_to_its_stable(self):
        def older(first, second):
            return run('dpkg', '--compare-versions', formats.deb_version(first), 'lt', formats.deb_version(second)).returncode == 0
        self.assertTrue(older('0.2.47-nightly.2', '0.2.47-nightly.10'))
        self.assertTrue(older('0.2.47-nightly.10', '0.2.47'))
        self.assertTrue(older('0.2.47', '0.2.48-nightly.1'))


@unittest.skipUnless(shutil.which('readelf') and ELF.is_file(), 'readelf and an ELF executable')
class DebDependsTests(unittest.TestCase):
    def runtime(self, scratch, needed):
        runtime = pathlib.Path(scratch) / 'usr/lib/ardia'
        runtime.mkdir(parents=True)
        shutil.copyfile(ELF, runtime / 'chrome')
        shutil.copyfile(ELF, runtime / 'libqt6_shim.so')
        shutil.copyfile(ELF, runtime / 'libEGL.so')
        self.needed = needed
        return runtime

    def setUp(self):
        self.original = formats.needed_libraries
        formats.needed_libraries = lambda path: self.needed.get(path.name, [])

    def tearDown(self):
        formats.needed_libraries = self.original

    def test_sonames_map_to_packages_once_and_bundled_or_optional_ones_are_skipped(self):
        with tempfile.TemporaryDirectory() as scratch:
            runtime = self.runtime(scratch, {'chrome': ['libc.so.6', 'libnss3.so', 'libsmime3.so', 'libEGL.so', 'libgio-2.0.so.0', 'libglib-2.0.so.0']})
            packages = formats.deb_depends(runtime)
        self.assertRegex(packages[0], r'^libc6 \(>= 2\.[0-9]+\)$')
        self.assertEqual(packages.count('libnss3'), 1)
        self.assertEqual(packages.count('libglib2.0-0t64 | libglib2.0-0'), 1)
        self.assertIn('libgtk-3-0t64 | libgtk-3-0', packages)
        self.assertIn('libsecret-1-0', packages)
        self.assertIn('xdg-utils', packages)
        self.assertIn('curl', packages)
        self.assertFalse([package for package in packages if 'qt' in package.lower()])

    def test_an_unknown_soname_fails_the_build(self):
        with tempfile.TemporaryDirectory() as scratch:
            runtime = self.runtime(scratch, {'chrome': ['libc.so.6', 'libnew.so.1']})
            with self.assertRaisesRegex(ValueError, 'libnew.so.1'):
                formats.deb_depends(runtime)


class PkgbuildTests(unittest.TestCase):
    def test_committed_srcinfo_matches_the_pkgbuild(self):
        result = run(ARCH / 'update-pkgbuild.sh', '--check')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_update_pins_the_release_tarball(self):
        with tempfile.TemporaryDirectory() as scratch:
            result = run(ARCH / 'update-pkgbuild.sh', '0.2.48-nightly.1', '--sha256', DIGEST, '--out', scratch)
            self.assertEqual(result.returncode, 0, result.stderr)
            pkgbuild = (pathlib.Path(scratch) / 'PKGBUILD').read_text()
            srcinfo = (pathlib.Path(scratch) / '.SRCINFO').read_text()
        self.assertIn('pkgver=0.2.48nightly.1\n', pkgbuild)
        self.assertIn('pkgrel=1\n', pkgbuild)
        self.assertIn(f"sha256sums=('{DIGEST}')\n", pkgbuild)
        self.assertIn('\tpkgver = 0.2.48nightly.1\n', srcinfo)
        self.assertIn('\tsource = ardia-bin-0.2.48nightly.1.tar.xz::https://github.com/ardia-browser/ardia/releases/download/'
                      'v0.2.48-nightly.1/Ardia-0.2.48-nightly.1-linux-x64.tar.xz\n', srcinfo)
        self.assertIn(f'\tsha256sums = {DIGEST}\n', srcinfo)
        self.assertNotIn('SKIP', pkgbuild + srcinfo)

    @unittest.skipUnless(shutil.which('makepkg'), 'makepkg')
    def test_srcinfo_is_what_makepkg_prints(self):
        with tempfile.TemporaryDirectory() as scratch:
            run(ARCH / 'update-pkgbuild.sh', '0.2.48', '--sha256', DIGEST, '--out', scratch)
            printed = subprocess.run(['makepkg', '--printsrcinfo'], cwd=scratch, capture_output=True, text=True)
            self.assertEqual(printed.stdout, (pathlib.Path(scratch) / '.SRCINFO').read_text())

    @unittest.skipUnless(shutil.which('vercmp'), 'vercmp')
    def test_pacman_sorts_a_nightly_before_its_stable(self):
        def pkgver(version):
            with tempfile.TemporaryDirectory() as scratch:
                run(ARCH / 'update-pkgbuild.sh', version, '--sha256', DIGEST, '--out', scratch)
                return next(line.split('=', 1)[1] for line in (pathlib.Path(scratch) / 'PKGBUILD').read_text().splitlines() if line.startswith('pkgver='))
        ordered = [pkgver(version) for version in ('0.2.46', '0.2.47-nightly.2', '0.2.47-nightly.10', '0.2.47', '0.2.48-nightly.1')]
        for older, newer in zip(ordered, ordered[1:]):
            self.assertEqual(run('vercmp', older, newer).stdout.strip(), '-1', f'{older} < {newer}')

    def test_publish_refuses_to_move_back_and_orders_nightlies_before_stables(self):
        script = (ARCH / 'publish-aur.sh').read_text()
        order_key = script[script.index('order_key() {'):script.index('\n}\n', script.index('order_key() {')) + 3]
        def newest(*versions):
            keys = ' '.join(f'"$(order_key {version})"' for version in versions)
            result = subprocess.run(['bash', '-c', f'{order_key}printf "%s\\n" {keys} | sort -V | tail -1'], capture_output=True, text=True)
            return result.stdout.strip()
        self.assertEqual(newest('0.2.47nightly.2', '0.2.47'), '0.2.47.1.0')
        self.assertEqual(newest('0.2.47nightly.10', '0.2.47nightly.2'), '0.2.47.0.10')
        self.assertEqual(newest('0.2.48nightly.1', '0.2.47'), '0.2.48.0.1')

    def test_bad_input_is_refused(self):
        self.assertEqual(run(ARCH / 'update-pkgbuild.sh', '0.2', '--sha256', DIGEST).returncode, 1)
        self.assertEqual(run(ARCH / 'update-pkgbuild.sh', '0.2.48', '--sha256', 'SKIP').returncode, 1)
        self.assertEqual(run(ARCH / 'update-pkgbuild.sh', '0.2.48').returncode, 1)


class RpmTests(unittest.TestCase):
    DATE = datetime.datetime(2026, 11, 23, tzinfo=datetime.timezone.utc)

    def test_a_nightly_sorts_before_its_stable(self):
        self.assertEqual(formats.rpm_version('0.2.47'), '0.2.47')
        self.assertEqual(formats.rpm_version('0.2.47-nightly.3'), '0.2.47~nightly.3')
        for bad in ('0.2', None, '0.2.47-nightly'):
            with self.assertRaisesRegex(ValueError, 'bad version'):
                formats.rpm_version(bad)

    @unittest.skipUnless(shutil.which('rpm'), 'rpm')
    def test_rpm_upgrades_a_nightly_to_its_stable(self):
        def older(first, second):
            result = run('rpm', '--eval', f'%{{lua: print(rpm.vercmp("{formats.rpm_version(first)}", "{formats.rpm_version(second)}"))}}')
            return result.stdout.strip() == '-1'
        ordered = ('0.2.46', '0.2.47-nightly.2', '0.2.47-nightly.10', '0.2.47', '0.2.48-nightly.1')
        for first, second in zip(ordered, ordered[1:]):
            self.assertTrue(older(first, second), f'{first} < {second}')

    def test_the_spec_leaves_dependencies_to_rpm_but_never_on_what_it_bundles(self):
        spec = formats.rpm_spec('0.2.47-nightly.3', ['libEGL.so', 'libvulkan.so.1'], pathlib.Path('/tmp/tree'), self.DATE)
        self.assertIn('Version: 0.2.47~nightly.3\nRelease: 1\n', spec)
        self.assertIn('AutoReqProv: yes\n', spec)
        self.assertIn('%global __requires_exclude ^(libEGL\\\\.so|libvulkan\\\\.so\\\\.1)\\\\(\n', spec)
        self.assertIn('%global __requires_exclude_from ^/usr/lib/ardia/(libqt5_shim\\\\.so|libqt6_shim\\\\.so)$\n', spec)
        self.assertIn('%global __provides_exclude_from ^/usr/lib/ardia/.*$\n', spec)
        self.assertIn('%global _build_id_links none\n', spec)
        for name in ('libgtk-3.so.0()(64bit)', 'libsecret-1.so.0()(64bit)', 'xdg-utils', '(curl or curl-minimal)', 'openssl'):
            self.assertIn(f'Requires: {name}\n', spec)
        self.assertIn('Recommends: /usr/bin/pkexec\n', spec)
        files = spec[spec.index('%files'):spec.index('%changelog')]
        for owned in ('/usr/lib/ardia\n', '/usr/bin/ardia\n', '%dir /usr/share/polkit-1/actions\n', '/usr/share/licenses/ardia\n',
                      '/usr/share/applications/ardia.desktop\n', '/usr/share/applications/ardia-little.desktop\n',
                      '/usr/share/applications/ardia-settings.desktop\n', '/usr/share/applications/ardia-import.desktop\n'):
            self.assertIn(owned, files)
        self.assertIn('%defattr(-,root,root,-)', files)
        self.assertIn('* Mon Nov 23 2026 Ardia <hello@ardia.dev> - 0.2.47~nightly.3-1', spec)

    def test_the_scriptlets_set_up_apparmor_and_take_it_away_only_on_removal(self):
        spec = formats.rpm_spec('0.2.48', [], pathlib.Path('/tmp/tree'), self.DATE)
        post = spec[spec.index('%post\n'):spec.index('%postun\n')]
        postun = spec[spec.index('%postun\n'):spec.index('%files\n')]
        self.assertIn('install -m 0644 /usr/share/ardia/apparmor/ardia /etc/apparmor.d/ardia', post)
        self.assertIn('if [ "$1" = 0 ]; then', postun)
        self.assertLess(postun.index('if [ "$1" = 0 ]; then'), postun.index('rm -f /etc/apparmor.d/ardia'))
        self.assertNotIn('#!', spec)

    def test_the_policy_leaves_updates_to_rpm(self):
        policy = (LINUX / 'dev.ardia.linux.policy').read_text()
        kept = formats.without_update_action(policy)
        self.assertNotIn('dev.ardia.linux.update', kept)
        self.assertNotIn('ardia-update', kept)
        self.assertIn('<action id="dev.ardia.linux.reauthenticate">', kept)
        ElementTree.fromstring(kept.split('\n', 2)[2])
        with self.assertRaisesRegex(ValueError, 'no dev.ardia.linux.update action'):
            formats.without_update_action(kept)

    @unittest.skipUnless(shutil.which('rpmbuild') and shutil.which('rpm') and ELF.is_file(), 'rpmbuild')
    def test_a_built_rpm_is_root_owned_with_a_setuid_helper_a_tilde_version_and_runtime_requires(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = pathlib.Path(scratch) / 'ardia'
            runtime = root / 'lib/ardia'
            runtime.mkdir(parents=True)
            for name in ('chrome', 'libEGL.so', 'chrome-sandbox'):
                shutil.copyfile(ELF, runtime / name)
                (runtime / name).chmod(0o755)
            (runtime / 'ardia-launch').write_text('#!/usr/bin/env bash\n')
            (root / 'share/applications').mkdir(parents=True)
            for name, entry in formats.desktop_entries().items():
                (root / 'share/applications' / name).write_text(entry)
            (root / 'share/icons/hicolor/256x256/apps').mkdir(parents=True)
            (root / 'share/icons/hicolor/256x256/apps/ardia.png').write_bytes(b'png')
            (root / 'share/polkit-1/actions').mkdir(parents=True)
            shutil.copyfile(LINUX / 'dev.ardia.linux.policy', root / 'share/polkit-1/actions/dev.ardia.linux.policy')
            (root / 'share/apparmor.d').mkdir(parents=True)
            shutil.copyfile(LINUX / 'ardia.apparmor', root / 'share/apparmor.d/ardia')
            built = formats.build_rpm(root, pathlib.Path(scratch) / 'ardia.rpm', '0.2.48-nightly.1', 'w1.gzdio')
            requires = run('rpm', '-qpR', built).stdout
            listing = run('rpm', '-qplv', built).stdout
            version = run('rpm', '-qp', '--qf', '%{VERSION}', built).stdout
        self.assertEqual(version, '0.2.48~nightly.1')
        self.assertIn('libsecret-1.so.0()(64bit)', requires)
        self.assertRegex(listing, r'-rwsr-xr-x\s+1 root\s+root .* /usr/lib/ardia/chrome-sandbox\n')
        self.assertRegex(listing, r'/usr/bin/ardia -> \.\./lib/ardia/ardia-launch\n')
        self.assertNotRegex(listing, r'(?m)^\S+\s+\d+ (?!root\s+root)')
        for name in formats.desktop_entries():
            self.assertRegex(listing, rf'-rw-r--r--\s+1 root\s+root .* /usr/share/applications/{re.escape(name)}\n')


class FlatpakTests(unittest.TestCase):
    SOURCE = {'url': 'https://github.com/ardia-browser/ardia/releases/download/v0.2.48/Ardia-0.2.48-linux-x64.tar.xz', 'sha256': DIGEST}

    def test_the_manifest_builds_from_the_release_tarball_on_the_chromium_base_app(self):
        manifest = formats.flatpak_manifest(self.SOURCE)
        self.assertEqual(manifest['id'], 'dev.ardia.Ardia')
        self.assertEqual(manifest['base'], 'org.chromium.Chromium.BaseApp')
        self.assertEqual(manifest['base-version'], manifest['runtime-version'])
        self.assertEqual(manifest['command'], 'ardia')
        zypak, ardia = manifest['modules']
        self.assertEqual(zypak['name'], 'zypak')
        self.assertRegex(zypak['sources'][0]['commit'], r'^[0-9a-f]{40}$')
        self.assertEqual(ardia['sources'][0], {'type': 'archive', **self.SOURCE})
        commands = '\n'.join(ardia['build-commands'])
        self.assertIn('ln -s ../lib/ardia/ardia-launch /app/bin/ardia', commands)
        self.assertIn('install -Dm644 cobalt.ini /app/etc/cobalt.ini', commands)
        self.assertIn('/app/share/applications/dev.ardia.Ardia.desktop', commands)
        for window_class, exported in (('ardia-little', 'little'), ('ardia-settings', 'settings'), ('ardia-import', 'import')):
            self.assertIn(f'share/applications/{window_class}.desktop > dev.ardia.Ardia.{exported}.desktop', commands)
            self.assertIn(f'/app/share/applications/dev.ardia.Ardia.{exported}.desktop', commands)
        self.assertIn('/app/share/icons/hicolor/256x256/apps/dev.ardia.Ardia.png', commands)
        self.assertEqual(manifest, json.loads(json.dumps(manifest)))
        for bad in ({'url': self.SOURCE['url']}, {'path': '/x', 'sha256': 'SKIP'}, {'url': 'u', 'path': 'p', 'sha256': DIGEST}):
            with self.assertRaisesRegex(ValueError, 'the Flatpak source'):
                formats.flatpak_manifest(bad)

    def test_the_finish_args_give_a_browser_what_it_needs_and_no_more_of_home_than_import_reads(self):
        args = formats.flatpak_manifest(self.SOURCE)['finish-args']
        for wanted in ('--share=network', '--share=ipc', '--socket=wayland', '--socket=fallback-x11', '--socket=pulseaudio', '--device=all',
                       '--filesystem=xdg-download', '--talk-name=org.freedesktop.Notifications', '--talk-name=org.freedesktop.secrets'):
            self.assertIn(wanted, args)
        for arg in args:
            if arg.startswith('--filesystem='):
                grant = arg.split('=', 1)[1]
                self.assertTrue(grant in ('xdg-download', 'xdg-run/pipewire-0') or grant.endswith(':ro'), grant)
                self.assertNotIn(grant.split(':')[0], ('home', 'host', '~', 'xdg-config'))

    def test_every_browser_import_reads_is_granted_read_only(self):
        source = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_import_readers.cc').read_text()
        table = source[source.index('kBrowsers[] = {'):source.index('};', source.index('kBrowsers[] = {'))]
        rows = re.findall(r'\{"\w+", "[^"]+", Family::k\w+, (true|false), "([^"]+)", (?:true|false), (true|false), (?:"([^"]+)"|nullptr)', table)
        self.assertGreater(len(rows), 20)
        folders = []
        for under_config, path, xdg_under_config, xdg_path in rows:
            folders.append(('xdg-config/' if under_config == 'true' else '~/') + path)
            if xdg_path:
                folders.append(('xdg-config/' if xdg_under_config == 'true' else '~/') + xdg_path)
        grants = [arg.split('=', 1)[1].removesuffix(':ro') for arg in formats.flatpak_manifest(self.SOURCE)['finish-args'] if arg.endswith(':ro')]
        for folder in folders:
            self.assertTrue(any(folder == grant or folder.startswith(grant + '/') for grant in grants), f'import reads {folder}, which the Flatpak cannot see')

    def test_cobalt_starts_ardias_chrome_through_zypak(self):
        ini = formats.COBALT_INI
        self.assertIn('EntryPoint=/app/lib/ardia/chrome\n', ini)
        self.assertIn('WrapperScript=/app/bin/ardia\n', ini)
        self.assertIn('[Zypak]\nEnabled=true\nSandboxFilename=chrome-sandbox\n', ini)

    def test_metainfo_names_the_app_its_desktop_entry_and_the_release(self):
        date = datetime.datetime(2026, 11, 23, tzinfo=datetime.timezone.utc)
        for version, kind in (('0.2.48', 'stable'), ('0.2.48-nightly.2', 'development')):
            component = ElementTree.fromstring(formats.flatpak_metainfo(version, date))
            self.assertEqual(component.findtext('id'), 'dev.ardia.Ardia')
            self.assertEqual(component.find('launchable').text, 'dev.ardia.Ardia.desktop')
            self.assertEqual(component.findtext('project_license'), 'GPL-3.0-only')
            release = component.find('releases/release')
            self.assertEqual((release.get('version'), release.get('date'), release.get('type')), (version, '2026-11-23', kind))

    def test_the_flathub_manifest_points_at_the_published_tarball(self):
        with tempfile.TemporaryDirectory() as scratch:
            result = run(sys.executable, LINUX / 'linux_formats.py', 'flathub', '--version', '0.2.48-nightly.1', '--sha256', DIGEST, '--out', scratch)
            self.assertEqual(result.returncode, 0, result.stderr)
            folder = pathlib.Path(scratch)
            manifest = json.loads((folder / 'dev.ardia.Ardia.json').read_text())
            self.assertEqual(sorted(path.name for path in folder.iterdir()), ['cobalt.ini', 'dev.ardia.Ardia.json', 'dev.ardia.Ardia.metainfo.xml'])
        self.assertEqual(manifest['modules'][1]['sources'][0], {
            'type': 'archive', 'sha256': DIGEST,
            'url': 'https://github.com/ardia-browser/ardia/releases/download/v0.2.48-nightly.1/Ardia-0.2.48-nightly.1-linux-x64.tar.xz'})
        self.assertNotEqual(run(sys.executable, LINUX / 'linux_formats.py', 'flathub', '--version', '0.2', '--sha256', DIGEST, '--out', '/tmp/x').returncode, 0)


if __name__ == '__main__':
    unittest.main()
