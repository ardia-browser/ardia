import datetime
import email.utils
import gzip
import hashlib
import os
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
APPIMAGE_TOOLS = {
    'url': 'https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.3/appimage-tools-runtime-20251108.tar.gz',
    'sha256': '84021a78ee214ae6fd33a2d62a92ba25542dd10bc86bf117a9b2d0bba44e7665',
    'folder': 'appimage-tools-runtime-20251108',
}
APPIMAGE_MAGIC = b'AI\x02'
DEB_MAINTAINER = 'Ardia <hello@ardia.dev>'
DEB_SOURCE = 'https://github.com/ardia-browser/ardia'
DEB_RELEASE_NOTES = 'https://ardia.dev/release-notes'
DEB_VERSION = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$')
GLIBC_SONAMES = {'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'ld-linux-x86-64.so.2'}
OPTIONAL_LIBRARIES = {'libqt5_shim.so', 'libqt6_shim.so'}
SONAME_PACKAGES = {
    'libgcc_s.so.1': 'libgcc-s1',
    'libstdc++.so.6': 'libstdc++6',
    'libasound.so.2': 'libasound2t64 | libasound2',
    'libatk-1.0.so.0': 'libatk1.0-0t64 | libatk1.0-0',
    'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0t64 | libatk-bridge2.0-0',
    'libatspi.so.0': 'libatspi2.0-0t64 | libatspi2.0-0',
    'libcairo.so.2': 'libcairo2',
    'libcups.so.2': 'libcups2t64 | libcups2',
    'libdbus-1.so.3': 'libdbus-1-3',
    'libdrm.so.2': 'libdrm2',
    'libexpat.so.1': 'libexpat1',
    'libgbm.so.1': 'libgbm1',
    'libgio-2.0.so.0': 'libglib2.0-0t64 | libglib2.0-0',
    'libglib-2.0.so.0': 'libglib2.0-0t64 | libglib2.0-0',
    'libgobject-2.0.so.0': 'libglib2.0-0t64 | libglib2.0-0',
    'libnspr4.so': 'libnspr4',
    'libnss3.so': 'libnss3',
    'libnssutil3.so': 'libnss3',
    'libsmime3.so': 'libnss3',
    'libpango-1.0.so.0': 'libpango-1.0-0',
    'libudev.so.1': 'libudev1',
    'libX11.so.6': 'libx11-6',
    'libxcb.so.1': 'libxcb1',
    'libXcomposite.so.1': 'libxcomposite1',
    'libXdamage.so.1': 'libxdamage1',
    'libXext.so.6': 'libxext6',
    'libXfixes.so.3': 'libxfixes3',
    'libxkbcommon.so.0': 'libxkbcommon0',
    'libXrandr.so.2': 'libxrandr2',
}
DEB_LOADED_AT_RUNTIME = ('libgtk-3-0t64 | libgtk-3-0', 'libsecret-1-0', 'fonts-liberation', 'xdg-utils')
DEB_CLI_INSTALLER = ('curl',)
DEB_RECOMMENDS = ('polkitd | policykit-1', 'libvulkan1')
BROWSER_ALTERNATIVES = ('x-www-browser', 'gnome-www-browser')


def deb_version(version):
    if not isinstance(version, str) or not DEB_VERSION.fullmatch(version):
        raise ValueError(f'bad version {version!r}: the .deb needs <major>.<minor>.<patch> or <major>.<minor>.<patch>-<channel>.<n>')
    return version.replace('-', '~')


def desktop_entry(source, command):
    return source.read_text().replace('Exec=ardia ', f'Exec={command} ')


def is_elf(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open('rb') as handle:
        return handle.read(4) == b'\x7fELF'


def readelf(*args):
    if shutil.which('readelf') is None:
        raise ValueError('readelf is required to build the .deb (apt install binutils)')
    result = subprocess.run(['readelf', *args], capture_output=True, text=True, env={**os.environ, 'LC_ALL': 'C', 'LANGUAGE': ''})
    if result.returncode != 0:
        raise ValueError(f'readelf {" ".join(args)} failed: {result.stderr.strip()}')
    return result.stdout


def needed_libraries(path):
    return re.findall(r'\(NEEDED\)\s+Shared library: \[([^\]]+)\]', readelf('-d', '--wide', str(path)))


def glibc_versions(path):
    return set(re.findall(r'\bGLIBC_([0-9]+(?:\.[0-9]+)+)\b', readelf('-V', '--wide', str(path))))


def numeric_version(version):
    return tuple(int(part) for part in version.split('.'))


def deb_depends(runtime):
    bundled = {path.name for path in runtime.rglob('*') if path.is_file() or path.is_symlink()}
    sonames = set()
    glibc = {'2.17'}
    for path in sorted(runtime.rglob('*')):
        if path.name in OPTIONAL_LIBRARIES or not is_elf(path):
            continue
        needed = needed_libraries(path)
        if path.name == 'chrome' and not needed:
            raise ValueError(f'readelf found no libraries that {path} needs')
        sonames.update(needed)
        glibc |= glibc_versions(path)
    system = sorted(sonames - bundled - GLIBC_SONAMES)
    unknown = [name for name in system if name not in SONAME_PACKAGES]
    if unknown:
        raise ValueError('no Debian package known for ' + ', '.join(unknown) + ': add it to SONAME_PACKAGES in scripts/linux/linux_formats.py')
    packages = [f'libc6 (>= {max(glibc, key=numeric_version)})']
    for package in [SONAME_PACKAGES[name] for name in system] + list(DEB_LOADED_AT_RUNTIME + DEB_CLI_INSTALLER):
        if package not in packages:
            packages.append(package)
    return packages


def deb_docs(usr, version, date):
    docs = usr / 'share/doc/ardia'
    docs.mkdir(parents=True)
    (docs / 'copyright').write_text(f'''Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Ardia
Source: {DEB_SOURCE}

Files: *
Copyright: 2026 Mantra Patel
License: GPL-3
 Ardia as distributed, with its Chromium engine built with Helium's patches, is
 licensed under the GNU General Public License, version 3. Ardia's own source
 files are also available under the Apache License, Version 2.0, and the
 engine includes Chromium (BSD-3-Clause and others, see chrome://credits),
 Helium (GPL-3.0) and uBlock Origin (GPL-3.0). Corresponding Source: the
 repository at the v{version} tag of {DEB_SOURCE}.
 .
 On Debian systems, the full text of the GNU General Public License version 3
 can be found in /usr/share/common-licenses/GPL-3.
''')
    changelog = f'''ardia ({deb_version(version)}) stable; urgency=medium

  * Ardia {version}: {DEB_RELEASE_NOTES}#{version}

 -- {DEB_MAINTAINER}  {email.utils.format_datetime(date)}
'''
    with (docs / 'changelog.gz').open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=int(date.timestamp())) as packed:
            packed.write(changelog.encode())


def deb_md5sums(tree):
    lines = []
    for path in sorted(tree.rglob('*')):
        relative = path.relative_to(tree)
        if relative.parts[0] == 'DEBIAN' or path.is_symlink() or not path.is_file():
            continue
        with path.open('rb') as handle:
            digest = hashlib.file_digest(handle, lambda: hashlib.md5(usedforsecurity=False)).hexdigest()
        lines.append(f'{digest}  {relative.as_posix()}\n')
    return ''.join(lines)


def build_deb(root, destination, version):
    if shutil.which('dpkg-deb') is None:
        raise ValueError('dpkg-deb is required to build the .deb')
    control_version = deb_version(version)
    epoch = os.environ.get('SOURCE_DATE_EPOCH')
    date = datetime.datetime.fromtimestamp(int(epoch) if epoch else int(time.time()), datetime.timezone.utc)
    with tempfile.TemporaryDirectory(prefix='ardia-deb-') as scratch:
        tree = pathlib.Path(scratch) / 'tree'
        usr = tree / 'usr'
        (usr / 'lib').mkdir(parents=True)
        shutil.copytree(root / 'lib/ardia', usr / 'lib/ardia', symlinks=True)
        (usr / 'bin').mkdir()
        (usr / 'bin/ardia').symlink_to('../lib/ardia/ardia-launch')
        shutil.copytree(root / 'share', usr / 'share', symlinks=True, ignore=shutil.ignore_patterns('apparmor.d'))
        (usr / 'share/applications/ardia.desktop').write_text(desktop_entry(root / 'share/applications/ardia.desktop', '/usr/bin/ardia'))
        profile = usr / 'share/ardia/apparmor/ardia'
        profile.parent.mkdir(parents=True)
        shutil.copyfile(root / 'share/apparmor.d/ardia', profile)
        deb_docs(usr, version, date)
        for path in [tree, *tree.rglob('*')]:
            if path.is_symlink():
                continue
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        helper = usr / 'lib/ardia/chrome-sandbox'
        if helper.is_file():
            helper.chmod(0o4755)
        control = tree / 'DEBIAN'
        control.mkdir()
        size = sum(path.stat().st_size for path in usr.rglob('*') if path.is_file() and not path.is_symlink()) // 1024
        (control / 'control').write_text('\n'.join([
            'Package: ardia',
            f'Version: {control_version}',
            'Architecture: amd64',
            f'Maintainer: {DEB_MAINTAINER}',
            f'Installed-Size: {size}',
            f'Depends: {", ".join(deb_depends(usr / "lib/ardia"))}',
            f'Recommends: {", ".join(DEB_RECOMMENDS)}',
            'Provides: www-browser',
            'Section: web',
            'Priority: optional',
            'Homepage: https://ardia.dev',
            'Description: The Ardia web browser',
            ' Dia\'s polish and Arc\'s sidebar on Chromium with Helium\'s patches.',
            '',
        ]))
        (control / 'md5sums').write_text(deb_md5sums(tree))
        for name in ('control', 'md5sums'):
            (control / name).chmod(0o644)
        for script in ('postinst', 'prerm', 'postrm'):
            shutil.copyfile(HERE / 'deb' / script, control / script)
            (control / script).chmod(0o755)
        subprocess.run(['dpkg-deb', '--root-owner-group', '-Zxz', '--build', str(tree), str(destination)], check=True, stdout=subprocess.DEVNULL)
    return destination


def appimage_tools(cache=None):
    cache = pathlib.Path(cache or os.environ.get('ARDIA_APPIMAGE_TOOLS') or pathlib.Path.home() / '.cache/ardia-appimage')
    folder = cache / APPIMAGE_TOOLS['folder']
    tools = {'runtime': folder / 'runtimes/runtime-x64', 'mksquashfs': folder / 'mksquashfs'}
    if all(path.is_file() for path in tools.values()):
        return tools
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='appimage-tools-', dir=cache) as scratch:
        archive = pathlib.Path(scratch) / 'tools.tar.gz'
        with urllib.request.urlopen(APPIMAGE_TOOLS['url'], timeout=120) as response, archive.open('wb') as handle:
            shutil.copyfileobj(response, handle)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != APPIMAGE_TOOLS['sha256']:
            raise ValueError(f'the AppImage toolset has sha256 {digest}, not {APPIMAGE_TOOLS["sha256"]}')
        unpacked = pathlib.Path(scratch) / 'unpacked'
        unpacked.mkdir()
        with tarfile.open(archive, 'r:gz') as packed:
            packed.extractall(unpacked, filter='data')
        source = unpacked / APPIMAGE_TOOLS['folder'] if (unpacked / APPIMAGE_TOOLS['folder']).is_dir() else unpacked
        shutil.rmtree(folder, ignore_errors=True)
        shutil.move(str(source), str(folder))
    for path in tools.values():
        if not path.is_file():
            raise ValueError(f'the AppImage toolset has no {path.relative_to(folder)}')
        path.chmod(0o755)
    return tools


