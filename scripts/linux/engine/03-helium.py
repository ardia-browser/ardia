#!/usr/bin/env python3
"""Step 3 (Linux): turn a Chromium $CHROMIUM_VERSION tree into Helium's for Linux, as Ardia takes it.

The Mac step (engine/patches/build/03-helium.py) with helium-linux in place of helium-macos: helium-chromium $HELIUM_TAG
plus helium-linux $HELIUM_LINUX_TAG (scripts/linux/engine/helium-pins.ini pins both by commit; the checkouts are
$CB/helium and $CB/helium-linux). The stages, the omitted downloads, the guard and the Mac step's skips of
helium-chromium patches are the same. The helium-macos skips are replaced by LINUX_SKIP, the guard also watches
Linux's key storage, Helium's generated icons are made with Pillow instead of sips, and
scripts/linux/engine/ardia_resources_linux.txt puts Ardia's logos over the Linux product logos after the Mac step's
resources. The scratch-tree check allows the hard links inside Chromium's Debian sysroot (build/linux/debian_*-sysroot,
which nothing here writes) as long as every link of each file is inside it. --helium-macos takes the helium-linux
checkout.

Usage: scripts/linux/engine/03-helium.py --apply [--only STAGE,...] [--from STAGE] [--no-brand] (takes the Linux chromium lock itself)
"""
import configparser
import importlib.util
import os
import pathlib
import stat
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
MAC_DIR = REPO_ROOT / 'engine/patches/build'
CB = pathlib.Path(os.environ.get('AC_CHROMIUM_BUILD') or pathlib.Path.home() / 'chromium-build-linux')
os.environ['AC_CHROMIUM_BUILD'] = str(CB)
os.environ.setdefault('HELIUM_DIR', str(CB / 'helium'))
os.environ['HELIUM_MACOS_DIR'] = os.environ.get('HELIUM_LINUX_DIR', str(CB / 'helium-linux'))
LOCK = os.path.join(os.environ.get('AC_LOCK_ROOT', '/tmp'), 'ac-chromium-linux.lockf')

sys.path.insert(0, str(MAC_DIR))
spec = importlib.util.spec_from_file_location('helium_mac', MAC_DIR / '03-helium.py')
mac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mac)

LINUX_SKIP = {
    'helium/linux/change-chromium-branding.patch':
        'moves the profile to ~/.config/net.imput.helium(.dev), reads HELIUM_CONFIG_HOME and HELIUM_DESKTOP and names '
        'helium.desktop; Ardia\'s Linux layer names its own',
    'helium/linux/rename-chrome-binary.patch':
        'renames the binary to helium and the crash handler to helium_crashpad_handler; the engine stays chrome',
    'helium/linux/add-error-for-missing-desktop-file.patch':
        'a "cannot be set as default" state whose Settings string names helium.desktop; Ardia\'s Linux layer owns '
        'its .desktop file and its default-browser flow',
}

LINUX_GUARD_MARKERS = [('os_crypt', False), ('libsecret', True), ('kwallet', True), ('key_storage', False)]

LINUX_GUARD_ALLOWED = {
    ('helium/core/sync/service-backends.patch', 'os_crypt',
     '+#include "components/os_crypt/async/common/encryptor.h"'),
    ('helium/core/sync/service-backends.patch', 'os_crypt',
     '+    scoped_refptr<os_crypt_async::Encryptor> encryptor) {'),
    ('helium/core/sync/service-backends.patch', 'os_crypt', '+namespace os_crypt_async {'),
    ('helium/core/sync/service-backends.patch', 'os_crypt',
     '+      scoped_refptr<os_crypt_async::Encryptor> encryptor);'),
}


def linux_pins():
    config = configparser.ConfigParser(interpolation=None)
    config.read(HERE / 'helium-pins.ini')
    return config


