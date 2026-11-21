import argparse
import fcntl
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

from lifecycle import app_inputs, artifact, cli_inputs, file_digest, read_json, reusable_release, run as command, verify_unsigned, write_json


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def ensure_stopped(app):
    binary = str(app / "Contents/MacOS/Ardia")
    processes = run(["ps", "-ww", "-ax", "-o", "command="], capture_output=True, text=True).stdout
    if any(line == binary or line.startswith(binary + " ") for line in processes.splitlines()):
        raise RuntimeError("Quit the personal test app before replacing its build")


def main():
    parser = argparse.ArgumentParser(description="Build and locally sign Ardia Personal for isolated testing.")
    parser.add_argument("--password-file", type=Path, help="Private file holding the signing keychain password")
    parser.add_argument("--sign-only", action="store_true", help="Sign the existing Release build without rebuilding")
    parser.add_argument("--install", action="store_true", help="Install the signed build in ~/Applications")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    signing = Path.home() / "Library/Application Support/Ardia Personal/Signing"
    keychain = signing / "signing.keychain-db"
    certificate = signing / "certificate.pem"
    for path in [keychain, certificate]:
        if not path.is_file():
            raise FileNotFoundError(path)
    fingerprint = run(["/usr/bin/openssl", "x509", "-in", certificate, "-noout", "-fingerprint", "-sha1"], capture_output=True, text=True).stdout.strip()
    identity = fingerprint.split("=", 1)[1].replace(":", "")
    if not re.fullmatch(r"[0-9A-Fa-f]{40}", identity):
        raise ValueError("Certificate fingerprint is not a SHA-1 signing identity")
    output = repo / "apps/browser/build-personal-signed"
    output.mkdir(exist_ok=True)
    app = output / "Ardia Personal.app"
    with (output / ".build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        ensure_stopped(app)
        config = output / "Release.xcconfig"
        config.write_text(f'#include "{repo}/apps/browser/macos/AdHoc.xcconfig"\nARCHS = arm64\nONLY_ACTIVE_ARCH = YES\n')
        framework = os.environ.get("ARDIACORE_FRAMEWORK")
        key = repo / "engine/engine-key.sh"
        key_paths = command(key, "--paths", capture_output=True, text=True).stdout.splitlines()
        staged = subprocess.run(["git", "-C", str(repo), "diff", "--cached", "--quiet", "--", *key_paths], check=False).returncode
        if staged not in (0, 1):
            raise RuntimeError("Cannot inspect staged engine sources")
        engine_ref = command("git", "-C", repo, "write-tree", capture_output=True, text=True).stdout.strip() if staged else "HEAD"
        if not framework:
            fetch_args = [repo / "packages/ardiacore/scripts/fetch-engine.sh"] + (["--staged"] if staged else [])
            framework = command(*fetch_args, capture_output=True, text=True, timeout=180).stdout.strip()
        engine = {"key": command(key, engine_ref, capture_output=True, text=True).stdout.strip(), "tree": command("git", "-C", repo, "rev-parse", f"{engine_ref}:engine", capture_output=True, text=True).stdout.strip(), "binary": file_digest(Path(framework) / "Versions/Current/Chromium Framework")}
        inputs = app_inputs(repo)
        source = repo / "apps/browser/build-personal/Build/Products/Release/Ardia.app"
        stamp = output / "unsigned-build.json"
        if args.sign_only and not stamp.is_file():
            raise RuntimeError("No recorded Release build; run without --sign-only once")
        reusable = stamp.is_file() and reusable_release(repo, source, read_json(stamp), engine)
        if not args.sign_only and not reusable:
            run([repo / "scripts/agent/build-app", "--as", "personal", "--config", "Release", "--wait", "120"], cwd=repo, env={**os.environ, "XCODE_XCCONFIG_FILE": str(config), "ARDIACORE_FRAMEWORK": framework})
            if app_inputs(repo) != inputs:
                raise RuntimeError("App sources changed during the build; build again")
            write_json(stamp, {"schema": 1, "inputs": inputs, "engine": engine, "artifact": artifact(source)})
        elif reusable:
            print("Release inputs and program files are unchanged; reusing the existing build.")
        verify_unsigned(repo, source, read_json(stamp), engine)
        run(["codesign", "--verify", "--deep", "--strict", source], timeout=30)
        if not (source / "Contents/Resources/main.jsbundle").is_file():
            raise RuntimeError("No standalone Release bundle; run without --sign-only")
        run([sys.executable, repo / "scripts/personal/prepare-cli.py", "--prepare-only"])
        cli = read_json(repo / "apps/browser/build-personal-cli/prepared.json")
        if cli["source"] != cli_inputs(repo):
            raise RuntimeError("CLI sources changed after preparation; prepare the build again")
        helper = output / "unlock-signing-keychain"
        run(["swiftc", "-suppress-warnings", repo / "scripts/personal/unlock-signing-keychain.swift", "-framework", "Security", "-o", helper])
        unlock = [helper, keychain]
        if args.password_file:
            unlock.append(args.password_file.resolve(strict=True))
        run(unlock, timeout=20)
        try:
            with tempfile.TemporaryDirectory(prefix=".sign-", dir=output) as temporary:
                candidate = Path(temporary) / app.name
                run(["cp", "-cR", source, candidate])
                (candidate / "Contents/Resources/ardia-cli-install.sh").unlink(missing_ok=True)
                info_path = candidate / "Contents/Info.plist"
                with info_path.open("rb") as stream:
                    info = plistlib.load(stream)
                info.update(CFBundleIdentifier="dev.simon.ardia.personal", CFBundleDisplayName="Ardia Personal", CFBundleName="Ardia Personal", ACPersonalBuild=True, ACPersonalSafeStorage="shared-ardia", ACPersonalSigningCertificateSHA1=identity, SUEnableAutomaticChecks=False, SUAutomaticallyUpdate=False)
                info["CFBundleURLTypes"] = [dict(CFBundleURLName="dev.simon.ardia.personal.web", CFBundleURLSchemes=["http", "https"])]
                for key in ["SUFeedURL", "SUPublicEDKey", "CFBundleDocumentTypes"]:
                    info.pop(key, None)
                with info_path.open("wb") as stream:
                    plistlib.dump(info, stream)
                record = {"schema": 1, "inputs": inputs, "engine": engine, "cli": cli, "commit": command("git", "-C", repo, "rev-parse", "HEAD", capture_output=True, text=True).stdout.strip(), "dirty": bool(command("git", "-C", repo, "status", "--porcelain", capture_output=True, text=True).stdout), "certificate": identity}
                write_json(candidate / "Contents/Resources/personal-build.json", record)
                verify_unsigned(repo, source, read_json(stamp), engine)
                run(["codesign", "--force", "--sign", identity, "--keychain", keychain, "--timestamp=none", candidate], timeout=30)
                run(["codesign", "--verify", "--deep", "--strict", candidate], timeout=30)
                ensure_stopped(app)
                previous = output / "Ardia Personal.previous.app"
                ensure_stopped(previous)
                if previous.exists():
                    shutil.rmtree(previous)
                if app.exists():
                    app.rename(previous)
                candidate.rename(app)
        finally:
            run(["security", "lock-keychain", keychain], timeout=10)
    print(f"app: {app}")
    print("Uses the shared Ardia Safe Storage item with a separate personal profile. Use ardia-personal for this build.")
    if args.install:
        run([sys.executable, repo / "scripts/personal/install-app.py"])


if __name__ == "__main__":
    main()
