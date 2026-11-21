#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PIN = ROOT / "apps/browser/official-plugins.json"
INSTALLER = ROOT / "apps/cli/install.sh"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
VERSION = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[a-z]{1,16}\.[0-9]{1,4})?$")
SHA = re.compile(r"^[0-9a-f]{64}$")
FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RELEASE = re.compile(r"^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/releases/download/[A-Za-z0-9._-]+$")
ARTIFACTS = {"macos-arm64": "the plugin folder Ardia bundles on macOS", "linux-x64": "the command's tarball Linux installs", "installer": "install.sh"}
LIMIT = 512 * 1024 * 1024
KNOWN_LEGACY_ROOTS = {"Library/Application Support/Ardia/CLI"}
COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ANCHOR = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,39}$")
REGISTRY_VERSION = 1
PROGRAM_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$")
PROGRAM_ENTITLEMENTS = {"com.apple.security.cs.allow-jit"}
PROGRAM_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
PROGRAM_LIMITS = {"programs": 4, "afterUpdate": (4, 8), "argBytes": 1024, "example": 120}
UNSAFE_TEXT = re.compile("[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")
THIN_MAGICS = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe"}
FAT_MAGICS = {b"\xca\xfe\xba\xbe": "big", b"\xca\xfe\xba\xbf": "big", b"\xbe\xba\xfe\xca": "little", b"\xbf\xba\xfe\xca": "little"}
MAX_FAT_ARCHS = 30
MANIFEST_VERSION = 2
DESCRIPTION = """Fetches and verifies the official plugins pinned in apps/browser/official-plugins.json: every byte that reaches a
release goes through fetch(), which refuses an artifact whose SHA-256 isn't the pinned one.

  check                         the pin file is well formed, and apps/cli/install.sh is the pinned installer
  published <name> <artifact>   exits 0 when that artifact has a pinned SHA-256, 1 while it isn't published yet
  describe                      one provenance line per pinned plugin: name, version and the macOS folder's SHA-256
  fetch <name> <artifact> <out> one pinned artifact (macos-arm64, linux-x64 or installer), verified
  bundle <out dir>              every plugin's macos-arm64 folder, verified and unpacked into <out dir>/<name>, and
                                <out dir>/program-registry.json, the program names they claim
  registry <bundled dir>        prints the program registry (claimed names, legacy installs) for the bundled plugins,
                                the JSON export-sign.sh puts in Info.plist as ArdiaProgramRegistry; refuses one that
                                would lose a reservedPrograms entry of the pin
  verify-registry <bundled dir> <json>
                                checks a recorded registry against the bundled plugins and the pin's reservations
  pin <name> <version>          writes the SHA-256s of <version>'s artifacts into the pin file
  machos <folder>               every regular file in <folder> that is Mach-O (thin or universal), by its magic
                                rather than its name or mode, NUL-separated
  entitlements <name> <folder>  one "<program path><TAB><keys>" line per program the pin grants entitlements, checked
                                against <folder>'s plugin.json; nothing for a plugin that isn't pinned
  linux-cli <app version> <out> the pinned linux-x64 ardia command, verified and renamed ardia-cli-<app version>, the
                                name and top folder the Linux engine's installer expects (ac_linux_cli.cc)

--from <dir> reads artifacts from a folder instead of the plugin's GitHub release (a dry run, or a local build)."""


def fail(message):
    sys.exit(f"official-plugins: {message}")


def load(path=PIN):
    try:
        pin = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"{path} can't be read: {error}")
    problems = problems_of(pin)
    if problems:
        fail(f"{path}: " + "; ".join(problems))
    return pin


