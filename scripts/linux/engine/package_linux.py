#!/usr/bin/env python3
"""Packs a Linux out dir into a tarball of the files Chromium's CI ships as its runnable Linux snapshot: the
chrome-linux.zip archive of infra/archive_config/linux-archive-rel.json (its files and dirs), under one top folder.
Entries the build didn't make are listed, not fatal. The tarball's files are checked against gn's runtime deps of
//chrome:chrome, and what differs goes to <work>/missing-runtime-deps.txt. RUN.txt goes in. Run by 06-package.sh.

Usage: package_linux.py --src SRC --out OUT --config JSON --runtime-deps TXT --work DIR --tarball TAR.XZ --cpu CPU
         --chromium VERSION --helium TAG
"""
import argparse
import datetime
import glob
import io
import json
import os
import sys
import tarfile

RUN_TXT = """Ardia's engine for Linux ({cpu})

Chromium {chromium} with Helium {helium} and Ardia's patches, built on Ubuntu 24.04 against Chromium's Debian
sysroot on {date}. Not an official build (no ThinLTO, no PGO); symbols at symbol_level=1.

Start it with a throwaway profile:

  {top}/chrome --user-data-dir="$(mktemp -d)" --no-first-run --no-default-browser-check

Chrome's sandbox needs unprivileged user namespaces. Ubuntu 23.10 and later allow them only to binaries an AppArmor
profile names (kernel.apparmor_restrict_unprivileged_userns=1): without one, chrome exits with "No usable sandbox".
Either add a profile for this path (as root, see /etc/apparmor.d/chrome for the shape) or, for a throwaway test
only, add --no-sandbox. chrome_sandbox, the setuid fallback, isn't in this package.

It installs nothing and registers nothing. The product name it shows is "Chromium"; Ardia's app is not in it.
"""

SKIP_SUFFIXES = ('.runtime_deps', '.info', '.TOC')


def archive_entries(config):
    data = json.load(open(config))
    for archive in data['archive_datas']:
        if str(archive.get('gcs_path', '')).endswith('/chrome-linux.zip'):
            return archive.get('files', []), archive.get('dirs', [])
    sys.exit(f'{config}: no chrome-linux.zip archive')


def collect(out_dir, files, dirs):
    picked, not_built = [], []
    for pattern in files:
        matches = sorted(glob.glob(os.path.join(out_dir, pattern)))
        if not matches:
            not_built.append(pattern)
        picked += [os.path.relpath(m, out_dir) for m in matches if os.path.isfile(m)]
    for d in dirs:
        root = os.path.join(out_dir, d)
        if not os.path.isdir(root):
            not_built.append(d + '/')
            continue
        for top, _, names in os.walk(root):
            picked += [os.path.relpath(os.path.join(top, n), out_dir) for n in sorted(names)]
    return sorted(set(picked)), not_built


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for flag in ('--src', '--out', '--config', '--runtime-deps', '--work', '--tarball', '--cpu', '--chromium',
                 '--helium'):
        parser.add_argument(flag, required=True)
    args = parser.parse_args()
    out_dir = os.path.join(args.src, args.out)
    files, dirs = archive_entries(args.config)
    picked, not_built = collect(out_dir, files, dirs)
    deps = [l.strip().removeprefix('./') for l in open(args.runtime_deps) if l.strip()]
    outside = [d for d in deps if d.startswith('../')]
    packed = set(picked)
    missing, absent = [], []
    for d in deps:
        if d.startswith('../'):
            continue
        full = os.path.join(out_dir, d)
        names = ([os.path.relpath(os.path.join(r, f), out_dir) for r, _, fs in os.walk(full) for f in fs]
                 if d.endswith('/') else [d])
        for name in names:
            if name.endswith(SKIP_SUFFIXES) or name in packed:
                continue
            (missing if os.path.exists(os.path.join(out_dir, name)) else absent).append(name)
    os.makedirs(args.work, exist_ok=True)
    report = os.path.join(args.work, 'missing-runtime-deps.txt')
    with open(report, 'w') as f:
        f.write(f'# runtime_deps of //chrome:chrome: {len(deps)} entries, {len(outside)} outside the out dir\n')
        f.write('# built but not in the tarball:\n')
        f.writelines(m + '\n' for m in sorted(missing))
        f.write('# listed by gn, not in the out dir:\n')
        f.writelines(m + '\n' for m in sorted(absent))
        f.write('# outside the out dir (source files gn lists as data):\n')
        f.writelines(m + '\n' for m in sorted(outside))
        f.write('# in the archive config, not built:\n')
        f.writelines(m + '\n' for m in sorted(not_built))
    top = os.path.basename(args.tarball).removesuffix('.tar.xz')
    tmp = args.tarball + '.tmp'
    size = 0
    with tarfile.open(tmp, 'w:xz', preset=6) as tar:
        for name in picked:
            tar.add(os.path.join(out_dir, name), arcname=f'{top}/{name}', recursive=False)
            size += os.path.getsize(os.path.join(out_dir, name))
        text = RUN_TXT.format(cpu=args.cpu, chromium=args.chromium, helium=args.helium, top=top,
                              date=datetime.date.today().isoformat()).encode()
        info = tarfile.TarInfo(f'{top}/RUN.txt')
        info.size, info.mode, info.mtime = len(text), 0o644, int(datetime.datetime.now().timestamp())
        tar.addfile(info, io.BytesIO(text))
    os.replace(tmp, args.tarball)
    print(f'{args.tarball}: {len(picked) + 1} files, {size / 1e6:.0f} MB unpacked, '
          f'{os.path.getsize(args.tarball) / 1e6:.0f} MB')
    print(f'runtime deps: {len(missing)} built but not packed, {len(absent)} not built, {len(outside)} source files; '
          f'archive config entries not built: {", ".join(not_built) or "none"}; see {report}')


if __name__ == '__main__':
    sys.exit(main())
