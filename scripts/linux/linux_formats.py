import hashlib
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
APPIMAGE_TOOLS = {
    'url': 'https://github.com/electron-userland/electron-builder-binaries/releases/download/appimage@1.0.3/appimage-tools-runtime-20251108.tar.gz',
    'sha256': '84021a78ee214ae6fd33a2d62a92ba25542dd10bc86bf117a9b2d0bba44e7665',
    'folder': 'appimage-tools-runtime-20251108',
}
APPIMAGE_MAGIC = b'AI\x02'
DEB_DEPENDS = (
    'libasound2 | libasound2t64', 'libatk-bridge2.0-0 | libatk-bridge2.0-0t64', 'libatk1.0-0 | libatk1.0-0t64',
    'libatspi2.0-0 | libatspi2.0-0t64', 'libc6 (>= 2.25)', 'libcairo2', 'libcups2 | libcups2t64', 'libdbus-1-3', 'libdrm2',
    'libexpat1', 'libgbm1', 'libglib2.0-0 | libglib2.0-0t64', 'libgtk-3-0 | libgtk-3-0t64', 'libnspr4', 'libnss3',
    'libpango-1.0-0', 'libsecret-1-0', 'libudev1', 'libx11-6', 'libxcb1', 'libxcomposite1', 'libxdamage1', 'libxext6',
    'libxfixes3', 'libxkbcommon0', 'libxrandr2', 'xdg-utils',
)
DEB_RECOMMENDS = ('polkitd | policykit-1', 'libvulkan1')


def deb_version(version):
    return (version or '0.0.0').replace('-', '~')


def desktop_entry(source, command):
    return source.read_text().replace('Exec=ardia ', f'Exec={command} ')


def build_deb(root, destination, version):
    if shutil.which('dpkg-deb') is None:
        raise ValueError('dpkg-deb is required to build the .deb')
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
            f'Version: {deb_version(version)}',
            'Architecture: amd64',
            'Maintainer: Ardia <hello@ardia.dev>',
            f'Installed-Size: {size}',
            f'Depends: {", ".join(DEB_DEPENDS)}',
            f'Recommends: {", ".join(DEB_RECOMMENDS)}',
            'Section: web',
            'Priority: optional',
            'Homepage: https://ardia.dev',
            'Description: The Ardia web browser',
            ' Dia\'s polish and Arc\'s sidebar on Chromium with Helium\'s patches.',
            '',
        ]))
        (control / 'control').chmod(0o644)
        for script in ('postinst', 'postrm'):
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
