#!/usr/bin/env python3
import argparse
import hashlib
import json
import lzma
import os
import pathlib
import posixpath
import re
import shutil
import stat
import sys
import tarfile

REQUIRED = ('chrome', 'chrome_crashpad_handler', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'locales', 'v8_context_snapshot.bin')
OPTIONAL = ('snapshot_blob.bin', 'libEGL.so', 'libGLESv2.so', 'libvk_swiftshader.so', 'vk_swiftshader_icd.json', 'libvulkan.so.1', 'libqt5_shim.so', 'libqt6_shim.so', 'chrome_sandbox', 'manifest.json')
NEVER_STRIPPED = ('chrome_sandbox',)
LOCALE_BUILD_FILES = ('*.info',)
ARCHIVE_ROOT = 'ardiacore-linux-x64'
SYMBOLS_ROOT = 'ardiacore-linux-x64-symbols'
MANIFEST_FORMAT = 2
TARGET_OS = 'linux'
TARGET_CPU = 'x64'
HEX40 = re.compile(r'^[0-9a-f]{40}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')


def archive_name(key):
    return f'ArdiaCore-{key[:12]}-linux-{TARGET_CPU}.tar.xz'


def symbols_name(key):
    return f'ArdiaCore-{key[:12]}-linux-{TARGET_CPU}-symbols.tar.xz'


def release_tag(key):
    return f'engine-{key[:12]}'


def row_built_key(fields, key):
    if len(fields) < 3 or fields[0] != key:
        return None
    return fields[3] if len(fields) > 3 and fields[3] else key


def built_key(table, key):
    lines = table.read_text().splitlines() if table.is_file() else []
    for fields in (line.split('\t') for line in lines):
        if fields[0] == key:
            return row_built_key(fields, key)
    return None


def valid_tag(tag, built):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', tag):
        return False
    return not tag.startswith('engine-') or tag == release_tag(built)


def fetched_built_key(directory, key):
    complete = directory / '.complete'
    if directory.name != key[:12] or not complete.is_file():
        return None
    lines = complete.read_text().split('\n')
    if len(lines) < 2 or not HEX64.match(lines[0]):
        return None
    fields = lines[1].split('\t')
    if len(fields) != 4 or fields[0] != key or fields[2] != lines[0] or not HEX40.match(fields[3]) or not valid_tag(fields[1], fields[3]):
        return None
    return fields[3]


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def serves(directory, key, table):
    path = directory / 'manifest.json'
    if not HEX40.match(key) or not path.is_file():
        return False
    try:
        manifest = json.loads(path.read_text())
    except (ValueError, OSError):
        return False
    if not isinstance(manifest, dict):
        return False
    expected = {'format': MANIFEST_FORMAT, 'target_os': TARGET_OS, 'target_cpu': TARGET_CPU}
    if any(manifest.get(name) != value for name, value in expected.items()):
        return False
    engine_key, chrome_sha256 = manifest.get('engine_key'), manifest.get('chrome_sha256')
    if not isinstance(engine_key, str) or not HEX40.match(engine_key) or not isinstance(chrome_sha256, str) or not HEX64.match(chrome_sha256):
        return False
    if runtime_problems(directory) or sha256_of(directory / 'chrome') != chrome_sha256:
        return False
    if engine_key == key:
        return True
    listed = built_key(table, key)
    if listed is not None:
        return listed == engine_key
    return fetched_built_key(directory, key) == engine_key


def runtime_problems(directory):
    problems = []
    for name in REQUIRED:
        path = directory / name
        if not (path.is_dir() if name == 'locales' else path.is_file()):
            problems.append(name)
    if not problems and not os.access(directory / 'chrome', os.X_OK):
        problems.append('chrome is not executable')
    return problems


def missing(directory):
    return [name for name in REQUIRED if not (directory / name).exists()]


def select(directory):
    absent = missing(directory)
    if absent:
        raise ValueError(f'missing Linux build outputs in {directory}: ' + ', '.join(absent))
    if not (directory / 'locales').is_dir():
        raise ValueError(f'{directory}/locales is not a directory')
    if not os.access(directory / 'chrome', os.X_OK):
        raise ValueError('chrome is not executable')
    return list(REQUIRED) + [name for name in OPTIONAL if (directory / name).exists()]


def copy(source, destination):
    names = select(source)
    destination.mkdir(parents=True, exist_ok=True)
    for name in names:
        path = source / name
        if path.is_dir():
            shutil.copytree(path, destination / name, ignore=shutil.ignore_patterns(*LOCALE_BUILD_FILES))
        else:
            shutil.copy2(path, destination / name)
    return names


