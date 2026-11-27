import argparse
import datetime
import email.utils
import gzip
import hashlib
import json
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
DEB_UPDATER = ('openssl',)
DEB_RECOMMENDS = ('polkitd | policykit-1', 'pkexec | policykit-1', 'libvulkan1')
BROWSER_ALTERNATIVES = ('x-www-browser', 'gnome-www-browser')
RPM_REQUIRES = ('libgtk-3.so.0()(64bit)', 'libsecret-1.so.0()(64bit)', 'liberation-fonts', 'xdg-utils', '(curl or curl-minimal)', 'openssl', 'ca-certificates')
RPM_RECOMMENDS = ('polkit', '/usr/bin/pkexec')
RPM_SHARED_FOLDERS = ('/usr/share/polkit-1', '/usr/share/polkit-1/actions', '/usr/share/icons/hicolor', '/usr/share/icons/hicolor/256x256',
                      '/usr/share/icons/hicolor/256x256/apps', '/usr/share/licenses')
RPM_PAYLOAD = 'w19T.zstdio'
FLATPAK_ID = 'dev.ardia.Ardia'
FLATPAK_BRANCH = '26.08'
FLATHUB = 'https://dl.flathub.org/repo/flathub.flatpakrepo'
ZYPAK = {'type': 'git', 'url': 'https://github.com/refi64/zypak', 'tag': 'v2025.09', 'commit': '693a71c5ffa80ec9c9ce2ae03b1ccc493c698e53'}
COBALT_INI = '''[Application]
Name=ardia
EntryPoint=/app/lib/ardia/chrome
WrapperScript=/app/bin/ardia
ConfigDir=ardia
ExposePids=optional

[Zypak]
Enabled=true
SandboxFilename=chrome-sandbox
'''
FLATPAK_FINISH_ARGS = (
    '--share=ipc',
    '--share=network',
    '--socket=wayland',
    '--socket=fallback-x11',
    '--socket=pulseaudio',
    '--socket=cups',
    '--socket=pcsc',
    '--device=all',
    '--filesystem=xdg-download',
    '--filesystem=xdg-run/pipewire-0',
    '--persist=.pki',
    '--talk-name=org.freedesktop.Notifications',
    '--talk-name=org.freedesktop.secrets',
    '--talk-name=org.kde.kwalletd5',
    '--talk-name=org.kde.kwalletd6',
    '--talk-name=org.freedesktop.FileManager1',
    '--talk-name=org.freedesktop.ScreenSaver',
    '--system-talk-name=org.freedesktop.UPower',
    '--own-name=org.mpris.MediaPlayer2.chromium.*',
)
FLATPAK_IMPORT_FOLDERS = (
    'xdg-config/google-chrome', 'xdg-config/google-chrome-beta', 'xdg-config/google-chrome-unstable', 'xdg-config/chromium',
    'xdg-config/BraveSoftware', 'xdg-config/microsoft-edge', 'xdg-config/microsoft-edge-beta', 'xdg-config/microsoft-edge-dev',
    'xdg-config/vivaldi', 'xdg-config/vivaldi-snapshot', 'xdg-config/opera', 'xdg-config/net.imput.helium',
    'xdg-config/mozilla/firefox', 'xdg-config/zen', '~/.mozilla/firefox', '~/.librewolf', '~/.zen',
    '~/.var/app/com.google.Chrome/config/google-chrome', '~/.var/app/org.chromium.Chromium/config/chromium',
    '~/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser', '~/.var/app/org.mozilla.firefox/.mozilla/firefox',
    '~/.var/app/org.mozilla.firefox/config/mozilla/firefox', '~/.var/app/app.zen_browser.zen/.zen',
    '~/.var/app/app.zen_browser.zen/config/zen', '~/snap/chromium/common/chromium', '~/snap/firefox/common/.mozilla/firefox',
)


def deb_version(version):
    if not isinstance(version, str) or not DEB_VERSION.fullmatch(version):
        raise ValueError(f'bad version {version!r}: the .deb needs <major>.<minor>.<patch> or <major>.<minor>.<patch>-<channel>.<n>')
    return version.replace('-', '~')


MAIN_DESKTOP_ENTRY = ('[Desktop Entry]\nType=Application\nName=Ardia\nExec=ardia %U\nIcon=ardia\nTerminal=false\n'
                      'Categories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n'
                      'StartupWMClass=ardia\n')
WINDOW_CLASSES = {'ardia-little': 'Little Ardia', 'ardia-settings': 'Ardia Settings', 'ardia-import': 'Ardia Import'}


