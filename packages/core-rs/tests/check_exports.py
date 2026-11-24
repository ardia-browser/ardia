import pathlib
import platform
import re
import subprocess
import sys

CORE = pathlib.Path(__file__).resolve().parents[1]
LIBRARIES = [('ardia_core', ['ardia_core'], 'ardia_', 15), ('ardia_update', ['ardia_update'], 'ardia_update_', 5),
             ('ardia_import', ['ardia_import'], 'ardia_import_', 4),
             ('ardia_apple', ['ardia_core', 'ardia_import'], 'ardia_', 19)]
DARWIN = platform.system() == 'Darwin'
FORBIDDEN = re.compile(r'nonce|fixture', re.I)


def declared(header):
    return sorted(set(re.findall(r'^[A-Za-z0-9_ *]*?\b(ardia_[a-z0-9_]+)\(', header.read_text(), re.M)))


def llvm_nm():
    sysroot = subprocess.run(['rustc', '--print', 'sysroot'], capture_output=True, text=True, check=True).stdout.strip()
    host = re.search(r'^host: (\S+)$', subprocess.run(['rustc', '-vV'], capture_output=True, text=True,
                                                       check=True).stdout, re.M).group(1)
    tool = pathlib.Path(sysroot) / 'lib/rustlib' / host / 'bin/llvm-nm'
    if not tool.exists():
        raise SystemExit(f'{tool} is missing: run `rustup component add llvm-tools`')
    return str(tool)


def defined_globals(library, demangle):
    command = [llvm_nm(), '--defined-only', '--extern-only', '--format=just-symbols']
    if demangle:
        command.append('--demangle')
    if library.suffix == '.so':
        command.append('--dynamic')
    listing = subprocess.run([*command, str(library)], capture_output=True, text=True, check=True).stdout
    names = []
    for line in listing.splitlines():
        name = line.strip()
        if not name or name.endswith(':'):
            continue
        names.append(name[1:] if DARWIN and name.startswith('_') else name)
    return names


def c_exports(library):
    return sorted(set(name for name in defined_globals(library, demangle=False) if name.startswith('ardia_')))


def check(library, want, prefix):
    problems = []
    got = c_exports(library)
    if any(not name.startswith(prefix) for name in want):
        problems.append(f'{library.name} declares functions outside {prefix}*: {want}')
    if got != want:
        problems.append(f'{library.name} exports {got}, the header declares {want}')
    forbidden = sorted(set(name for name in defined_globals(library, demangle=True) if FORBIDDEN.search(name)))
    if forbidden:
        problems.append(f'{library.name} defines fixture or nonce symbols: {forbidden}')
    return problems


def main():
    problems = []
    summary = []
    for name, headers, prefix, count in LIBRARIES:
        want = sorted(set().union(*(declared(CORE / f'include/{header}.h') for header in headers)))
        listed = ' and '.join(f'include/{header}.h' for header in headers)
        if len(want) != count:
            print(f'{listed} declare {len(want)} functions, not {count}: {want}', file=sys.stderr)
            return 1
        shared = CORE / (f'target/release/lib{name}.dylib' if DARWIN else f'target/release/lib{name}.so')
        static = CORE / f'target/release/lib{name}.a'
        problems += check(shared, want, prefix) + check(static, want, prefix)
        summary.append(f'{shared.name} and {static.name} export exactly the {len(want)} functions of {listed}')
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1
    print('; '.join(summary) + ', and no fixture or nonce symbol')
    return 0


if __name__ == '__main__':
    sys.exit(main())