def is_elf(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open('rb') as handle:
        return handle.read(4) == b'\x7fELF'


def strippable(directory):
    return [directory / name for name in REQUIRED + OPTIONAL if name not in NEVER_STRIPPED and is_elf(directory / name)]


def check_manifest(directory, key):
    path = directory / 'manifest.json'
    if not path.is_file():
        raise ValueError('the engine archive holds no manifest.json')
    manifest = json.loads(path.read_text())
    expected = {'format': MANIFEST_FORMAT, 'engine_key': key, 'target_os': TARGET_OS, 'target_cpu': TARGET_CPU}
    wrong = [f'{key} is {manifest.get(key)!r}, not {value!r}' for key, value in expected.items() if manifest.get(key) != value]
    if wrong:
        raise ValueError('the engine manifest does not match: ' + '; '.join(wrong))
    return manifest


def check_member(member, root):
    name = member.name
    parts = name.split('/')
    if name.startswith('/') or '\\' in name or '..' in parts or (parts[0] != root) or '' in parts[1:-1]:
        raise ValueError(f'unsafe archive entry {name!r}')
    if member.isdir() or member.isreg():
        return
    if member.issym() or member.islnk():
        target = member.linkname
        if target.startswith('/'):
            raise ValueError(f'archive link {name!r} points outside the engine')
        anchor = posixpath.dirname(name) if member.issym() else ''
        resolved = posixpath.normpath(posixpath.join(anchor, target))
        if resolved != root and not resolved.startswith(root + '/'):
            raise ValueError(f'archive link {name!r} points outside the engine')
        return
    raise ValueError(f'archive entry {name!r} is not a file, directory or link')


def unpack(archive, into, key):
    into.mkdir(parents=True, exist_ok=False)
    extract_filter = getattr(tarfile, 'data_filter', None)
    with tarfile.open(archive, 'r|xz') as packed:
        for member in packed:
            check_member(member, ARCHIVE_ROOT)
            if extract_filter is not None:
                packed.extract(member, into, filter='data')
            else:
                member.mode &= ~(stat.S_ISUID | stat.S_ISGID)
                packed.extract(member, into)
    engine = into / ARCHIVE_ROOT
    if not engine.is_dir():
        raise ValueError(f'the engine archive holds no {ARCHIVE_ROOT}/ directory')
    check_manifest(engine, key)
    select(engine)
    return engine


def main():
    parser = argparse.ArgumentParser(description='Selects, copies and checks the Chromium runtime files Ardia ships on Linux.')
    commands = parser.add_subparsers(dest='command', required=True)
    listing = commands.add_parser('list', help='print the runtime files present in a Chromium out dir or engine dir')
    listing.add_argument('directory', type=pathlib.Path)
    copying = commands.add_parser('copy', help='copy the runtime files of a Chromium out dir or engine dir')
    copying.add_argument('source', type=pathlib.Path)
    copying.add_argument('destination', type=pathlib.Path)
    unpacking = commands.add_parser('unpack', help='safely unpack and check an engine archive')
    unpacking.add_argument('--archive', type=pathlib.Path, required=True)
    unpacking.add_argument('--into', type=pathlib.Path, required=True)
    unpacking.add_argument('--key', required=True)
    serving = commands.add_parser('serves', help='exit 0 when an engine dir is the published engine of an engine key: its manifest names the key, or the key\'s table row names the manifest\'s key as the one it was built under')
    serving.add_argument('--engine', type=pathlib.Path, required=True)
    serving.add_argument('--key', required=True)
    serving.add_argument('--table', type=pathlib.Path, default=pathlib.Path(os.environ.get('ARDIACORE_PREBUILT_LINUX_TABLE') or pathlib.Path(__file__).resolve().parents[2] / 'packages/ardiacore/prebuilt-engines-linux.tsv'))
    args = parser.parse_args()
    try:
        if args.command == 'list':
            print('\n'.join(select(args.directory)))
        elif args.command == 'copy':
            copy(args.source, args.destination)
        elif args.command == 'serves':
            sys.exit(0 if serves(args.engine, args.key, args.table) else 1)
        else:
            print(unpack(args.archive, args.into, args.key))
    except (ValueError, OSError, tarfile.TarError, lzma.LZMAError, EOFError, json.JSONDecodeError) as error:
        print(f'runtime_files.py: {error}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