def linux_helium_patches(ctx):
    for repo, tag in ((ctx.hc, 'helium-chromium'), (ctx.hm, 'helium-linux')):
        for name in mac.series(repo):
            yield tag, name, repo / 'patches' / name


def stage_pins_linux(ctx):
    config = linux_pins()
    problems = []
    for section, repo in (('helium-chromium', ctx.hc), ('helium-linux', ctx.hm)):
        want = config[section]['commit']
        head = mac.git(repo, 'rev-parse', 'HEAD').stdout.strip()
        if head != want:
            problems.append(f'{repo} is at {head or "no checkout"}, not {section} {config[section]["tag"]} ({want})')
        dirty = mac.git(repo, 'status', '--porcelain', '--untracked-files=no').stdout.strip()
        if dirty:
            problems.append(f'{repo} has local changes:\n{dirty}')
    submodule = mac.git(ctx.hm, 'ls-tree', 'HEAD', 'helium-chromium').stdout.split()
    if submodule[2:3] != [config['helium-chromium']['commit']]:
        problems.append(f'helium-linux {config["helium-linux"]["tag"]} is made for helium-chromium '
                        f'{submodule[2] if len(submodule) > 2 else "?"}, not {config["helium-chromium"]["commit"]}')
    chromium = config['chromium']['version']
    if os.environ.get('CHROMIUM_VERSION', chromium) != chromium:
        problems.append(f'env.sh CHROMIUM_VERSION {os.environ["CHROMIUM_VERSION"]} != '
                        f'scripts/linux/engine/helium-pins.ini {chromium}')
    mac_pins = mac_pins_reader()
    if mac_pins['helium-chromium']['commit'] != config['helium-chromium']['commit']:
        problems.append('scripts/linux/engine/helium-pins.ini and helium-pins.ini pin different helium-chromium commits')
    if mac_pins['chromium']['version'] != chromium:
        problems.append('scripts/linux/engine/helium-pins.ini and helium-pins.ini pin different Chromium versions')
    helium_chromium = (ctx.hc / 'chromium_version.txt').read_text().strip()
    if helium_chromium != chromium:
        problems.append(f'Helium {config["helium-chromium"]["tag"]} is made for Chromium {helium_chromium}')
    version_file = ctx.tree / 'chrome/VERSION'
    if version_file.exists():
        parts = dict(l.split('=', 1) for l in version_file.read_text().split() if '=' in l)
        tree_version = '.'.join(parts.get(k, '?') for k in ('MAJOR', 'MINOR', 'BUILD', 'PATCH'))
        if tree_version != chromium:
            problems.append(f'the tree is Chromium {tree_version}, not {chromium}')
    deps = configparser.ConfigParser(interpolation=None)
    deps.read(ctx.hc / 'deps.ini')
    for section in deps.sections():
        out = deps[section].get('output_path', '').lstrip('./').rstrip('/') + '/'
        if not out.startswith(mac.OMITTED):
            problems.append(f'deps.ini [{section}] downloads into {out}, which Ardia doesn\'t omit: decide on it')
    if problems:
        raise mac.StageError('\n'.join(problems))
    print(f'Helium {config["helium-chromium"]["tag"]} / Linux {config["helium-linux"]["tag"]} on Chromium {chromium}')


mac_pins_reader = mac.pins
mac_stage_resources = mac.stage_resources


def generate_icons_with_pillow(ctx):
    from PIL import Image
    out = ctx.work / 'helium-resources'
    for line in (ctx.hc / 'resources/generate_resources.txt').read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        source, size, dest = line.split()
        target = out / dest
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(ctx.hc / 'resources' / source) as image:
            image.convert('RGBA').resize((int(size), int(size)), Image.Resampling.LANCZOS).save(target, 'PNG')
    return out


def stage_resources_linux(ctx):
    mac_stage_resources(ctx)
    if ctx.no_brand:
        return
    roots = list(dict.fromkeys([mac.REPO, REPO_ROOT]))
    print(f'Ardia Linux: {mac.copy_resources(ctx, HERE / "ardia_resources_linux.txt", roots)} resources')


