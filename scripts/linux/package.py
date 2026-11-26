#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import linux_formats
import runtime_files

REPO = pathlib.Path(__file__).resolve().parents[2]
BRIDGE = REPO / 'engine/ardiacore-linux/content-blocker'
BRIDGE_SCRIPTS = ('js/vapi.js', 'js/vapi-common.js', 'js/vapi-client.js')
CLI_INSTALLER = REPO / 'apps/cli/install.sh'
UBO_SEED = REPO / 'scripts/linux/ubo-seed.mjs'
UPDATE_HELPER = REPO / 'scripts/linux/ardia-update'
UPDATE_KEY = REPO / 'scripts/linux/linux-update.pem'
UPDATE_VERIFY_TARGET = 'x86_64-unknown-linux-musl'
ELF_IDENT_64_LE_V1 = b'\x7fELF\x02\x01\x01'
ELF_HEADER_BYTES = 64
ELF_PROGRAM_HEADER_BYTES = 56
ELF_EXECUTABLE_TYPES = (2, 3)
ELF_X86_64 = 0x3e
PT_LOAD = 1
PT_INTERP = 3
CLI_PLATFORM = 'linux-x64'
VERSION_PATTERN = re.compile(r'^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$')
REQUIRED = runtime_files.REQUIRED


def check_content_blocker(source):
    manifest_path = source / 'manifest.json'
    if not manifest_path.is_file():
        raise ValueError(f'no uBlock Origin manifest at {manifest_path}')
    manifest = json.loads(manifest_path.read_text())
    if not isinstance(manifest.get('key'), str) or manifest.get('manifest_version') != 2:
        raise ValueError('the content blocker is not the keyed uBlock Origin build from scripts/linux/fetch-ubo.sh')
    missing = [name for name in BRIDGE_SCRIPTS if not (source / name).is_file()]
    if missing:
        raise ValueError('the content blocker lacks ' + ', '.join(missing))


def check_version(version):
    if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
        raise ValueError(f'bad version {version!r}: expected <major>.<minor>.<patch> or <major>.<minor>.<patch>-<channel>.<n>')
    return version


def cli_tarball_name(version):
    return f'ardia-cli-{version}-{CLI_PLATFORM}.tar.gz'


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def check_cli(tarball, version, installer=CLI_INSTALLER):
    expected = cli_tarball_name(version)
    if tarball.name != expected:
        raise ValueError(f'the CLI tarball is {tarball.name}, not {expected} (the package version and {CLI_PLATFORM})')
    if not tarball.is_file():
        raise ValueError(f'no CLI tarball at {tarball}')
    if not installer.is_file():
        raise ValueError(f'no CLI installer at {installer}')
    digest = sha256_of(tarball)
    sidecar = tarball.with_name(tarball.name + '.sha256')
    if sidecar.exists():
        recorded = (sidecar.read_text().split() or [''])[0]
        if recorded != digest:
            raise ValueError(f'{tarball.name} has sha256 {digest}, but {sidecar.name} says {recorded!r}')
    top = f'ardia-cli-{version}'
    try:
        with tarfile.open(tarball, 'r:gz') as packed:
            names = packed.getnames()
    except (tarfile.TarError, OSError, EOFError) as error:
        raise ValueError(f'{tarball.name} is not a gzipped tarball: {error}') from None
    stray = [name for name in names if name.rstrip('/') != top and not name.startswith(top + '/')]
    if stray:
        raise ValueError(f'{tarball.name} has entries outside {top}/: ' + ', '.join(stray[:3]))
    if f'{top}/bin/ardia' not in names:
        raise ValueError(f'{tarball.name} has no {top}/bin/ardia')
    return digest


def add_cli(runtime, tarball, digest, installer=CLI_INSTALLER):
    cli = runtime / 'cli'
    cli.mkdir()
    cli.chmod(0o755)
    shutil.copyfile(tarball, cli / tarball.name)
    (cli / tarball.name).chmod(0o644)
    shutil.copyfile(installer, cli / 'ardia-cli-install.sh')
    (cli / 'ardia-cli-install.sh').chmod(0o755)
    (cli / 'ardia-cli.sha256').write_text(f'{digest}  {tarball.name}\n')
    (cli / 'ardia-cli.sha256').chmod(0o644)
    return digest


