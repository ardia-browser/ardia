#!/usr/bin/env python3
"""Usage: scripts/release/plugin-digest.py <plugin folder>
  Prints the folder's payload digest, the one PluginPrograms.payloadDigest computes for the copy it publishes: the
  SHA-256 of one line per entry, sorted by path bytes, `d <path>` or `f <mode & 755> <sha256> <path>`, leaving out
  every __pycache__ folder and the top-level names Ardia keeps for itself (.leases, .after-update, .after-update-claim).
  A link, a name with control characters or any other kind of file is refused, as Ardia refuses it."""
import hashlib
import os
import stat
import sys

RESERVED = {".leases", ".after-update", ".after-update-claim"}


def digest(root: str) -> str:
    entries = []
    for directory, dirs, files in os.walk(root):
        relative = os.path.relpath(directory, root)
        dirs[:] = [d for d in dirs if d != "__pycache__" and not (relative == "." and d in RESERVED)]
        if relative == ".":
            files = [f for f in files if f not in RESERVED]
        for name in dirs + files:
            if any(ord(c) < 0x20 or ord(c) == 0x7F for c in name):
                raise SystemExit(f"plugin-digest: a name in {relative} has control characters")
            entries.append(os.path.normpath(os.path.join(relative, name)))
    listing = bytearray()
    for relative in sorted(entries, key=lambda p: p.encode()):
        path = os.path.join(root, relative)
        info = os.lstat(path)
        if stat.S_ISDIR(info.st_mode):
            listing += f"d {relative}\n".encode()
        elif stat.S_ISREG(info.st_mode):
            with open(path, "rb") as handle:
                content = hashlib.sha256(handle.read()).hexdigest()
            listing += f"f {oct(info.st_mode & 0o755)[2:]} {content} {relative}\n".encode()
        else:
            raise SystemExit(f"plugin-digest: {relative} isn't a file or a folder")
    return hashlib.sha256(bytes(listing)).hexdigest()


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        sys.exit(0 if len(sys.argv) == 2 else 64)
    print(digest(sys.argv[1]))