def window_desktop_entry(window_class, name):
    return (f'[Desktop Entry]\nType=Application\nName={name}\nExec=ardia %U\nIcon=ardia\nTerminal=false\nNoDisplay=true\n'
            f'StartupWMClass={window_class}\n')


def desktop_entries():
    return {'ardia.desktop': MAIN_DESKTOP_ENTRY,
            **{f'{window_class}.desktop': window_desktop_entry(window_class, name) for window_class, name in WINDOW_CLASSES.items()}}


def flatpak_desktop_id(window_class):
    return f'{FLATPAK_ID}.{window_class.removeprefix("ardia-")}.desktop'


def desktop_entry(source, command):
    return source.read_text().replace('Exec=ardia ', f'Exec={command} ')


def point_desktop_entries(applications, command):
    for name in desktop_entries():
        entry = applications / name
        if entry.is_file():
            entry.write_text(desktop_entry(entry, command))


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
    for package in [SONAME_PACKAGES[name] for name in system] + list(DEB_LOADED_AT_RUNTIME + DEB_CLI_INSTALLER + DEB_UPDATER):
        if package not in packages:
            packages.append(package)
    return packages


def license_text(version):
    return f'''Ardia as distributed, with its Chromium engine built with Helium's patches, is
licensed under the GNU General Public License, version 3. Ardia's own source
files are also available under the Apache License, Version 2.0, and the
engine includes Chromium (BSD-3-Clause and others, see chrome://credits),
Helium (GPL-3.0) and uBlock Origin (GPL-3.0). Corresponding Source: the
repository at the v{version} tag of {DEB_SOURCE}.
'''