def static_x86_64_executable_problem(data):
    if len(data) < ELF_HEADER_BYTES or data[:7] != ELF_IDENT_64_LE_V1:
        return 'is not a 64-bit little-endian ELF'
    field = lambda offset, size: int.from_bytes(data[offset:offset + size], 'little')
    if field(16, 2) not in ELF_EXECUTABLE_TYPES:
        return 'is not an executable or position-independent executable ELF'
    if field(18, 2) != ELF_X86_64 or field(20, 4) != 1:
        return 'is not an x86-64 ELF'
    if field(24, 8) == 0:
        return 'has no entry point'
    offset, count = field(32, 8), field(56, 2)
    if field(52, 2) != ELF_HEADER_BYTES or field(54, 2) != ELF_PROGRAM_HEADER_BYTES or count == 0:
        return 'has no program headers of the 64-bit size'
    if offset < ELF_HEADER_BYTES or offset + count * ELF_PROGRAM_HEADER_BYTES > len(data):
        return 'has program headers past the end of the file'
    loads = 0
    for index in range(count):
        header = offset + index * ELF_PROGRAM_HEADER_BYTES
        kind, start, size = field(header, 4), field(header + 8, 8), field(header + 32, 8)
        if start + size > len(data):
            return 'has a segment past the end of the file'
        if kind == PT_INTERP:
            return f'is dynamically linked: build it for {UPDATE_VERIFY_TARGET}, so it runs wherever Ardia does'
        loads += kind == PT_LOAD
    if loads == 0:
        return 'has no loadable segment'
    return None


def runs_here():
    return sys.platform.startswith('linux') and platform.machine() in ('x86_64', 'amd64')


def check_update_verify(path):
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f'no executable ardia-update-verify at {path}')
    problem = static_x86_64_executable_problem(path.read_bytes())
    if problem:
        raise ValueError(f'{path} {problem}')
    if not runs_here():
        return
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
    for args, status, line in [(['version', '0.2.0'], 0, 'ok\n'), (['version', 'v0.2.0'], 1, 'failed version\n')]:
        try:
            result = subprocess.run([str(path), *args], capture_output=True, text=True, timeout=30, env=env)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ValueError(f'{path} does not run here: {error}') from error
        if (result.returncode, result.stdout) != (status, line):
            raise ValueError(f'{path} does not run here: version {args[1]} exited {result.returncode} with {result.stdout!r}')


def normalize_modes(root):
    for path in [root, *root.rglob('*')]:
        if path.is_symlink():
            continue
        path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)


def seed_content_blocker(runtime, blocker):
    subprocess.run(['node', str(UBO_SEED), '--chrome', str(runtime / 'chrome'), '--ui', str(runtime / 'ardia-ui'), '--blocker', str(blocker)],
                   check=True, stdout=subprocess.DEVNULL)


def package(output, ui, destination, content_blocker=None, version=None, cli=None, deb=None, appimage=None, ubo_seed=False, update_verify=None, rpm=None):
    if version is not None:
        check_version(version)
    if deb is not None:
        if version is None:
            raise ValueError('a package with a .deb needs --version')
        linux_formats.deb_version(version)
    if update_verify is not None and not update_verify.is_file():
        raise ValueError(f'no ardia-update-verify at {update_verify}')
    if rpm is not None:
        if version is None:
            raise ValueError('a package with an .rpm needs --version')
        linux_formats.rpm_version(version)
    cli_digest = None
    if cli is not None:
        if version is None:
            raise ValueError('a package with the CLI needs --version')
        cli_digest = check_cli(cli, version)
    missing = runtime_files.missing(output)
    if missing:
        raise ValueError('missing Linux build outputs: ' + ', '.join(missing))
    if not (ui / 'index.html').is_file():
        raise ValueError(f'no UI bundle at {ui}/index.html')
    if not os.access(output / 'chrome', os.X_OK):
        raise ValueError('chrome is not executable')
    for path in (destination, deb, appimage, rpm):
        if path is not None and path.exists():
            raise ValueError(f'refusing to overwrite {path}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ardia-package-') as scratch:
        root = pathlib.Path(scratch) / 'ardia'
        runtime = root / 'lib/ardia'
        runtime.mkdir(parents=True)
        runtime_files.copy(output, runtime)
        if (runtime / 'chrome_sandbox').is_file():
            (runtime / 'chrome_sandbox').rename(runtime / 'chrome-sandbox')
        shutil.copyfile(pathlib.Path(__file__).resolve().parent / 'ardia-launch', runtime / 'ardia-launch')
        (runtime / 'ardia-launch').chmod(0o755)
        shutil.copyfile(UPDATE_HELPER, runtime / 'ardia-update')
        (runtime / 'ardia-update').chmod(0o755)
        if update_verify is not None:
            shutil.copyfile(update_verify, runtime / 'ardia-update-verify')
            (runtime / 'ardia-update-verify').chmod(0o755)
        shutil.copyfile(UPDATE_KEY, runtime / 'linux-update.pem')
        (runtime / 'linux-update.pem').chmod(0o644)
        shutil.copytree(ui, runtime / 'ardia-ui')
        if version is not None:
            (runtime / 'VERSION').write_text(version + '\n')
            (runtime / 'VERSION').chmod(0o644)
        if cli is not None:
            add_cli(runtime, cli, cli_digest)
        if content_blocker is not None:
            check_content_blocker(content_blocker)
            blocker = runtime / 'extensions/ublock'
            shutil.copytree(content_blocker, blocker, ignore=shutil.ignore_patterns('_metadata'))
            for path in sorted(BRIDGE.iterdir()):
                shutil.copy2(path, blocker / path.name)
            if ubo_seed:
                seed_content_blocker(runtime, blocker)
        launcher = root / 'bin/ardia'
        launcher.parent.mkdir()
        launcher.write_text('#!/usr/bin/env sh\nardia_bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ardia_bin_dir/../lib/ardia/ardia-launch" "$@"\n')
        launcher.chmod(0o755)
        applications = root / 'share/applications'
        applications.mkdir(parents=True)
        for name, entry in linux_formats.desktop_entries().items():
            (applications / name).write_text(entry)
        policy = root / 'share/polkit-1/actions/dev.ardia.linux.policy'
        policy.parent.mkdir(parents=True)
        shutil.copyfile(pathlib.Path(__file__).resolve().parent / 'dev.ardia.linux.policy', policy)
        profile = root / 'share/apparmor.d/ardia'
        profile.parent.mkdir(parents=True)
        shutil.copyfile(pathlib.Path(__file__).resolve().parent / 'ardia.apparmor', profile)
        installer = root / 'install.sh'
        shutil.copyfile(pathlib.Path(__file__).resolve().parent / 'install.sh', installer)
        installer.chmod(0o755)
        icon = pathlib.Path(__file__).resolve().parents[2] / 'engine/chromium/src/chrome/app/theme/chromium/product_logo_256.png'
        if icon.is_file():
            target = root / 'share/icons/hicolor/256x256/apps/ardia.png'
            target.parent.mkdir(parents=True)
            shutil.copyfile(icon, target)
        if update_verify is not None:
            check_update_verify(runtime / 'ardia-update-verify')
        normalize_modes(root)
        write_archive(root, destination)
        if deb is not None:
            linux_formats.build_deb(root, deb, version)
        if appimage is not None:
            linux_formats.build_appimage(root, appimage)
        if rpm is not None:
            linux_formats.build_rpm(root, rpm, version)
    return destination


