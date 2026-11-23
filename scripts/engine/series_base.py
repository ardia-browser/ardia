import configparser
import contextlib
import hashlib
import importlib.util
import io
import json
import lzma
import os
import pathlib
import re
import stat
import sys
import tarfile

REPO = pathlib.Path(__file__).resolve().parents[2]
BUILD = REPO / "engine/patches/build"
TABLE = REPO / "scripts/engine/series-bases.tsv"
IDENTITY = ("platform", "cpu", "chromium", "helium_chromium", "helium_platform", "inputs")
TABLE_FIELDS = IDENTITY + ("tag", "asset", "sha256")
DEFAULT_CPU = {"mac": "arm64", "linux": "x64"}
PLATFORM_HELIUM = {"mac": "helium-macos", "linux": "helium-linux"}
STEP3_FILES = ("03-helium.py", "ardia_namesub.py", "ardia_resources.txt", "domsub-keep-store.txt", "helium-pins.ini",
               "env.sh", "target_config.py")
STEP3_STAGES = ("patches", "fixups", "domsub", "namesub", "brand-namesub", "version", "resources")
MANIFEST = "manifest.json"
FILES_ROOT = "src/"
FORMAT = 2
MAX_ARCHIVE_BYTES = 64 << 20
MAX_EXPANDED_BYTES = 512 << 20
MAX_MEMBER_BYTES = 64 << 20
MAX_MANIFEST_BYTES = 16 << 20
MAX_MEMBERS = 20000
MAX_DECODER_MEMORY = 128 << 20
VERIFIED = ("chromium-version", "helium-checkouts", "step3-stages", "step3-stamp", "capture-record", "step3-resources",
            "brand-namesub", "series-check")


class Problem(Exception):
    pass


