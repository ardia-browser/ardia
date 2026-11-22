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
ARTIFACTS = {"macos-arm64": "the plugin folder Ardia fetches on Install on macOS", "linux-x64": "the command's tarball Linux installs", "installer": "install.sh"}
LIMIT = 512 * 1024 * 1024
KNOWN_LEGACY_ROOTS = {"Library/Application Support/Ardia/CLI"}
COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
ANCHOR = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,39}$")
REGISTRY_VERSION = 1
DESCRIPTION = """Reads and verifies the official plugins pinned in apps/browser/official-plugins.json. Ardia doesn't bundle them:
Install fetches the pinned macos-arm64 artifact and checks it against the pin the app is signed with. Every byte a
script takes from a release goes through fetch(), which refuses an artifact whose SHA-256 isn't the pinned one.

  check                         the pin file is well formed, and apps/cli/install.sh is the pinned installer
  published <name> <artifact>   exits 0 when that artifact has a pinned SHA-256, 1 while it isn't published yet
  describe                      one provenance line per pinned plugin: name, version and the macOS folder's SHA-256
  fetch <name> <artifact> <out> one pinned artifact (macos-arm64, linux-x64 or installer), verified
  fixtures <out dir>            every published macos-arm64 artifact, verified, under its own file name: the local
                                copy the release smoke hands a hidden instance (ARDIA_INSTANCE officialPluginsFrom)
  signed-pin                    prints the pin as export-sign.sh puts it in Info.plist (ArdiaOfficialPlugins): the
                                file itself, less artifacts that aren't published yet
  registry                      prints the program registry (reserved names, legacy installs) the pin implies, the
                                JSON export-sign.sh puts in Info.plist as ArdiaProgramRegistry
  verify-registry <json>        checks a recorded registry against the pin
  pin <name> <version>          writes the SHA-256s of <version>'s artifacts into the pin file
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
    for index, soon in enumerate(pin.get("comingSoon", [])):
        if not isinstance(soon, dict) or not all(isinstance(soon.get(k), str) and soon[k] for k in ("name", "title", "blurb", "icon", "experiment")):
            problems.append(f"comingSoon[{index}] needs name, title, blurb, icon and experiment")
    return problems


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


def fixtures(pin, out, origin=None):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for plugin in pin["plugins"]:
        artifact = plugin["artifacts"].get("macos-arm64")
        if not artifact or not artifact.get("sha256"):
            continue
        fetch(plugin, "macos-arm64", out / artifact["file"], origin)
        print(f"{plugin['name']} {plugin['version']}: {artifact['file']} verified")


def macos_plugins(pin):
    return [p for p in pin["plugins"] if (p["artifacts"].get("macos-arm64") or {}).get("sha256")]


def signed_pin(pin):
    signed = json.loads(json.dumps(pin))
    for plugin in signed["plugins"]:
        plugin["artifacts"] = {k: v for k, v in plugin["artifacts"].items() if v.get("sha256")}
    return signed


def registry(pin):
    claims = {}
    legacy = []
    for plugin in macos_plugins(pin):
        for program in plugin.get("reservedPrograms", []):
            if program in claims:
                fail(f"{program} is reserved by both {claims[program]} and {plugin['name']}")
            claims[program] = plugin["name"]
        entry = plugin.get("legacyInstall")
        if entry:
            legacy.append({"owner": plugin["name"], "program": entry["program"], "root": entry["root"], "current": entry["current"]})
    return {"version": REGISTRY_VERSION, "claims": dict(sorted(claims.items())), "legacyInstalls": legacy}


def verify_registry(pin, recorded):
    expected = registry(pin)
    try:
        given = json.loads(recorded)
    except ValueError:
        fail("the recorded program registry isn't JSON")
    for plugin in macos_plugins(pin):
        for program in plugin.get("reservedPrograms", []):
            if (given.get("claims") or {}).get(program) != plugin["name"]:
                fail(f"the recorded program registry lost the pin's reservation of {program} for {plugin['name']}")
    if given != expected:
        fail("the recorded program registry doesn't match the pin's reservations and legacy installs")
    print("program registry: matches the pin")


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
    every = commands.add_parser("fixtures")
    every.add_argument("out")
    commands.add_parser("signed-pin")
    commands.add_parser("registry")
    verifying = commands.add_parser("verify-registry")
    verifying.add_argument("recorded")
    linux = commands.add_parser("linux-cli")
    linux.add_argument("app_version")
    linux.add_argument("out")
    pinning = commands.add_parser("pin")
    pinning.add_argument("name")
    pinning.add_argument("version")
    args = parser.parse_args()
    if args.command == "pin":
        if not VERSION.match(args.version):
            fail(f"bad version: {args.version}")
        return write_pin(args.name, args.version, args.origin, args.pin)
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
        return verify_registry(pin, args.recorded)
    if args.command == "registry":
        return print(json.dumps(registry(pin), separators=(",", ":")))
    if args.command == "signed-pin":
        return print(json.dumps(signed_pin(pin), separators=(",", ":"), ensure_ascii=False))
    if args.command == "linux-cli":
        return linux_cli(pin, args.app_version, args.out, args.origin)
    fixtures(pin, args.out, args.origin)


if __name__ == "__main__":
    main()