def write_archive(root, destination):
    with destination.open('xb') as handle:
        try:
            xz = subprocess.Popen(['xz', '-T0', '-6', '-c'], stdin=subprocess.PIPE, stdout=handle)
        except OSError:
            destination.unlink(missing_ok=True)
            raise
        try:
            with tarfile.open(fileobj=xz.stdin, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                archive.add(root, arcname='ardia')
        except BaseException:
            xz.kill()
            xz.wait()
            destination.unlink(missing_ok=True)
            raise
        finally:
            xz.stdin.close()
        if xz.wait() != 0:
            destination.unlink(missing_ok=True)
            raise OSError(f'xz exited {xz.returncode} while writing {destination}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--ui', type=pathlib.Path, required=True)
    parser.add_argument('--destination', type=pathlib.Path, required=True)
    parser.add_argument('--content-blocker', type=pathlib.Path)
    parser.add_argument('--version', help='the Ardia version, written to lib/ardia/VERSION')
    parser.add_argument('--cli', type=pathlib.Path, help=f'the ardia-cli-<version>-{CLI_PLATFORM}.tar.gz to bundle in lib/ardia/cli (needs --version)')
    parser.add_argument('--deb', type=pathlib.Path, help='also build a .deb at this path (dpkg-deb and readelf; needs --version)')
    parser.add_argument('--appimage', type=pathlib.Path, help='also build an AppImage at this path (a pinned type 2 runtime and mksquashfs)')
    parser.add_argument('--update-verify', type=pathlib.Path, help=f'the {UPDATE_VERIFY_TARGET} ardia-update-verify to bundle in lib/ardia, as scripts/linux/update-verify.sh builds it (without it the package never updates itself)')
    parser.add_argument('--rpm', type=pathlib.Path, help='also build an .rpm at this path (rpmbuild; needs --version)')
    parser.add_argument('--no-ubo-seed', action='store_true', help="don't seed the content blocker (by default package.py runs the staged chrome once to save uBlock Origin's compiled engine, so a new profile filters from its first page)")
    args = parser.parse_args()
    if args.cli is not None and args.version is None:
        parser.error('--cli needs --version')
    for flag in ('deb', 'rpm'):
        if getattr(args, flag) is not None and args.version is None:
            parser.error(f'--{flag} needs --version')
    try:
        blocker = args.content_blocker.resolve() if args.content_blocker else None
        cli = args.cli.resolve() if args.cli else None
        deb = args.deb.resolve() if args.deb else None
        appimage = args.appimage.resolve() if args.appimage else None
        update_verify = args.update_verify.resolve() if args.update_verify else None
        if update_verify is None:
            print('package.py: no --update-verify, so this package has no lib/ardia/ardia-update-verify and its kind is "unsupported noVerifier": it never updates itself', file=sys.stderr)
        rpm = args.rpm.resolve() if args.rpm else None
        print(package(args.out.resolve(), args.ui.resolve(), args.destination.resolve(), blocker, args.version, cli, deb, appimage, ubo_seed=not args.no_ubo_seed,
                      update_verify=update_verify, rpm=rpm))
    except (ValueError, OSError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == '__main__':
    main()
