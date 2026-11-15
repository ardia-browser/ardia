#!/usr/bin/env python3
"""Clones helium-chromium into <build root>/helium and helium-linux into <build root>/helium-linux at the commits
scripts/linux/engine/helium-pins.ini names (a checkout already at its commit is left alone; one elsewhere, or with
local changes, is refused), and checks helium-linux's helium-chromium submodule names the same commit.

Usage: scripts/linux/engine/pins.py checkout <build root>
"""
import configparser
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
CHECKOUTS = {'helium-chromium': 'helium', 'helium-linux': 'helium-linux'}


def git(repo, *args, check=True):
    return subprocess.run(['git', '-C', str(repo), *args], check=check, capture_output=True, text=True,
                          stdin=subprocess.DEVNULL)


def checkout(root):
    config = configparser.ConfigParser(interpolation=None)
    config.read(HERE / 'helium-pins.ini')
    for section, folder in CHECKOUTS.items():
        repo, want = root / folder, config[section]['commit']
        if (repo / '.git').exists():
            head = git(repo, 'rev-parse', 'HEAD', check=False).stdout.strip()
            if head == want:
                if git(repo, 'status', '--porcelain', '--untracked-files=no').stdout.strip():
                    sys.exit(f'pins.py: {repo} has local changes')
                print(f'{section}: {repo} at {want[:10]}')
                continue
            sys.exit(f'pins.py: {repo} is at {head or "nothing"}, not {section} {config[section]["tag"]} ({want}): '
                     'move it aside')
        repo.mkdir(parents=True, exist_ok=True)
        git(repo, 'init', '-q')
        git(repo, 'remote', 'add', 'origin', config[section]['url'])
        git(repo, 'fetch', '-q', '--depth=1', 'origin', want)
        git(repo, '-c', 'advice.detachedHead=false', 'checkout', '-q', want)
        print(f'{section}: cloned {config[section]["tag"]} into {repo}')
    tree = git(root / 'helium-linux', 'ls-tree', 'HEAD', 'helium-chromium', check=False).stdout.split()
    submodule = tree[2] if len(tree) > 2 else None
    if submodule != config['helium-chromium']['commit']:
        print(f'pins.py: helium-linux\'s helium-chromium submodule is {submodule}, '
              f'not {config["helium-chromium"]["commit"]}: compare their patches before trusting the pin',
              file=sys.stderr)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != 'checkout':
        sys.exit(__doc__)
    checkout(pathlib.Path(sys.argv[2]).resolve())