def deb_docs(usr, version, date):
    docs = usr / 'share/doc/ardia'
    docs.mkdir(parents=True)
    body = ''.join(f' {line}\n' if line else ' .\n' for line in license_text(version).splitlines())
    (docs / 'copyright').write_text(f'''Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Ardia
Source: {DEB_SOURCE}

Files: *
Copyright: 2026 Mantra Patel
License: GPL-3
{body} .
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


def stage_usr(root, tree):
    usr = tree / 'usr'
    (usr / 'lib').mkdir(parents=True)
    shutil.copytree(root / 'lib/ardia', usr / 'lib/ardia', symlinks=True)
    (usr / 'bin').mkdir()
    (usr / 'bin/ardia').symlink_to('../lib/ardia/ardia-launch')
    shutil.copytree(root / 'share', usr / 'share', symlinks=True, ignore=shutil.ignore_patterns('apparmor.d'))
    point_desktop_entries(usr / 'share/applications', '/usr/bin/ardia')
    profile = usr / 'share/ardia/apparmor/ardia'
    profile.parent.mkdir(parents=True)
    shutil.copyfile(root / 'share/apparmor.d/ardia', profile)
    return usr


def normalize_usr(tree):
    for path in [tree, *tree.rglob('*')]:
        if path.is_symlink():
            continue
        path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
    helper = tree / 'usr/lib/ardia/chrome-sandbox'
    if helper.is_file():
        helper.chmod(0o4755)


def build_date():
    epoch = os.environ.get('SOURCE_DATE_EPOCH')
    return datetime.datetime.fromtimestamp(int(epoch) if epoch else int(time.time()), datetime.timezone.utc)


def build_deb(root, destination, version):
    if shutil.which('dpkg-deb') is None:
        raise ValueError('dpkg-deb is required to build the .deb')
    control_version = deb_version(version)
    date = build_date()
    with tempfile.TemporaryDirectory(prefix='ardia-deb-') as scratch:
        tree = pathlib.Path(scratch) / 'tree'
        usr = stage_usr(root, tree)
        deb_docs(usr, version, date)
        normalize_usr(tree)
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


def rpm_version(version):
    if not isinstance(version, str) or not DEB_VERSION.fullmatch(version):
        raise ValueError(f'bad version {version!r}: the .rpm needs <major>.<minor>.<patch> or <major>.<minor>.<patch>-<channel>.<n>')
    return version.replace('-', '~')


def without_update_action(policy):
    kept = re.sub(r'\n[ \t]*<action id="dev\.ardia\.linux\.update">.*?</action>', '', policy, flags=re.S)
    if kept == policy or 'dev.ardia.linux.update' in kept:
        raise ValueError('the polkit policy has no dev.ardia.linux.update action to leave out')
    return kept


def bundled_sonames(runtime):
    return sorted({path.name for path in runtime.rglob('*') if (path.is_file() or path.is_symlink()) and re.search(r'\.so(\.[0-9]+)*$', path.name)})


def rpm_requires_exclude(sonames):
    return '^(' + '|'.join(re.escape(name).replace('\\', '\\\\') for name in sonames) + ')\\\\('


def rpm_scriptlet(name):
    lines = (HERE / 'rpm' / name).read_text().splitlines()
    if lines and lines[0].startswith('#!'):
        lines = lines[1:]
    return '\n'.join(lines).strip() + '\n'


def rpm_spec(version, sonames, tree, date):
    optional = '|'.join(re.escape(name).replace('\\', '\\\\') for name in sorted(OPTIONAL_LIBRARIES))
    stamp = date.strftime('%a %b %d %Y')
    owned = '\n'.join(f'%dir {folder}' for folder in RPM_SHARED_FOLDERS)
    return f'''%global __requires_exclude {rpm_requires_exclude(sonames)}
%global __requires_exclude_from ^/usr/lib/ardia/({optional})$
%global __provides_exclude_from ^/usr/lib/ardia/.*$
%global _build_id_links none
%global debug_package %{{nil}}
%global __os_install_post %{{nil}}
%global __brp_mangle_shebangs %{{nil}}

Name: ardia
Version: {rpm_version(version)}
Release: 1
Summary: The Ardia web browser
License: GPL-3.0-only
URL: https://ardia.dev
Vendor: Ardia
Packager: {DEB_MAINTAINER}
BuildArch: x86_64
AutoReqProv: yes
{chr(10).join(f'Requires: {name}' for name in RPM_REQUIRES)}
{chr(10).join(f'Recommends: {name}' for name in RPM_RECOMMENDS)}
Provides: webclient

%description
Dia's polish and Arc's sidebar on Chromium with Helium's patches.

%install
cp -a '{tree}/.' %{{buildroot}}/

%post
{rpm_scriptlet('post')}
%postun
{rpm_scriptlet('postun')}
%files
%defattr(-,root,root,-)
{owned}
/usr/lib/ardia
/usr/bin/ardia
{chr(10).join(f'/usr/share/applications/{name}' for name in desktop_entries())}
/usr/share/icons/hicolor/256x256/apps/ardia.png
/usr/share/polkit-1/actions/dev.ardia.linux.policy
/usr/share/ardia
/usr/share/licenses/ardia

%changelog
* {stamp} {DEB_MAINTAINER} - {rpm_version(version)}-1
- Ardia {version}: {DEB_RELEASE_NOTES}#{version}
'''


def stage_rpm_tree(root, tree, version):
    usr = stage_usr(root, tree)
    policy = usr / 'share/polkit-1/actions/dev.ardia.linux.policy'
    policy.write_text(without_update_action(policy.read_text()))
    licenses = usr / 'share/licenses/ardia'
    licenses.mkdir(parents=True)
    (licenses / 'copyright').write_text(license_text(version))
    normalize_usr(tree)
    return usr


def rpmbuild(tree, destination, version, payload=RPM_PAYLOAD):
    if shutil.which('rpmbuild') is None:
        raise ValueError('rpmbuild is required to build the .rpm (apt install rpm, dnf install rpm-build)')
    usr = tree / 'usr'
    for required in ('lib/ardia/chrome', *(f'share/applications/{name}' for name in desktop_entries()), 'share/icons/hicolor/256x256/apps/ardia.png',
                     'share/polkit-1/actions/dev.ardia.linux.policy', 'share/licenses/ardia/copyright'):
        if not (usr / required).exists():
            raise ValueError(f'the .rpm tree has no usr/{required}')
    date = build_date()
    with tempfile.TemporaryDirectory(prefix='ardia-rpmbuild-') as scratch:
        top = pathlib.Path(scratch)
        spec = top / 'ardia.spec'
        spec.write_text(rpm_spec(version, bundled_sonames(usr / 'lib/ardia'), tree, date))
        environment = {**os.environ, 'LC_ALL': 'C', 'SOURCE_DATE_EPOCH': str(int(date.timestamp()))}
        result = subprocess.run(['rpmbuild', '-bb', '--quiet', '--target', 'x86_64', '--define', f'_topdir {top}', '--define', f'_rpmdir {top}/out',
                                 '--define', '_build_name_fmt ardia.rpm', '--define', f'_binary_payload {payload}',
                                 '--define', 'use_source_date_epoch_as_buildtime 1', '--define', 'clamp_mtime_to_source_date_epoch 1',
                                 '--define', '_buildhost ardia.dev', str(spec)], capture_output=True, text=True, env=environment)
        if result.returncode != 0:
            raise ValueError(f'rpmbuild failed: {(result.stderr or result.stdout).strip()[-2000:]}')
        shutil.move(str(top / 'out/ardia.rpm'), str(destination))
    return destination


def build_rpm(root, destination, version, payload=RPM_PAYLOAD):
    rpm_version(version)
    with tempfile.TemporaryDirectory(prefix='ardia-rpm-') as scratch:
        tree = pathlib.Path(scratch) / 'tree'
        stage_rpm_tree(root, tree, version)
        return rpmbuild(tree, destination, version, payload)


def flatpak_manifest(source):
    if set(source) not in ({'url', 'sha256'}, {'path', 'sha256'}) or not re.fullmatch(r'[0-9a-f]{64}', source['sha256']):
        raise ValueError(f'the Flatpak source is the release tarball, a url or path with its sha256, not {source!r}')
    return {
        'id': FLATPAK_ID,
        'runtime': 'org.freedesktop.Platform',
        'runtime-version': FLATPAK_BRANCH,
        'sdk': 'org.freedesktop.Sdk',
        'base': 'org.chromium.Chromium.BaseApp',
        'base-version': FLATPAK_BRANCH,
        'command': 'ardia',
        'separate-locales': False,
        'finish-args': [*FLATPAK_FINISH_ARGS, *(f'--filesystem={folder}:ro' for folder in FLATPAK_IMPORT_FOLDERS)],
        'modules': [{'name': 'zypak', 'sources': [dict(ZYPAK)]}, {
            'name': 'ardia',
            'buildsystem': 'simple',
            'build-options': {'no-debuginfo': True, 'strip': False},
            'build-commands': [
                'install -d /app/lib /app/bin',
                'cp -a lib/ardia /app/lib/ardia',
                'chmod 0755 /app/lib/ardia/chrome-sandbox',
                'ln -s ../lib/ardia/ardia-launch /app/bin/ardia',
                'install -Dm644 cobalt.ini /app/etc/cobalt.ini',
                f'sed -e "s/^Icon=ardia$/Icon={FLATPAK_ID}/" share/applications/ardia.desktop > {FLATPAK_ID}.desktop',
                f'install -Dm644 {FLATPAK_ID}.desktop /app/share/applications/{FLATPAK_ID}.desktop',
                *(command for window_class in WINDOW_CLASSES for command in (
                    f'sed -e "s/^Icon=ardia$/Icon={FLATPAK_ID}/" share/applications/{window_class}.desktop > {flatpak_desktop_id(window_class)}',
                    f'install -Dm644 {flatpak_desktop_id(window_class)} /app/share/applications/{flatpak_desktop_id(window_class)}',
                )),
                f'install -Dm644 share/icons/hicolor/256x256/apps/ardia.png /app/share/icons/hicolor/256x256/apps/{FLATPAK_ID}.png',
                f'install -Dm644 {FLATPAK_ID}.metainfo.xml /app/share/metainfo/{FLATPAK_ID}.metainfo.xml',
            ],
            'sources': [
                {'type': 'archive', **source},
                {'type': 'file', 'path': f'{FLATPAK_ID}.metainfo.xml'},
                {'type': 'file', 'path': 'cobalt.ini'},
            ],
        }],
    }


def flatpak_metainfo(version, date):
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>{FLATPAK_ID}</id>
  <name>Ardia</name>
  <summary>Dia's polish and Arc's sidebar on Chromium</summary>
  <developer id="dev.ardia">
    <name>Ardia</name>
  </developer>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>GPL-3.0-only</project_license>
  <description>
    <p>Ardia is a web browser with Dia's polish and Arc's sidebar, built on Chromium with Helium's patches. It needs no account.</p>
    <p>Tabs live in a sidebar with spaces, pinned tabs and folders, and import brings over bookmarks, history, passwords and open tabs from Chrome, Chromium, Brave, Edge, Vivaldi, Opera, Helium, Firefox, LibreWolf and Zen.</p>
  </description>
  <launchable type="desktop-id">{FLATPAK_ID}.desktop</launchable>
  <url type="homepage">https://ardia.dev</url>
  <url type="bugtracker">{DEB_SOURCE}/issues</url>
  <url type="vcs-browser">{DEB_SOURCE}</url>
  <categories>
    <category>Network</category>
    <category>WebBrowser</category>
  </categories>
  <provides>
    <binary>ardia</binary>
  </provides>
  <content_rating type="oars-1.1"/>
  <releases>
    <release version="{version}" date="{date.strftime('%Y-%m-%d')}" type="{'development' if '-' in version else 'stable'}">
      <url>{DEB_RELEASE_NOTES}#{version}</url>
    </release>
  </releases>
</component>
'''


def write_flatpak_manifest(folder, version, source):
    rpm_version(version)
    folder.mkdir(parents=True, exist_ok=True)
    manifest = folder / f'{FLATPAK_ID}.json'
    manifest.write_text(json.dumps(flatpak_manifest(source), indent=2) + '\n')
    (folder / f'{FLATPAK_ID}.metainfo.xml').write_text(flatpak_metainfo(version, build_date()))
    (folder / 'cobalt.ini').write_text(COBALT_INI)
    return manifest


def build_flatpak(tarball, destination, version, work=None):
    for tool in ('flatpak', 'flatpak-builder'):
        if shutil.which(tool) is None:
            raise ValueError(f'{tool} is required to build the Flatpak (apt install flatpak flatpak-builder)')
    tarball = pathlib.Path(tarball).resolve()
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    bus = [] if os.environ.get('DBUS_SESSION_BUS_ADDRESS') or shutil.which('dbus-run-session') is None else ['dbus-run-session', '--']
    with tempfile.TemporaryDirectory(prefix='ardia-flatpak-', dir=work) as scratch:
        folder = pathlib.Path(scratch)
        manifest = write_flatpak_manifest(folder / 'manifest', version, {'path': str(tarball), 'sha256': digest})
        subprocess.run(['flatpak', 'remote-add', '--user', '--if-not-exists', 'flathub', FLATHUB], check=True)
        subprocess.run([*bus, 'flatpak-builder', '--user', '--install-deps-from=flathub', '--disable-rofiles-fuse', '--force-clean', '--default-branch=stable',
                        f'--state-dir={folder}/state', f'--repo={folder}/repo', str(folder / 'build'), str(manifest)], check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['flatpak', 'build-bundle', f'--runtime-repo={FLATHUB}', str(folder / 'repo'), str(destination), FLATPAK_ID, 'stable'],
                       check=True, stdout=subprocess.DEVNULL)
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
        point_desktop_entries(app / 'share/applications', 'AppRun')
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


def from_tarball(tarball, version, rpm=None, flatpak=None):
    for path in (rpm, flatpak):
        if path is not None and path.exists():
            raise ValueError(f'refusing to overwrite {path}')
    if rpm is not None:
        with tempfile.TemporaryDirectory(prefix='ardia-tarball-') as scratch:
            with tarfile.open(tarball, 'r:xz') as packed:
                packed.extractall(scratch, filter='tar')
            build_rpm(pathlib.Path(scratch) / 'ardia', rpm, version)
            print(rpm)
    if flatpak is not None:
        build_flatpak(tarball, flatpak, version)
        print(flatpak)


def release_tarball_url(version):
    return f'{DEB_SOURCE}/releases/download/v{version}/Ardia-{version}-linux-x64.tar.xz'


def main():
    parser = argparse.ArgumentParser(description='Builds the .rpm and the Flatpak, and writes the Flathub manifest.')
    commands = parser.add_subparsers(dest='command', required=True)
    tarball = commands.add_parser('from-tarball', help='build the .rpm and the Flatpak from a release tarball, such as one already published')
    tarball.add_argument('--tarball', type=pathlib.Path, required=True)
    tarball.add_argument('--version', required=True)
    tarball.add_argument('--rpm', type=pathlib.Path)
    tarball.add_argument('--flatpak', type=pathlib.Path)
    rpm = commands.add_parser('rpm', help='build an .rpm from an installed tree (a folder holding usr/), as the .rpm install test does for its older build')
    rpm.add_argument('--tree', type=pathlib.Path, required=True)
    rpm.add_argument('--version', required=True)
    rpm.add_argument('--destination', type=pathlib.Path, required=True)
    rpm.add_argument('--fast', action='store_true', help='a quickly compressed payload, for tests')
    flathub = commands.add_parser('flathub', help='write dev.ardia.Ardia.json and its metainfo for a published release tarball')
    flathub.add_argument('--version', required=True)
    flathub.add_argument('--sha256', required=True)
    flathub.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'from-tarball':
            from_tarball(args.tarball.resolve(), args.version, args.rpm and args.rpm.resolve(), args.flatpak and args.flatpak.resolve())
        elif args.command == 'rpm':
            print(rpmbuild(args.tree.resolve(), args.destination.resolve(), args.version, 'w1T.zstdio' if args.fast else RPM_PAYLOAD))
        else:
            print(write_flatpak_manifest(args.out, args.version, {'url': release_tarball_url(args.version), 'sha256': args.sha256}))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