def problems_of(pin):
    problems = []
    if not isinstance(pin, dict) or pin.get("version") != 1:
        return ["version must be 1"]
    names = set()
    legacy_programs = set()
    reserved_programs = set()
    for index, plugin in enumerate(pin.get("plugins", [])):
        where = f"plugins[{index}]"
        if not isinstance(plugin, dict):
            problems.append(f"{where} must be an object")
            continue
        name = plugin.get("name")
        if not isinstance(name, str) or not NAME.match(name) or name in names:
            problems.append(f"{where}.name must be a unique plugin name")
        names.add(name)
        for key in ("title", "blurb", "icon"):
            if not isinstance(plugin.get(key), str) or not plugin[key]:
                problems.append(f"{where}.{key} must be text")
        if not isinstance(plugin.get("version"), str) or not VERSION.match(plugin["version"]):
            problems.append(f"{where}.version must be a version")
        if "preselected" in plugin and plugin["preselected"] is not True:
            problems.append(f"{where}.preselected must be true or left out")
        aliases = plugin.get("anchorAliases", [])
        if not isinstance(aliases, list) or not all(isinstance(a, str) and ANCHOR.match(a) for a in aliases):
            problems.append(f"{where}.anchorAliases must be a list of Settings row names")
        reserved = plugin.get("reservedPrograms", [])
        if not isinstance(reserved, list) or not all(isinstance(r, str) and NAME.match(r) for r in reserved) or len(set(reserved)) != len(reserved):
            problems.append(f"{where}.reservedPrograms must be a list of distinct program names")
            reserved = []
        for program in reserved:
            if program in reserved_programs:
                problems.append(f"{where}.reservedPrograms: {program} is reserved by another plugin too")
            reserved_programs.add(program)
        example = plugin.get("example")
        if example is not None and not (isinstance(example, str) and 0 < len(example) <= 120 and example.isprintable()):
            problems.append(f"{where}.example must be a command of 1 to 120 printable characters")
        telemetry = plugin.get("telemetry")
        if telemetry is not None and not (
            isinstance(telemetry, dict) and set(telemetry) == {"title", "items"} and isinstance(telemetry["title"], str) and telemetry["title"]
            and isinstance(telemetry["items"], list) and telemetry["items"] and all(isinstance(i, str) and i for i in telemetry["items"])
        ):
            problems.append(f"{where}.telemetry must be {{title, items}} with text")
        legacy = plugin.get("legacyInstall")
        if legacy is not None:
            if not isinstance(legacy, dict) or set(legacy) != {"program", "root", "current"}:
                problems.append(f"{where}.legacyInstall must have program, root and current")
            else:
                if not isinstance(legacy["program"], str) or not NAME.match(legacy["program"]):
                    problems.append(f"{where}.legacyInstall.program must be a program name")
                elif legacy["program"] not in reserved:
                    problems.append(f"{where}.legacyInstall.program {legacy['program']} must be one of its reservedPrograms")
                elif legacy["program"] in legacy_programs:
                    problems.append(f"{where}.legacyInstall.program {legacy['program']} is another plugin's legacy install too")
                else:
                    legacy_programs.add(legacy["program"])
                if legacy["root"] not in KNOWN_LEGACY_ROOTS:
                    problems.append(f"{where}.legacyInstall.root must be one of {', '.join(sorted(KNOWN_LEGACY_ROOTS))}")
                if not isinstance(legacy["current"], str) or not COMPONENT.match(legacy["current"]):
                    problems.append(f"{where}.legacyInstall.current must be one file name")
        if not isinstance(plugin.get("release"), str) or not RELEASE.match(plugin["release"]):
            problems.append(f"{where}.release must be a GitHub release download URL")
        artifacts = plugin.get("artifacts")
        if not isinstance(artifacts, dict) or not artifacts or not set(artifacts) <= set(ARTIFACTS):
            problems.append(f"{where}.artifacts must name some of {', '.join(ARTIFACTS)}")
            continue
        for key, artifact in artifacts.items():
            if not isinstance(artifact, dict) or not isinstance(artifact.get("file"), str) or not FILE.match(artifact["file"]):
                problems.append(f"{where}.artifacts.{key}.file must be a file name")
            elif artifact.get("sha256") is not None and not (isinstance(artifact["sha256"], str) and SHA.match(artifact["sha256"])):
                problems.append(f"{where}.artifacts.{key}.sha256 must be a SHA-256 or null (not published yet)")
        problems.extend(entitlement_problems(where, plugin))
    for index, soon in enumerate(pin.get("comingSoon", [])):
        if not isinstance(soon, dict) or not all(isinstance(soon.get(k), str) and soon[k] for k in ("name", "title", "blurb", "icon", "experiment")):
            problems.append(f"comingSoon[{index}] needs name, title, blurb, icon and experiment")
    return problems


