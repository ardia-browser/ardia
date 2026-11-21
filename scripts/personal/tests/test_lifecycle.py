import importlib.util
import json
import os
from pathlib import Path
import plistlib
import socket
import io
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lifecycle


def module(path):
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ardia-lifecycle-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        (self.repo / ".gitignore").write_text("apps/browser/build-*\n__pycache__/\n")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def put(self, name, value, root=None):
        path = (root or self.repo) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value if isinstance(value, bytes) else value.encode())
        return path

    def test_source_edits_invalidate_build_but_docs_do_not(self):
        self.put("apps/browser/index.js", "one")
        original = lifecycle.app_inputs(self.repo)
        self.put("docs/notes.md", "new instructions")
        self.assertEqual(lifecycle.app_inputs(self.repo), original)
        self.put("apps/browser/index.js", "two")
        self.assertNotEqual(lifecycle.app_inputs(self.repo), original)
        self.put("packages/core/new.ts", "export const changed = true;")
        self.assertNotEqual(lifecycle.app_inputs(self.repo), original)
        tracked = self.put("apps/browser/deleted.js", "deleted")
        subprocess.run(["git", "-C", str(self.repo), "add", "apps/browser/deleted.js"], check=True)
        before = lifecycle.app_inputs(self.repo)
        tracked.unlink()
        self.assertNotEqual(lifecycle.app_inputs(self.repo), before)

    def test_pin_and_personalization_changes_invalidate_the_cli(self):
        for path in ("apps/browser/official-plugins.json", "scripts/personal/prepare-cli.py", "scripts/personal/ardia-personal"):
            with self.subTest(path=path):
                self.put(path, "before")
                before = lifecycle.cli_inputs(self.repo)
                self.put(path, "after")
                self.assertNotEqual(lifecycle.cli_inputs(self.repo), before)

    def test_sign_only_rejects_modified_program_files(self):
        self.put("apps/browser/index.js", "source")
        app = self.root / "app"
        for name in ["Contents/MacOS/Ardia", "Contents/Resources/main.jsbundle", "Contents/Info.plist", "Contents/Frameworks/Chromium Framework.framework/Versions/Current/Chromium Framework"]:
            self.put(name, "original", root=app)
        record = {"schema": 1, "inputs": lifecycle.app_inputs(self.repo), "engine": {"binary": "original"}, "artifact": lifecycle.artifact(app)}
        self.assertTrue(lifecycle.reusable_release(self.repo, app, record, {"binary": "original"}))
        lifecycle.verify_unsigned(self.repo, app, record, {"binary": "original"})
        self.put("Contents/Resources/main.jsbundle", "changed", root=app)
        self.assertFalse(lifecycle.reusable_release(self.repo, app, record, {"binary": "original"}))
        with self.assertRaisesRegex(RuntimeError, "Release files changed"):
            lifecycle.verify_unsigned(self.repo, app, record, {"binary": "original"})
        with self.assertRaisesRegex(RuntimeError, "Release inputs changed"):
            lifecycle.verify_unsigned(self.repo, app, record, {"binary": "other"})

    @unittest.skipUnless(sys.platform == "darwin", "APFS clone test")
    def test_snapshot_keeps_an_independent_profile_and_preferences(self):
        profile = self.root / "profile"
        self.put("Chromium/Cookies", b"old encrypted data", root=profile)
        self.put("config/settings.json", '{"enabled":true}', root=profile)
        (profile / "relative-link").symlink_to("config/settings.json")
        backup = self.root / "backup"
        preferences = plistlib.dumps({"appearance": "dark"})
        lifecycle.snapshot_profile(profile, backup, preferences)
        self.put("Chromium/Cookies", b"new encrypted data", root=profile)
        self.assertEqual((backup / "profile/Chromium/Cookies").read_bytes(), b"old encrypted data")
        self.assertEqual((backup / "preferences.plist").read_bytes(), preferences)
        self.assertEqual(os.readlink(backup / "profile/relative-link"), "config/settings.json")
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        with self.assertRaises(RuntimeError):
            lifecycle.snapshot_profile(profile, backup, preferences)

    def test_runtime_integrity_ignores_leases_but_detects_changed_code(self):
        runtime = self.root / "runtime"
        self.put("bin/ardia", "executable", root=runtime)
        digest = lifecycle.runtime_digest(runtime)
        self.put(".leases/live", "pid", root=runtime)
        self.assertEqual(lifecycle.runtime_digest(runtime), digest)
        self.put("bin/ardia", "changed", root=runtime)
        self.assertNotEqual(lifecycle.runtime_digest(runtime), digest)
        executable = runtime / "bin/ardia"
        before = lifecycle.runtime_digest(runtime)
        executable.chmod(0o755)
        self.assertNotEqual(lifecycle.runtime_digest(runtime), before)

    @unittest.skipUnless(sys.platform == "darwin", "macOS installer")
    def test_installer_backups_and_failure_restore_app_and_cli(self):
        installer = module(Path(__file__).resolve().parents[1] / "install-app.py")
        installer.__file__ = str(self.repo / "scripts/personal/install-app.py")
        home = self.root / "home"
        source = self.repo / "apps/browser/build-personal-signed/Ardia Personal.app"
        destination = home / "Applications/Ardia Personal.app"
        profile = home / "Library/Application Support/dev.simon.ardia.personal"
        runtime = self.repo / "apps/browser/build-personal-cli" / ("a" * 64)
        info = {"CFBundleIdentifier": lifecycle.BUNDLE_ID, "ACPersonalBuild": True, "ACPersonalSafeStorage": "shared-ardia", "ACPersonalSigningCertificateSHA1": "11" * 20, "SUEnableAutomaticChecks": False, "SUAutomaticallyUpdate": False, "CFBundleURLTypes": [{"CFBundleURLSchemes": ["http", "https"]}]}
        for app, value in [(source, "new"), (destination, "old")]:
            self.put("Contents/Info.plist", plistlib.dumps(info), root=app)
            self.put("Contents/MacOS/Ardia", value, root=app)
        self.put("bin/ardia", "new-cli", root=runtime)
        (runtime / "bin/ardia").chmod(0o755)
        old_runtime = runtime.parent / "old-runtime"
        self.put("bin/ardia", "old-cli", root=old_runtime)
        (runtime.parent / "current").symlink_to(old_runtime.name)
        self.put("Chromium/Cookies", "original-cookies", root=profile)
        build = {"schema": 1, "inputs": lifecycle.app_inputs(self.repo), "cli": {"archive": runtime.name, "source": lifecycle.cli_inputs(self.repo), "runtime_digest": lifecycle.runtime_digest(runtime)}}
        lifecycle.write_json(source / "Contents/Resources/personal-build.json", build)
        actual_run = installer.run
        fail_registration = True
        mutate_profile = False

        def external(*args, **kwargs):
            if str(args[0]) == "ps":
                return subprocess.CompletedProcess(args, 0, stdout="")
            if str(args[0]) == "/usr/bin/openssl":
                return subprocess.CompletedProcess(args, 0, stdout="sha1 Fingerprint=" + "11" * 20)
            if str(args[0]) == "codesign":
                return subprocess.CompletedProcess(args, 0)
            if str(args[0]).endswith("lsregister"):
                if fail_registration and args[1] == "-f" and (destination / "Contents/MacOS/Ardia").read_text() == "new":
                    raise RuntimeError("registration failed")
                return subprocess.CompletedProcess(args, 0)
            result = actual_run(*args, **kwargs)
            if mutate_profile and str(args[0]) == "cp" and ".ardia-personal-" in str(args[-1]):
                (profile / "Chromium/Cookies").write_text("changed while preparing installation")
            return result

        with mock.patch.object(installer.Path, "home", return_value=home), mock.patch.object(installer, "run", side_effect=external):
            with self.assertRaisesRegex(RuntimeError, "registration failed"):
                installer.main()
            self.assertEqual((destination / "Contents/MacOS/Ardia").read_text(), "old")
            self.assertEqual(os.readlink(runtime.parent / "current"), old_runtime.name)
            self.assertEqual((profile / "Chromium/Cookies").read_text(), "original-cookies")
            fail_registration = False
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                installer.main()
            self.assertEqual((destination / "Contents/MacOS/Ardia").read_text(), "new")
            self.assertEqual(os.readlink(runtime.parent / "current"), runtime.name)
            updates = home / "Library/Application Support/Ardia Personal/Updates"
            snapshots = list(updates.glob("*/update.json"))
            self.assertEqual({json.loads(path.read_text())["state"] for path in snapshots}, {"installed", "failed"})
            for path in snapshots:
                self.assertEqual((path.parent / "profile/Chromium/Cookies").read_text(), "original-cookies")
            with self.assertRaisesRegex(RuntimeError, "configuration is invalid"):
                lifecycle.validate_candidate({**info, "SUEnableAutomaticChecks": True}, "11" * 20)
            before = (destination / "Contents/MacOS/Ardia").read_bytes()
            with mock.patch.object(installer, "snapshot_profile", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    installer.main()
            self.assertEqual((destination / "Contents/MacOS/Ardia").read_bytes(), before)
            mutate_profile = True
            with self.assertRaisesRegex(RuntimeError, "profile changed after its backup"):
                installer.main()
            self.assertEqual((destination / "Contents/MacOS/Ardia").read_bytes(), before)
            self.assertEqual((profile / "Chromium/Cookies").read_text(), "changed while preparing installation")
            self.put("apps/browser/new.js", "changed")
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                installer.main()
            self.assertEqual((destination / "Contents/MacOS/Ardia").read_bytes(), before)

    def test_socket_prevents_an_incomplete_profile_backup(self):
        profile = self.root / "profile"
        profile.mkdir()
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(str(profile / "live.sock"))
            with self.assertRaisesRegex(RuntimeError, "socket or special file"):
                lifecycle.tree_layout(profile)

    def test_unregistration_accepts_only_an_already_missing_handler(self):
        installer = module(Path(__file__).resolve().parents[1] / "install-app.py")
        missing = subprocess.CalledProcessError(1, "lsregister", output="failed to scan app: -10814\n")
        with mock.patch.object(installer, "run", side_effect=missing):
            installer.unregister("registry", Path("unregistered.app"))
        broken = subprocess.CalledProcessError(1, "lsregister", output="unexpected registry failure")
        with mock.patch.object(installer, "run", side_effect=broken):
            with self.assertRaises(subprocess.CalledProcessError):
                installer.unregister("registry", Path("broken.app"))


if __name__ == "__main__":
    unittest.main()
