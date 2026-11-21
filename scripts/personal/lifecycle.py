import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile


BUNDLE_ID = "dev.simon.ardia.personal"
ARTIFACT_PATHS = ["Contents/MacOS/Ardia", "Contents/Resources/main.jsbundle", "Contents/Info.plist", "Contents/Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework"]


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, timeout=kwargs.pop("timeout", 30), **kwargs)


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")
    temporary.replace(path)


def file_digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def inputs_digest(repo, paths, include_docs=False):
    names = run("git", "-C", repo, "ls-files", "-co", "--exclude-standard", "-z", "--", *paths, capture_output=True).stdout.split(b"\0")
    digest = hashlib.sha256()
    for raw in sorted(set(names) - {b""}):
        name = os.fsdecode(raw)
        path = repo / name
        if "__pycache__" in path.parts or ".test." in name or (name.endswith(".md") and not include_docs):
            continue
        if path.is_symlink():
            content = b"link\0" + os.fsencode(os.readlink(path))
        elif path.is_file():
            content = b"file\0" + str(path.stat().st_mode & 0o111).encode() + b"\0" + path.read_bytes()
        elif not path.exists():
            content = b"deleted\0"
        else:
            continue
        digest.update(raw + b"\0" + hashlib.sha256(content).digest())
    return digest.hexdigest()


def app_inputs(repo):
    return inputs_digest(repo, ["apps/browser", "packages", "engine", "patches", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "babel.config.js", "scripts/lib", "scripts/agent/build-app", "scripts/personal/build-app.py", "scripts/personal/lifecycle.py", "scripts/personal/unlock-signing-keychain.swift"])


def cli_inputs(repo):
    return inputs_digest(repo, ["apps/browser/official-plugins.json", "scripts/release/official-plugins.py", "scripts/personal/prepare-cli.py", "scripts/personal/ardia-personal", "scripts/personal/lifecycle.py"])


def artifact(app):
    return {name: file_digest(app / name) for name in ARTIFACT_PATHS}


def reusable_release(repo, app, record, engine):
    return record.get("schema") == 1 and record.get("inputs") == app_inputs(repo) and record.get("engine") == engine and all((app / name).is_file() for name in ARTIFACT_PATHS) and record.get("artifact") == artifact(app)


def verify_unsigned(repo, app, record, engine):
    if record.get("schema") != 1 or record.get("inputs") != app_inputs(repo) or record.get("engine") != engine:
        raise RuntimeError("Release inputs changed; build again without --sign-only")
    if record.get("artifact") != artifact(app):
        raise RuntimeError("Release files changed since the recorded build; rebuild the app")


def validate_candidate(info, certificate):
    expected = {"CFBundleIdentifier": BUNDLE_ID, "ACPersonalBuild": True, "ACPersonalSafeStorage": "shared-ardia", "ACPersonalSigningCertificateSHA1": certificate, "SUEnableAutomaticChecks": False, "SUAutomaticallyUpdate": False}
    if any(key not in info or info[key] != value for key, value in expected.items()):
        raise RuntimeError("Personal identity, storage, or updater configuration is invalid")
    if any(key in info for key in ["SUFeedURL", "SUPublicEDKey", "CFBundleDocumentTypes"]):
        raise RuntimeError("An upstream updater or document handler remains configured")
    schemes = [scheme for entry in info.get("CFBundleURLTypes", []) for scheme in entry["CFBundleURLSchemes"]]
    if sorted(schemes) != ["http", "https"]:
        raise RuntimeError("The personal app must register only HTTP and HTTPS")


def tree_layout(root, timestamps=False):
    result = {}
    for path in sorted(root.rglob("*")):
        info = path.lstat()
        name = str(path.relative_to(root))
        if stat.S_ISLNK(info.st_mode):
            value = ["link", os.readlink(path)]
        elif stat.S_ISREG(info.st_mode):
            value = ["file", info.st_size]
        elif stat.S_ISDIR(info.st_mode):
            value = ["directory"]
        else:
            raise RuntimeError("A socket or special file remains in the profile; check browser shutdown")
        if timestamps:
            value.append(info.st_mtime_ns)
        result[name] = value
    return result


def runtime_digest(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if "__pycache__" in path.parts or ".leases" in path.parts:
            continue
        if path.is_symlink():
            value = "link:" + os.readlink(path)
        elif path.is_file():
            value = str(path.stat().st_mode & 0o111) + ":" + file_digest(path)
        else:
            continue
        digest.update(str(path.relative_to(root)).encode() + b"\0" + value.encode())
    return digest.hexdigest()


def snapshot_profile(profile, destination, preferences):
    if profile.is_symlink() or destination.exists():
        raise RuntimeError("Refusing a profile symlink or an existing backup destination")
    destination.mkdir(parents=True, mode=0o700)
    try:
        before = None
        if profile.exists():
            before = tree_layout(profile, timestamps=True)
            run("cp", "-cRp", profile, destination / "profile", timeout=180)
            if tree_layout(profile) != tree_layout(destination / "profile") or before != tree_layout(profile, timestamps=True):
                raise RuntimeError("Profile changed or backup is incomplete")
        (destination / "preferences.plist").write_bytes(preferences)
        write_json(destination / "snapshot.json", {"schema": 1, "profile_present": profile.exists(), "source_layout": before})
    except BaseException:
        (destination / "INCOMPLETE").touch()
        raise