def load_series():
    spec = importlib.util.spec_from_file_location("ardia_series", REPO / "engine/patches/series.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def pins(build=BUILD):
    env = pathlib.Path(build, "env.sh").read_text()
    match = re.search(r"^export CHROMIUM_VERSION=([0-9.]+)$", env, re.M)
    if not match:
        raise Problem(f"{build}/env.sh sets no CHROMIUM_VERSION")
    ini = configparser.ConfigParser()
    ini.read(pathlib.Path(build, "helium-pins.ini"))
    if ini.get("chromium", "version", fallback=None) != match.group(1):
        raise Problem(f"env.sh pins Chromium {match.group(1)} but helium-pins.ini pins {ini.get('chromium', 'version', fallback='none')}")
    out = {"chromium": match.group(1)}
    for section in ("helium-chromium", "helium-macos", "helium-linux"):
        commit = ini.get(section, "commit", fallback="")
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise Problem(f"helium-pins.ini: [{section}] has no 40-hex commit")
        out[section] = commit
    return out


def resource_pairs(build=BUILD):
    pairs = []
    listing = pathlib.Path(build, "ardia_resources.txt")
    for number, line in enumerate(listing.read_text().splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 2 or not all(safe_relative(part) for part in parts):
            raise Problem(f"{listing}:{number}: expected `<source> <dest>`, both relative")
        pairs.append((parts[0], parts[1]))
    return pairs


def step3_digest(build=BUILD, repo=REPO):
    entries = [(f"engine/patches/build/{name}", pathlib.Path(build, name)) for name in STEP3_FILES]
    entries += [(source, pathlib.Path(repo, source)) for source, _ in resource_pairs(build)]
    digest = hashlib.sha256()
    for name, path in sorted(set(entries)):
        if not path.is_file():
            raise Problem(f"step 3 reads {name}, which is missing")
        digest.update(name.encode() + b"\0" + hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


CAPTURE_RECORD = ".ardia-capture.json"
BASE_MARKERS = (".ardia-series-target", CAPTURE_RECORD)


def chromium_build():
    return os.environ.get("AC_CHROMIUM_BUILD", os.path.expanduser("~/chromium-build"))


def default_base(platform, cpu):
    if "AC_SERIES_BASE" in os.environ:
        return os.environ["AC_SERIES_BASE"]
    name = "series-base" if (platform, cpu) == ("mac", "arm64") else f"series-base-{platform}-{cpu}"
    return os.path.join(chromium_build(), name)


def default_src():
    return os.environ.get("CHROMIUM_SRC", os.path.join(chromium_build(), "chromium_git/chromium/src"))


def normal_mode(st_mode):
    return 0o755 if st_mode & stat.S_IXUSR else 0o644


def snapshot_base(base):
    out = {}
    for top, dirs, files in os.walk(base):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(top, name)
            path = os.path.relpath(full, base).replace(os.sep, "/")
            if path in BASE_MARKERS:
                continue
            if os.path.islink(full) or not os.path.isfile(full):
                raise Problem(f"{full} isn't a regular file: the series base holds regular files only")
            with open(full, "rb") as handle:
                mode = normal_mode(os.fstat(handle.fileno()).st_mode)
                out[path] = (handle.read(), mode)
    return out


def snapshot_hashes(snapshot):
    return {path: {"sha256": hashlib.sha256(data).hexdigest(), "mode": f"{mode:o}"}
            for path, (data, mode) in snapshot.items()}


def base_file_hashes(base):
    return snapshot_hashes(snapshot_base(base))


def stage_marker(tree):
    tree = pathlib.Path(tree)
    return tree.parent / f".helium-stages-{tree.name}"


def step3_stamp(tree):
    tree = pathlib.Path(tree)
    return tree.parent / f".ardia-step3-{tree.name}.json"


def identity(platform, cpu=None, build=BUILD, repo=REPO):
    if platform not in DEFAULT_CPU:
        raise Problem(f"unknown platform {platform}")
    pinned = pins(build)
    return {"platform": platform, "cpu": cpu or DEFAULT_CPU[platform], "chromium": pinned["chromium"],
            "helium_chromium": pinned["helium-chromium"], "helium_platform": pinned[PLATFORM_HELIUM[platform]],
            "inputs": step3_digest(build, repo)}


def tag_name(ident):
    return f"series-base-{ident['chromium']}-{ident['helium_chromium'][:12]}"


def asset_prefix(ident):
    return (f"series-base-{ident['chromium']}-{ident['helium_chromium'][:12]}-{ident['platform']}-"
            f"{ident['helium_platform'][:12]}-{ident['cpu']}-{ident['inputs'][:12]}-")


def content_revision(manifest):
    files = json.dumps({"files": manifest["files"], "absent": manifest["absent"],
                        "provenance": manifest.get("provenance")}, sort_keys=True)
    return hashlib.sha256(files.encode()).hexdigest()[:12]


def require_provenance(manifest, name):
    provenance = manifest.get("provenance")
    keys = ("step3_run", "step3_stamp_sha256", "capture_sha256")
    if manifest.get("verified") != list(VERIFIED) or not isinstance(provenance, dict) or \
            not all(isinstance(provenance.get(key), str) and provenance[key] for key in keys):
        raise Problem(f"{name} was packed without the builder's provenance (checks {manifest.get('verified')}, "
                      f"provenance {provenance}): pack it again from a tree run-step3.py stamped and a base "
                      "run-capture.py recorded")


def asset_name(ident, revision):
    return f"{asset_prefix(ident)}{revision}.tar.xz"


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(path):
    return bool(path) and not path.startswith("/") and "\\" not in path and \
        all(part not in ("", ".", "..") for part in path.split("/"))


def split_hunks(text):
    files, current, lines, index = [], None, text.splitlines(keepends=True), 0
    while index < len(lines):
        line = lines[index]
        hunk = re.match(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@", line)
        if hunk and current is not None:
            old = int(hunk.group(1)) if hunk.group(1) is not None else 1
            new = int(hunk.group(2)) if hunk.group(2) is not None else 1
            body = [line]
            current["starts"].append(index)
            index += 1
            while index < len(lines) and (old > 0 or new > 0 or lines[index].startswith("\\")):
                body_line = lines[index]
                if body_line.startswith("\\"):
                    pass
                elif body_line.startswith("-"):
                    old -= 1
                elif body_line.startswith("+"):
                    new -= 1
                else:
                    old, new = old - 1, new - 1
                body.append(body_line)
                index += 1
            current["hunks"].append(body)
            continue
        if line.startswith("diff ") or (line.startswith("--- ") and (current is None or current["hunks"])):
            current = {"header": [], "hunks": [], "starts": [], "path": None, "old": None, "new": None,
                       "kind": "modify"}
            files.append(current)
            git = re.match(r"^diff --git a/(\S+) b/(\S+)\s*$", line)
            if git:
                current["old"], current["new"] = git.group(1), git.group(2)
        if current is not None and not current["hunks"]:
            current["header"].append(line)
            read_header_line(current, line.rstrip("\n"))
        index += 1
    for entry in files:
        entry["path"] = entry["new"] or entry["old"]
    return files


def read_header_line(entry, line):
    side = re.match(r"^(---|\+\+\+) (\S+)", line)
    if side:
        path = side.group(2)
        key = "old" if side.group(1) == "---" else "new"
        if path == "/dev/null":
            entry[key] = None
            entry["kind"] = "create" if key == "old" else "delete"
        else:
            entry[key] = path[2:] if path.startswith(("a/", "b/")) else path
    elif line.startswith("new file mode "):
        entry["old"], entry["kind"] = None, "create"
    elif line.startswith("deleted file mode "):
        entry["new"], entry["kind"] = None, "delete"
    for verb in ("rename", "copy"):
        moved = re.match(rf"^{verb} (from|to) (\S+)$", line)
        if moved:
            entry["old" if moved.group(1) == "from" else "new"] = moved.group(2)
            entry["kind"] = verb


def patch_sections(step):
    text = pathlib.Path(step.patch).read_text(encoding="utf-8", errors="surrogateescape")
    return [(entry["old"], entry["new"], entry["kind"]) for entry in split_hunks(text)]


def base_paths(steps):
    required, optional, created = {}, {}, set()
    later = []
    for step in steps:
        if step.kind != "chromium":
            later.append(step)
            continue
        for old, new, kind in patch_sections(step):
            if old and old not in created:
                required.setdefault(old, step.name)
            if new and kind in ("create", "rename", "copy"):
                created.add(new)
            if kind in ("delete", "rename") and old:
                created.discard(old)
    for step in later:
        for path, is_dir in step.paths():
            if not is_dir and path not in created and path not in required:
                optional.setdefault(path, step.name)
    return required, optional


def read_table(table=TABLE):
    rows = []
    if not pathlib.Path(table).exists():
        return rows
    for number, line in enumerate(pathlib.Path(table).read_text().splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split("\t")
        if len(fields) != len(TABLE_FIELDS):
            raise Problem(f"{table}:{number}: expected {len(TABLE_FIELDS)} tab-separated fields")
        rows.append(dict(zip(TABLE_FIELDS, fields)))
    return rows


def find_row(ident, table=TABLE):
    for row in read_table(table):
        if all(row[key] == ident[key] for key in IDENTITY):
            return row
    return None


def write_row(row, table=TABLE):
    rows = [r for r in read_table(table) if (r["platform"], r["cpu"]) != (row["platform"], row["cpu"])] + [row]
    rows.sort(key=lambda r: (r["chromium"], r["platform"], r["cpu"], r["asset"]))
    pathlib.Path(table).write_text("".join("\t".join(r[k] for k in TABLE_FIELDS) + "\n" for r in rows))


def _tar_info(name, size=0, mode=0o644, kind=tarfile.REGTYPE, link=""):
    info = tarfile.TarInfo(name)
    info.size, info.mode, info.type, info.linkname = size, mode, kind, link
    info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
    return info


def write_tarball(source, paths, manifest_fields, out):
    snapshot = source if isinstance(source, dict) else snapshot_base(source)
    files, absent = {}, []
    entries = []
    for path in sorted(paths):
        if not safe_relative(path):
            raise Problem(f"unsafe path in the series: {path!r}")
        if path in snapshot:
            data, mode = snapshot[path]
            files[path] = {"sha256": hashlib.sha256(data).hexdigest(), "mode": f"{mode:o}"}
            entries.append((path, data, mode))
        else:
            absent.append(path)
    manifest = dict(manifest_fields, format=FORMAT, files=files, absent=absent)
    body = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode()
    if os.path.isdir(out):
        out = os.path.join(out, asset_name(manifest_fields, content_revision(manifest)))
    if os.path.exists(out):
        raise Problem(f"{out} exists; give a new destination")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with tarfile.open(out, "w:xz", format=tarfile.PAX_FORMAT, preset=9) as tar:
        tar.addfile(_tar_info(MANIFEST, len(body)), io.BytesIO(body))
        for path, data, mode in entries:
            tar.addfile(_tar_info(FILES_ROOT + path, len(data), mode), io.BytesIO(data))
    return manifest, out


def check_archive_size(tarball):
    try:
        size = os.path.getsize(tarball)
    except OSError as error:
        raise Problem(f"no series base archive at {tarball}: {error.strerror}")
    if size > MAX_ARCHIVE_BYTES:
        raise Problem(f"{tarball} is {size} bytes, over the {MAX_ARCHIVE_BYTES} a series base may be")


class XzStream(io.RawIOBase):
    def __init__(self, path, limit, memlimit):
        super().__init__()
        self.path, self.limit, self.memlimit = path, limit, memlimit
        self.raw = None
        self.restart()

    def restart(self):
        if self.raw:
            self.raw.close()
        self.raw = open(self.path, "rb")
        self.decoder = lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=self.memlimit)
        self.buffer, self.position = b"", 0

    def fill(self, wanted):
        while len(self.buffer) < wanted and not self.decoder.eof:
            chunk = b""
            if self.decoder.needs_input:
                chunk = self.raw.read(1 << 16)
                if not chunk:
                    raise Problem(f"{self.path} ends in the middle of its xz stream")
            self.buffer += self.decoder.decompress(chunk, max_length=1 << 20)
            if self.position + len(self.buffer) > self.limit:
                raise Problem(f"{self.path} expands past {self.limit} bytes, headers included")

    def readable(self):
        return True

    def seekable(self):
        return True

    def read(self, size=-1):
        if size is None or size < 0:
            size = self.limit + 1 - self.position
        self.fill(size)
        data, self.buffer = self.buffer[:size], self.buffer[size:]
        self.position += len(data)
        return data

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def seek(self, offset, whence=io.SEEK_SET):
        target = {io.SEEK_SET: offset, io.SEEK_CUR: self.position + offset}.get(whence)
        if target is None:
            raise io.UnsupportedOperation("a series base archive is read forwards or from its start")
        if target > self.limit:
            raise Problem(f"{self.path} expands past {self.limit} bytes, headers included")
        if target < self.position:
            self.restart()
        while self.position < target:
            if not self.read(min(target - self.position, 1 << 20)):
                break
        return self.position

    def tell(self):
        return self.position

    def close(self):
        if self.raw:
            self.raw.close()
        super().close()


@contextlib.contextmanager
def open_archive(tarball):
    check_archive_size(tarball)
    with XzStream(tarball, MAX_EXPANDED_BYTES, MAX_DECODER_MEMORY) as stream:
        with tarfile.open(fileobj=stream, mode="r:") as tar:
            yield tar


def members(tar, tarball):
    count = total = 0
    for member in tar:
        count += 1
        total += max(member.size, 0)
        if count > MAX_MEMBERS:
            raise Problem(f"{tarball} has over {MAX_MEMBERS} entries")
        if member.size > MAX_MEMBER_BYTES or total > MAX_EXPANDED_BYTES:
            raise Problem(f"{tarball} expands past its limits ({member.name}: {member.size} bytes, {total} in all)")
        yield member


def read_manifest(tarball):
    check_archive_size(tarball)
    try:
        with open_archive(tarball) as tar:
            member = next((m for m in members(tar, tarball) if m.name == MANIFEST), None)
            if member is None or not member.isfile():
                raise Problem(f"{tarball} isn't a series base archive: it has no {MANIFEST} file")
            if member.size > MAX_MANIFEST_BYTES:
                raise Problem(f"{tarball}: {MANIFEST} is {member.size} bytes, over {MAX_MANIFEST_BYTES}")
            manifest = json.loads(tar.extractfile(member).read(MAX_MANIFEST_BYTES + 1))
    except (OSError, KeyError, ValueError, EOFError, lzma.LZMAError, tarfile.TarError) as error:
        raise Problem(f"{tarball} isn't a series base archive: {error}")
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT or \
            not isinstance(manifest.get("files"), dict) or not isinstance(manifest.get("absent"), list):
        raise Problem(f"{tarball}: not a format {FORMAT} series base manifest")
    return manifest


def extract(tarball, dest):
    manifest = read_manifest(tarball)
    files = manifest["files"]
    seen = set()
    dest = os.path.realpath(dest)
    if os.listdir(dest):
        raise Problem(f"{dest} isn't empty")
    try:
        with open_archive(tarball) as tar:
            for member in members(tar, tarball):
                if member.name == MANIFEST:
                    continue
                if not member.name.startswith(FILES_ROOT):
                    raise Problem(f"{tarball}: unexpected entry {member.name!r}")
                path = member.name[len(FILES_ROOT):]
                if not safe_relative(path) or path not in files or path in seen:
                    raise Problem(f"{tarball}: entry {member.name!r} isn't in its manifest, or is unsafe or repeated")
                if not member.isfile():
                    raise Problem(f"{tarball}: {path} isn't a regular file")
                seen.add(path)
                parent = dest
                for part in path.split("/")[:-1]:
                    parent = os.path.join(parent, part)
                    if os.path.islink(parent) or (os.path.exists(parent) and not os.path.isdir(parent)):
                        raise Problem(f"{tarball}: {path} goes through something that isn't a directory")
                    if not os.path.exists(parent):
                        os.mkdir(parent)
                data = tar.extractfile(member).read(member.size)
                if hashlib.sha256(data).hexdigest() != files[path].get("sha256"):
                    raise Problem(f"{tarball}: {path} doesn't match its manifest's sha256")
                target = os.path.join(dest, path)
                with open(target, "xb") as handle:
                    handle.write(data)
                os.chmod(target, int(files[path].get("mode", "644"), 8) & 0o755)
    except (OSError, EOFError, lzma.LZMAError, tarfile.TarError) as error:
        raise Problem(f"{tarball} can't be read: {error}")
    missing = sorted(set(files) - seen)
    if missing:
        raise Problem(f"{tarball}: its manifest lists {len(missing)} files it doesn't hold, e.g. {missing[0]}")
    return manifest


def die(message, code=1):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(code)
