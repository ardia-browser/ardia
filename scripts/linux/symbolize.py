#!/usr/bin/env python3
"""usage: scripts/linux/symbolize.py --symbols PATH --build-id ID OFFSET...

Names the frames of a Linux crash report. PATH is an engine's symbols archive
(ArdiaCore-<key12>-linux-x64-symbols.tar.xz from the engine-<key12> release)
or a folder holding its .build-id tree. ID is the image's build ID from the
report's crash_images, and each OFFSET (hex, as the report's image_offset) is a
frame in that image, crashing frame first. Every frame after the first is a
return address, so it is looked up one byte earlier, inside the call.

Prints one line per offset: the offset, then the function, or ?? when the
symbols don't cover it. Needs addr2line (binutils).
"""
import argparse
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

BUILD_ID = re.compile(r'^[0-9a-f]{16,64}$')


def debug_file(symbols, build_id, scratch):
    relative = pathlib.Path('.build-id') / build_id[:2] / f'{build_id[2:]}.debug'
    if symbols.is_dir():
        for candidate in (symbols / relative, *symbols.glob(f'*/{relative}')):
            if candidate.is_file():
                return candidate
        return None
    with tarfile.open(symbols) as packed:
        for member in packed.getmembers():
            if member.isfile() and member.name.endswith(str(relative)):
                packed.extract(member, scratch, filter='data')
                return scratch / member.name
    return None


def main():
    parser = argparse.ArgumentParser(prog='symbolize.py', usage=__doc__.splitlines()[0][7:])
    parser.add_argument('--symbols', type=pathlib.Path, required=True)
    parser.add_argument('--build-id', required=True)
    parser.add_argument('offsets', nargs='+')
    if any(arg in ('-h', '--help') for arg in sys.argv[1:]):
        print(__doc__.strip())
        return 0
    args = parser.parse_args()
    if not BUILD_ID.match(args.build_id):
        parser.error(f'not a build ID: {args.build_id}')
    if not shutil.which('addr2line'):
        print('symbolize.py: addr2line is required (binutils)', file=sys.stderr)
        return 69
    try:
        offsets = [int(text, 16) for text in args.offsets]
    except ValueError as error:
        parser.error(f'offsets are hex: {error}')
    with tempfile.TemporaryDirectory(prefix='ardia-symbolize-') as scratch:
        found = debug_file(args.symbols, args.build_id, pathlib.Path(scratch))
        if found is None:
            print(f'symbolize.py: {args.symbols} has no symbols for build ID {args.build_id}', file=sys.stderr)
            return 1
        looked_up = [offset if index == 0 else max(offset - 1, 0) for index, offset in enumerate(offsets)]
        result = subprocess.run(['addr2line', '-f', '-C', '-e', str(found), *[hex(offset) for offset in looked_up]], capture_output=True, text=True)
        if result.returncode != 0:
            print(f'symbolize.py: addr2line failed: {result.stderr.strip()}', file=sys.stderr)
            return 1
        lines = result.stdout.splitlines()
        for index, offset in enumerate(offsets):
            name = lines[index * 2] if index * 2 < len(lines) else '??'
            print(f'{hex(offset)}\t{name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