def build_appimage(root, destination, tools=None):
    tools = tools or appimage_tools()
    with tempfile.TemporaryDirectory(prefix='ardia-appimage-') as scratch:
        app = pathlib.Path(scratch) / 'AppDir'
        shutil.copytree(root, app, symlinks=True, ignore=shutil.ignore_patterns('install.sh', 'apparmor.d', 'polkit-1'))
        (app / 'lib/ardia/chrome-sandbox').unlink(missing_ok=True)
        (app / 'AppRun').symlink_to('lib/ardia/ardia-launch')
        (app / 'ardia.desktop').write_text(desktop_entry(root / 'share/applications/ardia.desktop', 'AppRun'))
        icon = root / 'share/icons/hicolor/256x256/apps/ardia.png'
        if icon.is_file():
            shutil.copyfile(icon, app / 'ardia.png')
            shutil.copyfile(icon, app / '.DirIcon')
        runtime = pathlib.Path(tools['runtime']).read_bytes()
        subprocess.run([str(tools['mksquashfs']), str(app), str(destination), '-offset', str(len(runtime)), '-all-root', '-noappend',
                        '-no-progress', '-quiet', '-no-xattrs', '-no-fragments', '-comp', 'zstd', '-Xcompression-level', '19', '-b', '1048576'],
                       check=True, stdout=subprocess.DEVNULL)
        with open(destination, 'r+b') as handle:
            handle.write(runtime)
        pathlib.Path(destination).chmod(0o755)
    if pathlib.Path(destination).read_bytes()[8:11] != APPIMAGE_MAGIC:
        raise ValueError(f'{destination} lacks the type 2 AppImage magic')
    return destination
