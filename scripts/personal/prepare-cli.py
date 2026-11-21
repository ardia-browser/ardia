import argparse
import fcntl
import os
import re
import runpy
from hashlib import sha256
from pathlib import Path
import subprocess
import tempfile

from lifecycle import cli_inputs, read_json, runtime_digest, write_json


def replace_once(path, old, new):
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Upstream layout changed in {path.name}")
    path.write_text(text.replace(old, new))


def personalize(runtime):
    (package,) = (runtime / "python/lib").glob("python*/site-packages/ardia_cli")
    replace_once(package / "browse/vault.py", 'SERVICE = "dev.ardia.browse.auth"', 'SERVICE = "dev.simon.ardia.personal.browse.auth"')
    replace_once(package / "endpoint.py", '/ "com.ardia.browser"', '/ "dev.simon.ardia.personal"')
    replace_once(package / "config_files.py", 'endpoint.INSTALLED_DATA_DIR / "config" if endpoint.LINUX else Path.home() / ".config" / "ardia"', 'endpoint.INSTALLED_DATA_DIR / "config"')
    replace_once(package / "usage.py", '/ "Ardia" / "CLI"', '/ "Ardia Personal" / "CLI"')
    replace_once(package / "computer.py", '/ ".local" / "bin"', '/ "Library" / "Application Support" / "Ardia Personal" / "bin"')
    replace_once(package / "computer.py", 'APPLICATIONS = Path("/Applications")', 'APPLICATIONS = Path.home() / "Applications" / "Ardia Personal Tools"')
    replace_once(package / "computer.py", '    if not os.access(APPLICATIONS, os.W_OK):', '    APPLICATIONS.mkdir(parents=True, exist_ok=True)\n    if not os.access(APPLICATIONS, os.W_OK):')
    for path in (package / "skill").rglob("*.md"):
        text = path.read_text()
        text = re.sub(r"(?<![\w./-])ardia(?=:\*|[ \n]+(?:apply|browse|call|commands?|computer|config|events|feedback|groups|history|hooks|methods|notes|on|pinned|run|scripts|skills|tabs|theme|windows|--version)\b)", "ardia-personal", text)
        text = text.replace("name: ardia-personal", "name: ardia")
        path.write_text(text)


def main():
    parser = argparse.ArgumentParser(description="Prepare a separate personal CLI runtime.")
    parser.add_argument("--install", action="store_true", help="Add ~/.local/bin/ardia-personal without changing ardia")
    parser.add_argument("--prepare-only", action="store_true", help="Build and verify without switching the active CLI")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    output = repo / "apps/browser/build-personal-cli"
    output.mkdir(exist_ok=True)
    with (output / ".prepare.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = cli_inputs(repo)
        release_tools = runpy.run_path(str(repo / "scripts/release/official-plugins.py"))
        plugin = release_tools["plugin_of"](release_tools["load"](), "cli")
        version = plugin["version"]
        pinned_digest = plugin["artifacts"]["macos-arm64"]["sha256"]
        digest = sha256(f"{pinned_digest}:{source}".encode()).hexdigest()
        runtime = output / digest
        metadata = output / f"{digest}.json"
        if not runtime.exists():
            with tempfile.TemporaryDirectory(prefix=".extract-", dir=output) as scratch:
                scratch = Path(scratch)
                archive = release_tools["fetch"](plugin, "macos-arm64", scratch / "cli.tar.gz")
                extracted = scratch / "runtime"
                release_tools["unpack"](archive, extracted, "cli")
                personalize(extracted)
                actual = subprocess.check_output([extracted / "bin/ardia", "--version"], text=True).strip()
                if actual != f"ardia {version}":
                    raise RuntimeError(f"Expected ardia {version}, got {actual}")
                if cli_inputs(repo) != source:
                    raise RuntimeError("CLI inputs changed during preparation")
                write_json(metadata, {"runtime_digest": runtime_digest(extracted)})
                extracted.rename(runtime)
        verified = read_json(metadata)
        if runtime_digest(runtime) != verified["runtime_digest"]:
            raise RuntimeError("Personal CLI runtime changed; do not activate it")
        selection = {"source": source, "version": version, "archive": digest, "upstream_sha256": pinned_digest, **verified}
        write_json(output / "prepared.json", selection)
        if not args.prepare_only:
            current = output / "current"
            if current.exists() and not current.is_symlink():
                raise RuntimeError("The personal CLI current path is not a symlink")
            with tempfile.TemporaryDirectory(prefix=".activate-", dir=output) as activation:
                staged = Path(activation) / "current"
                staged.symlink_to(runtime.name)
                staged.replace(current)
        if args.install:
            command = Path.home() / ".local/bin/ardia-personal"
            target = repo / "scripts/personal/ardia-personal"
            if os.path.lexists(command):
                if not command.is_symlink() or command.resolve() != target:
                    raise RuntimeError(f"Refusing to replace {command}")
            else:
                command.parent.mkdir(parents=True, exist_ok=True)
                command.symlink_to(target)
            print(f"command: {command}")
        print(f"runtime: {runtime}")


if __name__ == "__main__":
    main()