def entitlement_problems(where, plugin):
    if "entitlements" not in plugin:
        return []
    declared = plugin["entitlements"]
    if not isinstance(declared, dict) or not declared:
        return [f"{where}.entitlements must map program paths to entitlement lists"]
    if "macos-arm64" not in plugin["artifacts"]:
        return [f"{where}.entitlements needs a macos-arm64 artifact to apply to"]
    problems = []
    for path, keys in declared.items():
        if not PROGRAM_PATH.fullmatch(path) or path.endswith((".so", ".dylib")):
            problems.append(f"{where}.entitlements: {path!r} must be a program path in the plugin's folder, like bin/tool")
        if not isinstance(keys, list) or not keys or len(set(map(str, keys))) != len(keys) or not all(isinstance(k, str) and k in PROGRAM_ENTITLEMENTS for k in keys):
            problems.append(f"{where}.entitlements.{path} must list some of {', '.join(sorted(PROGRAM_ENTITLEMENTS))}, once each")
    return problems


def regular_file_in(folder, path):
    current = Path(folder)
    if current.is_symlink() or not current.is_dir():
        return None
    for part in path.split("/"):
        try:
            if part not in os.listdir(current):
                return None
        except OSError:
            return None
        current = current / part
        if current.is_symlink():
            return None
    info = os.lstat(current)
    return info if stat.S_ISREG(info.st_mode) else None


def is_macho(path):
    with open(path, "rb") as handle:
        head = handle.read(8)
    if head[:4] in THIN_MAGICS:
        return True
    order = FAT_MAGICS.get(head[:4])
    if order is None or len(head) < 8:
        return False
    count = int.from_bytes(head[4:8], order)
    if count > MAX_FAT_ARCHS:
        fail(f"{path} starts like a universal binary claiming {count} architectures (or a Java class file): a bundled plugin can't ship it, since it can't be signed or checked as either")
    return count > 0


def machos(folder):
    found = []
    if not os.path.isdir(folder) or os.path.islink(folder.rstrip("/") or "/"):
        fail(f"{folder} isn't a folder")

    def unreadable(error):
        fail(f"{error.filename} can't be listed: {error.strerror}")

    for path, dirs, files in os.walk(folder, onerror=unreadable):
        dirs.sort()
        for entry in sorted(files):
            full = os.path.join(path, entry)
            if stat.S_ISREG(os.lstat(full).st_mode) and is_macho(full):
                found.append(full)
    return found


def is_argument(value):
    if not isinstance(value, str) or not value or "\0" in value:
        return False
    try:
        return len(value.encode("utf-8")) <= PROGRAM_LIMITS["argBytes"]
    except UnicodeEncodeError:
        return False


def is_plugin_path(value):
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value or "\0" in value:
        return False
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        return False
    return units <= PROGRAM_LIMITS["argBytes"] and all(part not in ("", ".", "..") for part in value.split("/"))