def install():
    mac.__doc__ = __doc__
    mac.SKIP = {k: v for k, v in mac.SKIP.items() if not k.startswith(('helium/macos/', 'rebel/macos/'))}
    mac.SKIP.update(LINUX_SKIP)
    mac.GUARD_MARKERS = mac.GUARD_MARKERS + LINUX_GUARD_MARKERS
    mac.GUARD_ALLOWED = {a for a in mac.GUARD_ALLOWED if not a[0].startswith('helium/macos/')} | LINUX_GUARD_ALLOWED
    mac.pins = linux_pins
    mac.helium_patches = linux_helium_patches
    mac.generate_icons = generate_icons_with_pillow
    mac.pathguard.aliases_under = linux_aliases_under
    mac.HANDLERS['pins'] = stage_pins_linux
    mac.HANDLERS['resources'] = stage_resources_linux


mac_aliases_under = mac.pathguard.aliases_under
SYSROOT_GLOB = 'build/linux/debian_*-sysroot'


def linux_aliases_under(root, rels=None):
    if rels is not None:
        return mac_aliases_under(root, rels)
    root_real = os.path.realpath(root)
    problems, linked = [], {}
    for top, dirs, files in os.walk(root_real):
        rel_top = os.path.relpath(top, root_real)
        parts = pathlib.PurePath(rel_top).parts[:3]
        sysroot = pathlib.Path(root_real, *parts) if len(parts) == 3 and pathlib.PurePath(*parts).match(SYSROOT_GLOB) \
            else None
        for name in dirs + files:
            path = os.path.join(top, name)
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                target = os.path.realpath(path)
                if not (target == root_real or target.startswith(root_real + os.sep)):
                    problems.append(f'{path} is a symlink out of {root_real} (to {target})')
                elif mac.pathguard.reaches(target):
                    problems.append(f'{path} reaches the real ~/chromium-build')
            elif stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
                if sysroot is None:
                    problems.append(f'{path} is hard-linked ({st.st_nlink} links)')
                else:
                    key = (sysroot, st.st_dev, st.st_ino)
                    found, _, first = linked.get(key, (0, st.st_nlink, path))
                    linked[key] = (found + 1, st.st_nlink, first)
        if len(problems) > 20:
            break
    problems += [f'{first} has {links - found} hard links outside {key[0]}'
                 for key, (found, links, first) in linked.items() if found < links]
    return problems


def lock_held():
    if os.environ.get('AC_LINUX_LOCK_HELD') != LOCK:
        return False
    return subprocess.run(['flock', '-n', LOCK, 'true']).returncode != 0


def main():
    install()
    argv = sys.argv[1:]
    if not any(a in ('-h', '--help') for a in argv):
        if '--apply' not in argv:
            sys.exit('03-helium.py: it changes $AC_CHROMIUM_BUILD: pass --apply to run it (--help for usage)')
        if not lock_held():
            os.makedirs(os.path.dirname(LOCK), exist_ok=True)
            os.environ['AC_LINUX_LOCK_HELD'] = LOCK
            os.execvp('flock', ['flock', '-w', os.environ.get('AC_LOCK_WAIT', '500'), '-E', '75', LOCK,
                                sys.executable, os.path.abspath(__file__), *argv])
    defaults = {'--work': CB / 'helium-work', '--report': CB / 'logs/helium-patches.tsv',
                '--domsub-cache': CB / 'domsubcache.tar.gz'}
    for flag, value in defaults.items():
        if not any(a == flag or a.startswith(flag + '=') for a in argv):
            argv += [flag, str(value)]
    (CB / 'logs').mkdir(parents=True, exist_ok=True)
    sys.argv = [sys.argv[0]] + argv
    return mac.main()


if __name__ == '__main__':
    sys.exit(main())