def utf16_length(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def is_text(value, most):
    return isinstance(value, str) and bool(re.sub(r"[\s\ufeff]", "", value)) and utf16_length(value) <= most and not UNSAFE_TEXT.search(value)


def manifest_programs(manifest, declared):
    moved = declared < MANIFEST_VERSION and not any(key in manifest for key in ("contributes", "sidecar", "main"))
    if moved:
        return [], manifest.get("programs")
    problems = ["programs isn't a key of a plugin"] if "programs" in manifest else []
    contributes = manifest.get("contributes", {})
    if not isinstance(contributes, dict):
        return problems + ["contributes must be an object"], None
    return problems, contributes.get("programs")


def program_problems(programs, declared=MANIFEST_VERSION):
    if programs is None:
        return [], set()
    if not isinstance(programs, list) or len(programs) > PROGRAM_LIMITS["programs"]:
        return [f"programs must be a list of at most {PROGRAM_LIMITS['programs']}"], set()
    problems, names, paths = [], set(), set()
    most, longest = PROGRAM_LIMITS["afterUpdate"]
    for index, program in enumerate(programs):
        where = f"programs[{index}]"
        if not isinstance(program, dict):
            problems.append(f"{where} must be an object")
            continue
        problems.extend(f"{where}.{key} isn't a key of {where}" for key in program if key not in ("name", "path", "afterUpdate", "example", "claim"))
        name, path, after = program.get("name"), program.get("path"), program.get("afterUpdate", [])
        if not isinstance(name, str) or not PROGRAM_NAME.fullmatch(name):
            problems.append(f"{where}.name must be a plugin name")
        elif name in names:
            problems.append(f"programs has two programs named {name}")
        else:
            names.add(name)
        if not is_plugin_path(path):
            problems.append(f"{where}.path must be a file in the plugin's folder, like bin/tool")
        else:
            paths.add(path)
        if not (isinstance(after, list) and len(after) <= most and all(isinstance(a, list) and 0 < len(a) <= longest and all(map(is_argument, a)) for a in after)):
            problems.append(f"{where}.afterUpdate must be a list of at most {most} argument lists of 1 to {longest}")
        if "example" in program and not is_text(program["example"], PROGRAM_LIMITS["example"]):
            problems.append(f"{where}.example must be text of 1 to {PROGRAM_LIMITS['example']} characters")
        if "claim" in program and type(program["claim"]) is not bool:
            problems.append(f"{where}.claim must be true or false")
        if declared < MANIFEST_VERSION and "example" in program:
            problems.append(f"{where}.example needs manifest {MANIFEST_VERSION}")
        if declared < MANIFEST_VERSION and program.get("claim") is True:
            problems.append(f"{where}.claim needs manifest {MANIFEST_VERSION}")
    return problems, paths


def program_entitlements(plugin, folder):
    declared = plugin.get("entitlements") or {}
    if not declared:
        return {}
    name = plugin["name"]
    if regular_file_in(folder, "plugin.json") is None:
        fail(f"{folder} has no plugin.json for {name}")
    try:
        manifest = json.loads((Path(folder) / "plugin.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fail(f"{name}'s folder has no readable plugin.json")
    if not isinstance(manifest, dict) or manifest.get("name") != name or manifest.get("version") != plugin["version"]:
        fail(f"{folder}/plugin.json isn't the pinned {name} {plugin['version']}")
    given = manifest.get("manifest", 0)
    whole = type(given) is int or (type(given) is float and given.is_integer())
    if not whole or not 0 <= given <= MANIFEST_VERSION:
        fail(f"{folder}/plugin.json has manifest {given!r}, which Ardia refuses: it must be a whole number up to {MANIFEST_VERSION}")
    found, programs = manifest_programs(manifest, int(given))
    problems, paths = program_problems(programs, int(given))
    problems = found + problems
    if problems:
        fail(f"the pin grants {name} entitlements, but its plugin.json's programs are ones Ardia refuses: " + "; ".join(problems))
    for path in declared:
        if path not in paths:
            fail(f"the pin grants {name}'s {path} entitlements, but its plugin.json lists no program at that path")
        info = regular_file_in(folder, path)
        if info is None:
            fail(f"{name}'s {path} isn't a file in its folder spelled exactly that way (a link, another case, or missing)")
        if info.st_nlink != 1 or not info.st_mode & stat.S_IXUSR:
            fail(f"{name}'s {path} must be an executable with no other links to it")
        if not is_macho(Path(folder) / path):
            fail(f"the pin grants {name}'s {path} entitlements, but it isn't a Mach-O program")
    return declared


def plugin_of(pin, name):
    for plugin in pin["plugins"]:
        if plugin["name"] == name:
            return plugin
    fail(f"{name} isn't pinned")


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(source, out):
    if source.startswith("https://"):
        with urllib.request.urlopen(source, timeout=120) as response, open(out, "wb") as handle:
            total = 0
            for chunk in iter(lambda: response.read(1 << 20), b""):
                total += len(chunk)
                if total > LIMIT:
                    fail(f"{source} is over {LIMIT} bytes")
                handle.write(chunk)
    else:
        path = Path(source)
        if not path.is_file() or path.is_symlink():
            fail(f"{source} isn't a file")
        shutil.copyfile(path, out)


def fetch(plugin, key, out, origin=None):
    artifact = plugin["artifacts"].get(key)
    if artifact is None:
        fail(f"{plugin['name']} {plugin['version']} pins no {key} artifact")
    if artifact.get("sha256") is None:
        fail(f"{plugin['name']} {plugin['version']} has no SHA-256 for {artifact['file']}: publish it from its repo, then run official-plugins.py pin {plugin['name']} {plugin['version']}")
    source = str(Path(origin) / artifact["file"]) if origin else f"{plugin['release']}/{artifact['file']}"
    out = Path(out)
    partial = out.with_name(out.name + ".partial")
    download(source, partial)
    got = sha256_of(partial)
    if got != artifact["sha256"]:
        partial.unlink()
        fail(f"{artifact['file']} has SHA-256 {got}, not the pinned {artifact['sha256']}")
    os.replace(partial, out)
    return out


def unpack(archive, dest, top):
    with tarfile.open(archive, "r:gz") as packed:
        members = packed.getmembers()
        for member in members:
            parts = member.name.split("/")
            if member.name.startswith("/") or any(p in ("", ".", "..") for p in parts) or parts[0] != top:
                fail(f"{archive.name}: {member.name!r} isn't inside {top}/")
            if not (member.isfile() or member.isdir()):
                fail(f"{archive.name}: {member.name} is a link or a special file; a bundled plugin has only files and folders")
        staging = Path(tempfile.mkdtemp(prefix=".unpack-", dir=dest.parent))
        try:
            for member in members:
                target = staging / member.name
                if member.isdir():
                    target.mkdir(mode=0o755, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                source = packed.extractfile(member)
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, "wb") as handle:
                    shutil.copyfileobj(source, handle)
                os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
            os.rename(staging / top, dest)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    for path, _, files in os.walk(dest):
        for entry in files:
            if not stat.S_ISREG(os.lstat(os.path.join(path, entry)).st_mode):
                fail(f"{os.path.join(path, entry)} isn't a file")


def bundle(pin, out, origin=None):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for plugin in pin["plugins"]:
        if "macos-arm64" not in plugin["artifacts"]:
            continue
        name = plugin["name"]
        dest = out / name
        if dest.exists() or dest.is_symlink():
            fail(f"{dest} already exists")
        archive = fetch(plugin, "macos-arm64", out / f".{name}.tar.gz", origin)
        try:
            unpack(archive, dest, name)
        finally:
            archive.unlink(missing_ok=True)
        try:
            manifest = json.loads((dest / "plugin.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            fail(f"{name}'s folder has no readable plugin.json")
        if manifest.get("name") != name or manifest.get("version") != plugin["version"]:
            fail(f"{name}'s plugin.json says {manifest.get('name')} {manifest.get('version')}, not the pinned {name} {plugin['version']}")
        program_entitlements(plugin, dest)
        print(f"{name} {plugin['version']}: verified and unpacked into {dest}")
    (out / "program-registry.json").write_text(json.dumps(registry(pin, out), indent=2) + "\n", encoding="utf-8")


def declared_programs(manifest):
    contributes = manifest.get("contributes")
    programs = contributes.get("programs", []) if isinstance(contributes, dict) and "programs" in contributes else manifest.get("programs", [])
    return [p for p in programs if isinstance(p, dict) and isinstance(p.get("name"), str)] if isinstance(programs, list) else []


def claimed_programs(manifest):
    return [p["name"] for p in declared_programs(manifest) if p.get("claim") is True]


def claim(claims, program, owner):
    if not NAME.match(program):
        fail(f"{owner} claims {program!r}, which isn't a program name")
    if program in claims and claims[program] != owner:
        fail(f"{program} is claimed by both {claims[program]} and {owner}")
    claims[program] = owner


def registry(pin, bundled):
    bundled = Path(bundled)
    claims = {}
    owners = {}
    for folder in sorted(bundled.iterdir()) if bundled.is_dir() else []:
        manifest_path = folder / "plugin.json"
        if not folder.is_dir() or folder.is_symlink() or not manifest_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            fail(f"{folder.name}'s folder has no readable plugin.json")
        owners[folder.name] = manifest
        for program in claimed_programs(manifest):
            claim(claims, program, folder.name)
    for plugin in pin["plugins"]:
        for program in plugin.get("reservedPrograms", []):
            manifest = owners.get(plugin["name"])
            if manifest is None:
                fail(f"the pin reserves {program} for {plugin['name']}, which isn't bundled, so the registry would lose the reservation")
            if program not in [p["name"] for p in declared_programs(manifest)]:
                fail(f"the pin reserves {program} for {plugin['name']}, whose bundled plugin.json declares no such program")
            claim(claims, program, plugin["name"])
    legacy = []
    for plugin in pin["plugins"]:
        entry = plugin.get("legacyInstall")
        if not entry:
            continue
        if claims.get(entry["program"]) != plugin["name"]:
            fail(f"{plugin['name']}'s legacyInstall names {entry['program']}, which the registry doesn't give {plugin['name']}")
        legacy.append({"owner": plugin["name"], "program": entry["program"], "root": entry["root"], "current": entry["current"]})
    return {"version": REGISTRY_VERSION, "claims": dict(sorted(claims.items())), "legacyInstalls": legacy}


def verify_registry(pin, bundled, recorded):
    expected = registry(pin, bundled)
    try:
        given = json.loads(recorded)
    except ValueError:
        fail("the recorded program registry isn't JSON")
    for plugin in pin["plugins"]:
        for program in plugin.get("reservedPrograms", []):
            if (given.get("claims") or {}).get(program) != plugin["name"]:
                fail(f"the recorded program registry lost the pin's reservation of {program} for {plugin['name']}")
    if given != expected:
        fail("the recorded program registry doesn't match the signed plugins' claims and the pin's reservations")
    print("program registry: matches")


def linux_cli(pin, app_version, out, origin=None):
    if not VERSION.match(app_version):
        fail(f"bad app version: {app_version}")
    plugin = plugin_of(pin, "cli")
    out = Path(out)
    with tempfile.TemporaryDirectory() as scratch:
        fetched = fetch(plugin, "linux-x64", Path(scratch) / "pinned.tar.gz", origin)
        old, new = f"ardia-cli-{plugin['version']}", f"ardia-cli-{app_version}"
        renamed = lambda name: new + name[len(old):] if name == old or name.startswith(old + "/") else fail(f"{name!r} isn't inside {old}/")
        with tarfile.open(fetched, "r:gz") as source, tarfile.open(out, "w:gz") as target:
            for member in source.getmembers():
                if member.name.startswith("/") or ".." in member.name.split("/"):
                    fail(f"{member.name!r} has an absolute or .. path")
                if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                    fail(f"{member.name} is a special file")
                if member.issym() and (member.linkname.startswith("/") or os.path.normpath(os.path.join(os.path.dirname(member.name), member.linkname)).split("/")[0] != old):
                    fail(f"{member.name} links outside {old}/")
                body = source.extractfile(member) if member.isfile() else None
                member.name = renamed(member.name)
                if member.islnk():
                    member.linkname = renamed(member.linkname)
                target.addfile(member, body)
    Path(f"{out}.sha256").write_text(f"{sha256_of(out)}  {out.name}\n", encoding="ascii")
    print(f"{out}: cli {plugin['version']}, verified, as ardia-cli-{app_version}")


def check(pin):
    for plugin in pin["plugins"]:
        installer = plugin["artifacts"].get("installer")
        if installer and installer.get("sha256") and sha256_of(INSTALLER) != installer["sha256"]:
            fail(f"{INSTALLER.relative_to(ROOT)} isn't {plugin['name']} {plugin['version']}'s install.sh: copy it from that release")
    print(f"{PIN.relative_to(ROOT)}: {len(pin['plugins'])} pinned, {len(pin.get('comingSoon', []))} coming soon")


def write_pin(name, version, origin=None, path=PIN):
    pin = load(path)
    plugin = plugin_of(pin, name)
    plugin["version"] = version
    plugin["release"] = re.sub(r"/[^/]+$", f"/{name}-v{version}", plugin["release"])
    for key, artifact in plugin["artifacts"].items():
        artifact["file"] = re.sub(r"\d+\.\d+\.\d+(-[a-z]+\.\d+)?", version, artifact["file"], count=1) if key != "installer" else artifact["file"]
        with tempfile.TemporaryDirectory() as scratch:
            source = str(Path(origin) / artifact["file"]) if origin else f"{plugin['release']}/{artifact['file']}"
            local = Path(scratch) / artifact["file"]
            download(source, local)
            artifact["sha256"] = sha256_of(local)
    Path(path).write_text(json.dumps(pin, indent=2) + "\n", encoding="utf-8")
    print(f"pinned {name} {version}")


def main():
    parser = argparse.ArgumentParser(description=DESCRIPTION, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pin", default=str(PIN), help="the pin file (default: apps/browser/official-plugins.json)")
    parser.add_argument("--from", dest="origin", help="read artifacts from this folder instead of the release")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check")
    commands.add_parser("describe")
    published = commands.add_parser("published")
    published.add_argument("name")
    published.add_argument("artifact", choices=sorted(ARTIFACTS))
    one = commands.add_parser("fetch")
    one.add_argument("name")
    one.add_argument("artifact", choices=sorted(ARTIFACTS))
    one.add_argument("out")
    every = commands.add_parser("bundle")
    every.add_argument("out")
    registering = commands.add_parser("registry")
    registering.add_argument("bundled")
    verifying = commands.add_parser("verify-registry")
    verifying.add_argument("bundled")
    verifying.add_argument("recorded")
    linux = commands.add_parser("linux-cli")
    linux.add_argument("app_version")
    linux.add_argument("out")
    pinning = commands.add_parser("pin")
    pinning.add_argument("name")
    pinning.add_argument("version")
    inventory = commands.add_parser("machos")
    inventory.add_argument("folder")
    granted = commands.add_parser("entitlements")
    granted.add_argument("name")
    granted.add_argument("folder")
    args = parser.parse_args()
    if args.command == "pin":
        if not VERSION.match(args.version):
            fail(f"bad version: {args.version}")
        return write_pin(args.name, args.version, args.origin, args.pin)
    if args.command == "machos":
        for path in machos(args.folder):
            sys.stdout.write(path + "\0")
        return
    pin = load(args.pin)
    if args.command == "check":
        return check(pin)
    if args.command == "published":
        artifact = plugin_of(pin, args.name)["artifacts"].get(args.artifact) or {}
        sys.exit(0 if artifact.get("sha256") else 1)
    if args.command == "describe":
        for plugin in pin["plugins"]:
            print(f"plugin {plugin['name']} {plugin['version']} {(plugin['artifacts'].get('macos-arm64') or {}).get('sha256')}")
        return
    if args.command == "fetch":
        fetch(plugin_of(pin, args.name), args.artifact, args.out, args.origin)
        return print(f"{args.out}: verified")
    if args.command == "verify-registry":
        return verify_registry(pin, args.bundled, args.recorded)
    if args.command == "registry":
        return print(json.dumps(registry(pin, args.bundled), separators=(",", ":")))
    if args.command == "entitlements":
        plugin = next((p for p in pin["plugins"] if p["name"] == args.name), None)
        for path, keys in (program_entitlements(plugin, args.folder) if plugin else {}).items():
            print(f"{path}\t{' '.join(sorted(keys))}")
        return
    if args.command == "linux-cli":
        return linux_cli(pin, args.app_version, args.out, args.origin)
    bundle(pin, args.out, args.origin)


if __name__ == "__main__":
    main()
