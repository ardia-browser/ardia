import contextlib
import importlib.util
import io
import json
import lzma
import os
import re
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ENGINE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ENGINE))
import series_base  # noqa: E402

spec = importlib.util.spec_from_file_location("series_zero_fuzz", ENGINE / "series-zero-fuzz.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
spec = importlib.util.spec_from_file_location("series_base_pack", ENGINE / "series-base-pack.py")
packer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packer)
spec = importlib.util.spec_from_file_location("run_step3", ENGINE / "run-step3.py")
step3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(step3)
spec = importlib.util.spec_from_file_location("run_capture", ENGINE / "run-capture.py")
capturer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capturer)

ORIGINAL = "".join(f"line {n}\n" for n in range(1, 41))


class FakeStep:
    def __init__(self, name, patch, kind="chromium", line=1):
        self.kind, self.name, self.patch, self.line = kind, name, patch, line

    def paths(self):
        return [(p, False) for p in sorted(touched_paths(self.patch))]

    def created(self):
        text = pathlib.Path(self.patch).read_text()
        out, new = set(), False
        for raw in text.splitlines():
            if raw.startswith("--- "):
                new = raw.strip() == "--- /dev/null"
            if raw.startswith("+++ b/") and new:
                out.add(raw[6:])
        return out


def touched_paths(patch):
    return {raw[6:] for raw in pathlib.Path(patch).read_text().splitlines() if raw.startswith("+++ b/")}


def make_patch(directory, name, path, before, after):
    a, b = os.path.join(directory, "a", path), os.path.join(directory, "b", path)
    for full, text in ((a, before), (b, after)):
        os.makedirs(os.path.dirname(full), exist_ok=True)
        pathlib.Path(full).write_text(text)
    diff = subprocess.run(["git", "diff", "--no-index", "--no-prefix", "a/" + path, "b/" + path], cwd=directory,
                          capture_output=True, text=True).stdout
    out = os.path.join(directory, name)
    pathlib.Path(out).write_text(diff)
    return out


def edited(text, **changes):
    lines = text.splitlines(keepends=True)
    for index, value in changes.items():
        lines[int(index[1:]) - 1] = value
    return "".join(lines)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ac-zero-fuzz-test-")
        self.tree = os.path.join(self.dir, "tree")
        os.makedirs(os.path.join(self.tree, "chrome"))
        self.patches = os.path.join(self.dir, "patches")
        os.makedirs(self.patches)

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def patch(self, name, path="chrome/f.cc", before=ORIGINAL, after=None):
        after = after if after is not None else edited(before, l20="line twenty\n")
        return FakeStep(name, make_patch(os.path.join(self.patches, name + ".d"), name, path, before, after))

    def write_tree(self, text, path="chrome/f.cc"):
        pathlib.Path(self.tree, path).write_text(text)

    def run_tree(self, steps):
        return checker.check_tree(steps, self.tree, report=None)


class StrictApply(Fixture):
    def test_clean_patch_passes(self):
        step = self.patch("clean")
        self.write_tree(ORIGINAL)
        [result] = self.run_tree([step])
        self.assertTrue(result.ok)
        self.assertEqual(result.offsets, [])
        self.assertIn("line twenty\n", pathlib.Path(self.tree, "chrome/f.cc").read_text())

    def test_offset_fails(self):
        step = self.patch("offset")
        self.write_tree("extra a\nextra b\nextra c\n" + ORIGINAL)
        [result] = self.run_tree([step])
        self.assertEqual(result.offsets, [("chrome/f.cc", 1, 20, 3)])
        failing, warned, moves = checker.judge([("linux", [result])], strict=set())
        self.assertEqual(list(failing), ["offset"])
        self.assertEqual(checker.describe(failing["offset"]), ["chrome/f.cc hunk #1 lands at an offset on linux (+3)"])
        self.assertEqual(warned, {})
        self.assertEqual(moves, {step.patch: [("chrome/f.cc", 1, 20, 3)]})

    def test_offset_warns_for_an_unchanged_patch_and_fails_for_a_changed_one(self):
        step = self.patch("offset")
        self.write_tree("extra\n" + ORIGINAL)
        [result] = self.run_tree([step])
        failing, warned, _ = checker.judge([("linux", [result])], strict=set(), offsets="warn")
        self.assertEqual((list(failing), list(warned)), ([], ["offset"]))
        failing, warned, _ = checker.judge([("linux", [result])], strict={"offset"}, offsets="warn")
        self.assertEqual((list(failing), list(warned)), (["offset"], []))

    def test_a_shared_patch_needs_to_land_exactly_on_one_platform_only(self):
        step = self.patch("shared")
        self.write_tree("extra\n" + ORIGINAL)
        [shifted] = self.run_tree([step])
        self.write_tree(ORIGINAL)
        [exact] = self.run_tree([step])
        failing, warned, moves = checker.judge([("linux", [shifted]), ("mac", [exact])], strict=set())
        self.assertEqual((failing, warned, moves), ({}, {}, {}))
        self.write_tree("a\nb\n" + ORIGINAL)
        [shifted_more] = self.run_tree([step])
        failing, _, _ = checker.judge([("linux", [shifted]), ("mac", [shifted_more])], strict=set())
        self.assertEqual(checker.describe(failing["shared"]),
                         ["chrome/f.cc hunk #1 lands at an offset on linux (+1) and mac (+2)"])

    def test_fuzz_fails_and_names_the_hunk(self):
        step = self.patch("fuzzy", after=edited(ORIGINAL, l5="line five\n", l30="line thirty\n"))
        self.write_tree(edited(ORIGINAL, l28="drifted context\n"))
        [result] = self.run_tree([step])
        self.assertFalse(result.ok)
        self.assertEqual(len(result.problems), 1)
        self.assertIn("chrome/f.cc hunk #2", result.problems[0])
        self.assertIn("without fuzz", result.problems[0])
        text = pathlib.Path(self.tree, "chrome/f.cc").read_text()
        self.assertIn("line five\n", text)
        self.assertEqual(list(pathlib.Path(self.tree).rglob("*.rej")), [])

    def test_later_steps_still_run_after_a_failure(self):
        first = self.patch("first", after=edited(ORIGINAL, l5="line five\n"))
        second = self.patch("second", path="chrome/g.cc")
        self.write_tree(edited(ORIGINAL, l4="drift\n"))
        self.write_tree(ORIGINAL, "chrome/g.cc")
        results = self.run_tree([first, second])
        self.assertEqual([r.ok for r in results], [False, True])

    def test_missing_file_asks_for_a_repack(self):
        step = self.patch("needs-g", path="chrome/g.cc")
        missing = checker.missing_from_base([step], present={"chrome/f.cc"})
        self.assertEqual(missing, {"chrome/g.cc": "needs-g"})
        [message] = checker.missing_messages(missing)
        self.assertIn("chrome/g.cc (changed by needs-g) isn't in the series base", message)
        self.assertIn("series-base-pack.py", message)
        [result] = self.run_tree([step])
        self.assertIn("isn't in the scratch tree", result.problems[0])

    def test_a_file_a_patch_deletes_must_be_in_the_base(self):
        step = self.patch("deletes", path="chrome/gone.cc", before="bye\n", after="")
        text = pathlib.Path(step.patch).read_text().replace("+++ b/chrome/gone.cc", "+++ /dev/null")
        pathlib.Path(step.patch).write_text(text)
        required, _ = series_base.base_paths([step])
        self.assertEqual(required, {"chrome/gone.cc": "deletes"})
        recreate = self.patch("recreates", path="chrome/gone.cc", before="", after="back\n")
        text = pathlib.Path(recreate.patch).read_text().replace("--- a/chrome/gone.cc", "--- /dev/null")
        pathlib.Path(recreate.patch).write_text(text)
        required, _ = series_base.base_paths([step, recreate])
        self.assertEqual(required, {"chrome/gone.cc": "deletes"})
        required, _ = series_base.base_paths([recreate, step])
        self.assertEqual(required, {})

    def test_a_file_a_patch_creates_needs_no_base(self):
        step = self.patch("creates", path="chrome/new.cc", before="", after="hello\n")
        text = pathlib.Path(step.patch).read_text()
        text = text.replace("--- a/chrome/new.cc", "--- /dev/null")
        pathlib.Path(step.patch).write_text(text)
        self.assertEqual(checker.missing_from_base([step], present=set()), {})


class Refresh(Fixture):
    def test_refresh_moves_headers_so_the_patch_lands_exactly(self):
        step = self.patch("drifted", after=edited(ORIGINAL, l5="line five\n", l30="line thirty\n"))
        shifted = "x\ny\n" + edited(ORIGINAL, l10="", l11="")
        self.write_tree(shifted)
        [result] = self.run_tree([step])
        self.assertEqual([(o[1], o[3]) for o in result.offsets], [(1, 2)])
        expected = pathlib.Path(self.tree, "chrome/f.cc").read_text()
        before = pathlib.Path(step.patch).read_text()
        checker.refresh_offsets(step.patch, result.offsets)
        after = pathlib.Path(step.patch).read_text()
        self.assertEqual([l for l in before.splitlines() if not l.startswith("@@")],
                         [l for l in after.splitlines() if not l.startswith("@@")])
        self.write_tree(shifted)
        [again] = self.run_tree([step])
        self.assertTrue(again.ok)
        self.assertEqual(again.offsets, [])
        self.assertEqual(pathlib.Path(self.tree, "chrome/f.cc").read_text(), expected)


class RefreshVerified(Fixture):
    def test_a_refresh_that_moves_a_hunk_to_another_identical_context_is_undone(self):
        repeated = "".join(f"line {n}\n" for n in range(1, 21)) * 2
        step = self.patch("twice", before=repeated, after=edited(repeated, l10="changed\n"))
        original = pathlib.Path(step.patch).read_text()
        moves = {step.patch: [("chrome/f.cc", 1, 30, 20)]}
        before = {"mac": {"chrome/f.cc": "a"}}
        problems = checker.refresh_verified(moves, lambda: ([0], {"mac": {"chrome/f.cc": "b"}}, {}), before)
        self.assertTrue(any("another identical context" in p for p in problems), problems)
        self.assertEqual(pathlib.Path(step.patch).read_text(), original)

    def test_an_interrupted_refresh_puts_every_patch_back(self):
        step = self.patch("interrupted")
        original = pathlib.Path(step.patch).read_text()

        def interrupted():
            raise KeyboardInterrupt

        with self.assertRaises(KeyboardInterrupt):
            checker.refresh_verified({step.patch: [("chrome/f.cc", 1, 22, 2)]}, interrupted, {})
        self.assertEqual(pathlib.Path(step.patch).read_text(), original)

    def test_a_refresh_that_reproduces_every_tree_is_kept(self):
        step = self.patch("drifted")
        original = pathlib.Path(step.patch).read_text()
        moves = {step.patch: [("chrome/f.cc", 1, 22, 2)]}
        trees = {"linux": {"chrome/f.cc": "a"}}
        self.assertEqual(checker.refresh_verified(moves, lambda: ([0], dict(trees), {}), trees), [])
        self.assertNotEqual(pathlib.Path(step.patch).read_text(), original)


class SplitHunks(unittest.TestCase):
    def test_a_removed_line_that_looks_like_a_header_stays_in_its_hunk(self):
        patch = ("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n--- looks like a header\n+b\n c\n"
                 "@@ -10,2 +10,2 @@\n d\n-e\n+f\n")
        [entry] = checker.split_hunks(patch)
        self.assertEqual(entry["path"], "x")
        self.assertEqual(len(entry["hunks"]), 2)
        self.assertIn("--- looks like a header\n", entry["hunks"][0])

    def test_parse_offsets(self):
        output = "Checking patch a/b.cc...\nHunk #2 succeeded at 14 (offset -1 line).\nApplied patch a/b.cc cleanly.\n"
        self.assertEqual(checker.parse_offsets(output), [("a/b.cc", 2, 14, -1)])


class Archive(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ac-series-archive-test-")
        self.base = os.path.join(self.dir, "base")
        os.makedirs(os.path.join(self.base, "chrome"))
        pathlib.Path(self.base, "chrome/f.cc").write_text(ORIGINAL)
        pathlib.Path(self.base, "chrome/run.sh").write_text("#!/bin/sh\n")
        os.chmod(os.path.join(self.base, "chrome/run.sh"), 0o755)
        self.ident = {"platform": "linux", "cpu": "x64", "chromium": "1.2.3.4", "helium_chromium": "a" * 40,
                      "inputs": "c" * 64,
                      "helium_platform": "b" * 40}
        self.out = os.path.join(self.dir, "archive.tar.xz")

    def tearDown(self):
        subprocess.run(["rm", "-rf", self.dir])

    def test_round_trip_keeps_content_and_modes_and_lists_absent_paths(self):
        manifest, _ = series_base.write_tarball(self.base, {"chrome/f.cc", "chrome/run.sh", "ardia/new.cc"}, self.ident,
                                                self.out)
        self.assertEqual(manifest["absent"], ["ardia/new.cc"])
        dest = os.path.join(self.dir, "out")
        os.makedirs(dest)
        got = series_base.extract(self.out, dest)
        self.assertEqual(got["chromium"], "1.2.3.4")
        self.assertEqual(pathlib.Path(dest, "chrome/f.cc").read_text(), ORIGINAL)
        self.assertTrue(os.access(os.path.join(dest, "chrome/run.sh"), os.X_OK))
        first = series_base.sha256_file(self.out)
        os.unlink(self.out)
        series_base.write_tarball(self.base, {"chrome/f.cc", "chrome/run.sh", "ardia/new.cc"}, self.ident, self.out)
        self.assertEqual(series_base.sha256_file(self.out), first)

    def test_a_directory_destination_names_the_archive_by_pins_and_content(self):
        directory = os.path.join(self.dir, "dest")
        os.makedirs(directory)
        manifest, out = series_base.write_tarball(self.base, {"chrome/f.cc"}, self.ident, directory)
        self.assertEqual(os.path.basename(out), series_base.asset_name(self.ident, series_base.content_revision(manifest)))
        pathlib.Path(self.base, "chrome/f.cc").write_text(ORIGINAL + "captured later\n")
        other = os.path.join(self.dir, "dest2")
        os.makedirs(other)
        _, second = series_base.write_tarball(self.base, {"chrome/f.cc"}, self.ident, other)
        self.assertNotEqual(os.path.basename(second), os.path.basename(out))

    def test_symlinks_are_neither_packed_nor_extracted(self):
        os.symlink("f.cc", os.path.join(self.base, "chrome/link.cc"))
        with self.assertRaises(series_base.Problem):
            series_base.write_tarball(self.base, {"chrome/link.cc"}, self.ident, self.out)
        manifest = dict(self.ident, format=series_base.FORMAT, files={"chrome/link.cc": {"sha256": "0" * 64}}, absent=[])
        body = json.dumps(manifest).encode()
        with tarfile.open(self.out, "w:xz") as tar:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
            link = tarfile.TarInfo("src/chrome/link.cc")
            link.type, link.linkname = tarfile.SYMTYPE, "../../outside"
            tar.addfile(link)
        self.extract_fails("isn't a regular file")

    def test_an_archive_without_a_manifest_is_a_clear_error(self):
        with tarfile.open(self.out, "w:xz") as tar:
            info = tarfile.TarInfo("src/x")
            tar.addfile(info, io.BytesIO(b""))
        self.extract_fails("isn't a series base archive")

    def write_raw(self, files, entries):
        manifest = dict(self.ident, format=series_base.FORMAT, files=files, absent=[])
        body = json.dumps(manifest).encode()
        with tarfile.open(self.out, "w:xz") as tar:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
            for name, data in entries:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))

    def extract_fails(self, needle):
        dest = os.path.join(self.dir, "out")
        os.makedirs(dest, exist_ok=True)
        with self.assertRaises(series_base.Problem) as caught:
            series_base.extract(self.out, dest)
        self.assertIn(needle, str(caught.exception))

    def test_a_tampered_file_is_refused(self):
        self.write_raw({"chrome/f.cc": {"sha256": "0" * 64, "mode": "644"}}, [("src/chrome/f.cc", b"evil")])
        self.extract_fails("sha256")

    def test_a_path_that_leaves_the_tree_is_refused(self):
        self.write_raw({"../escape": {"sha256": "0" * 64, "mode": "644"}}, [("src/../escape", b"x")])
        self.extract_fails("unsafe")

    def test_an_entry_missing_from_the_manifest_is_refused(self):
        self.write_raw({}, [("src/chrome/extra.cc", b"x")])
        self.extract_fails("isn't in its manifest")


class Pins(unittest.TestCase):
    def test_identity_comes_from_env_sh_and_helium_pins(self):
        ident = series_base.identity("linux")
        self.assertEqual(ident["cpu"], "x64")
        self.assertRegex(ident["helium_platform"], r"^[0-9a-f]{40}$")
        self.assertRegex(ident["inputs"], r"^[0-9a-f]{64}$")
        self.assertEqual(series_base.asset_name(ident, "0123456789ab"),
                         f"series-base-{ident['chromium']}-{ident['helium_chromium'][:12]}-linux-"
                         f"{ident['helium_platform'][:12]}-x64-{ident['inputs'][:12]}-0123456789ab.tar.xz")

    def test_a_step3_input_or_a_resource_it_copies_changes_the_identity(self):
        with tempfile.TemporaryDirectory() as root:
            build = pathlib.Path(root, "engine/patches/build")
            build.mkdir(parents=True)
            for name in series_base.STEP3_FILES:
                (build / name).write_text(name)
            (build / "ardia_resources.txt").write_text("# listing\nart/logo.png chrome/logo.png\n")
            pathlib.Path(root, "art").mkdir()
            pathlib.Path(root, "art/logo.png").write_bytes(b"one")
            first = series_base.step3_digest(build, root)
            pathlib.Path(root, "art/logo.png").write_bytes(b"two")
            second = series_base.step3_digest(build, root)
            (build / "domsub-keep-store.txt").write_text("changed")
            third = series_base.step3_digest(build, root)
            self.assertEqual(len({first, second, third}), 3)
            pathlib.Path(root, "art/logo.png").unlink()
            with self.assertRaises(series_base.Problem):
                series_base.step3_digest(build, root)

    def test_a_base_for_old_step3_inputs_fails_with_its_own_message(self):
        ident = series_base.identity("linux")
        with tempfile.TemporaryDirectory() as root:
            table = pathlib.Path(root, "table.tsv")
            series_base.write_row(dict(ident, inputs="0" * 64, tag="t", asset="a", sha256="f" * 64), table)
            self.assertIsNone(series_base.find_row(ident, table))
            self.assertIn("step 3's inputs changed", checker.stale_message(ident, table))
            table.write_text("")
            self.assertIn("the pins moved", checker.stale_message(ident, table))

    def test_mismatched_pins_are_refused(self):
        with tempfile.TemporaryDirectory() as build:
            pathlib.Path(build, "env.sh").write_text("export CHROMIUM_VERSION=1.2.3.4\n")
            pathlib.Path(build, "helium-pins.ini").write_text("[chromium]\nversion = 1.2.3.5\n")
            with self.assertRaises(series_base.Problem):
                series_base.pins(build)

    def test_every_table_row_names_its_pins(self):
        for row in series_base.read_table():
            ident = {k: row[k] for k in series_base.IDENTITY}
            self.assertTrue(row["asset"].startswith(series_base.asset_prefix(ident)), row["asset"])
            self.assertRegex(row["asset"][len(series_base.asset_prefix(ident)):], r"^[0-9a-f]{12}\.tar\.xz$")
            self.assertEqual(row["tag"], series_base.tag_name(ident))
            self.assertRegex(row["sha256"], r"^[0-9a-f]{64}$")

    def test_the_current_pins_have_a_published_base(self):
        for platform in ("linux", "mac"):
            self.assertIsNotNone(series_base.find_row(series_base.identity(platform)),
                                 f"no series-bases.tsv row for {platform} at the current pins: run series-base-pack.py")


def git_patch(directory, *commands):
    repo = os.path.join(directory, "repo")
    os.makedirs(repo, exist_ok=True)
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]
    if not os.path.isdir(os.path.join(repo, ".git")):
        subprocess.run(git + ["init", "-q"], cwd=repo, env=env, check=True)
        os.makedirs(os.path.join(repo, "chrome"))
        pathlib.Path(repo, "chrome/f.cc").write_text(ORIGINAL)
        subprocess.run(git + ["add", "-A"], cwd=repo, env=env, check=True)
        subprocess.run(git + ["commit", "-qm", "base"], cwd=repo, env=env, check=True)
    for command in commands:
        subprocess.run(command, cwd=repo, env=env, check=True, shell=True)
    subprocess.run(git + ["add", "-A"], cwd=repo, env=env, check=True)
    diff = subprocess.run(git + ["diff", "--cached", "-M", "-C", "--find-copies-harder", "HEAD"], cwd=repo, env=env,
                          capture_output=True, text=True, check=True).stdout
    path = os.path.join(directory, "step.patch")
    pathlib.Path(path).write_text(diff)
    return FakeStep("step.patch", path)


class GitForms(Fixture):
    def assert_needs_and_applies(self, step, expected):
        required, _ = series_base.base_paths([step])
        self.assertEqual(sorted(required), expected)
        self.write_tree(ORIGINAL)
        [result] = self.run_tree([step])
        self.assertTrue(result.ok, result.problems)
        for leftover in pathlib.Path(self.tree).rglob("*"):
            if leftover.is_file():
                leftover.unlink()
        [missing] = self.run_tree([step])
        self.assertFalse(missing.ok)

    def test_a_mode_only_patch_needs_its_file(self):
        step = git_patch(self.dir, "chmod +x chrome/f.cc")
        self.assertNotIn("+++", pathlib.Path(step.patch).read_text())
        self.assert_needs_and_applies(step, ["chrome/f.cc"])

    def test_a_rename_only_patch_needs_its_source(self):
        step = git_patch(self.dir, "git mv chrome/f.cc chrome/g.cc")
        self.assertIn("rename from chrome/f.cc", pathlib.Path(step.patch).read_text())
        self.assert_needs_and_applies(step, ["chrome/f.cc"])
        self.assertEqual(series_base.patch_sections(step), [("chrome/f.cc", "chrome/g.cc", "rename")])

    def test_a_mode_patch_on_a_file_with_another_mode_fails_on_the_warning(self):
        step = git_patch(self.dir, "chmod +x chrome/f.cc")
        self.write_tree(ORIGINAL)
        os.chmod(os.path.join(self.tree, "chrome/f.cc"), 0o755)
        [result] = self.run_tree([step])
        self.assertFalse(result.ok)
        self.assertTrue(any("git apply warned" in problem for problem in result.problems), result.problems)

    def test_a_copy_only_patch_needs_its_source(self):
        step = git_patch(self.dir, "cp chrome/f.cc chrome/copy.cc")
        self.assertIn("copy from chrome/f.cc", pathlib.Path(step.patch).read_text())
        self.assert_needs_and_applies(step, ["chrome/f.cc"])

    def test_a_file_a_rename_creates_needs_no_base_later(self):
        rename = git_patch(self.dir, "git mv chrome/f.cc chrome/g.cc")
        later = self.patch("edits-g", path="chrome/g.cc")
        required, _ = series_base.base_paths([rename, later])
        self.assertEqual(sorted(required), ["chrome/f.cc"])


class ChangedPatches(unittest.TestCase):
    def test_nested_patch_names_stay_relative_to_the_series(self):
        with tempfile.TemporaryDirectory() as repo:
            env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
            git = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
            subprocess.run(git + ["init", "-q"], cwd=repo, env=env, check=True)
            os.makedirs(os.path.join(repo, "engine/patches/nested"))
            pathlib.Path(repo, "engine/patches/top.patch").write_text("a\n")
            pathlib.Path(repo, "engine/patches/nested/test.patch").write_text("a\n")
            subprocess.run(git + ["add", "-A"], cwd=repo, env=env, check=True)
            subprocess.run(git + ["commit", "-qm", "one"], cwd=repo, env=env, check=True)
            pathlib.Path(repo, "engine/patches/nested/test.patch").write_text("b\n")
            subprocess.run(git + ["commit", "-qam", "two"], cwd=repo, env=env, check=True)
            self.assertEqual(checker.changed_patches("HEAD^", repo), {"nested/test.patch"})


class Limits(unittest.TestCase):
    def test_a_download_stops_at_the_cap(self):
        class Source(io.BytesIO):
            headers = {}
        sink = io.BytesIO()
        with self.assertRaises(series_base.Problem):
            checker.copy_capped(Source(b"x" * 100), sink, 50)
        checker.copy_capped(Source(b"x" * 50), io.BytesIO(), 50)

    def test_a_pax_header_counts_against_the_expanded_limit(self):
        with tempfile.TemporaryDirectory() as root:
            out = os.path.join(root, "pax.tar.xz")
            manifest = json.dumps({"format": series_base.FORMAT, "files": {}, "absent": []}).encode()
            with tarfile.open(out, "w:xz", format=tarfile.PAX_FORMAT) as tar:
                info = tarfile.TarInfo("manifest.json")
                info.size = len(manifest)
                info.pax_headers = {"comment": "x" * 4096}
                tar.addfile(info, io.BytesIO(manifest))
            saved = series_base.MAX_EXPANDED_BYTES
            try:
                series_base.MAX_EXPANDED_BYTES = 256
                with self.assertRaises(series_base.Problem):
                    series_base.read_manifest(out)
                with self.assertRaises(series_base.Problem):
                    series_base.extract(out, tempfile.mkdtemp(dir=root))
            finally:
                series_base.MAX_EXPANDED_BYTES = saved
            self.assertEqual(series_base.read_manifest(out)["files"], {})

    def test_an_xz_dictionary_over_the_decoder_memory_limit_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            out = os.path.join(root, "dict.tar.xz")
            manifest = json.dumps({"format": series_base.FORMAT, "files": {}, "absent": []}).encode()
            raw = io.BytesIO()
            with tarfile.open(fileobj=raw, mode="w") as tar:
                info = tarfile.TarInfo("manifest.json")
                info.size = len(manifest)
                tar.addfile(info, io.BytesIO(manifest))
            filters = [{"id": lzma.FILTER_LZMA2, "dict_size": 64 << 20, "mf": lzma.MF_HC3}]
            pathlib.Path(out).write_bytes(lzma.compress(raw.getvalue(), format=lzma.FORMAT_XZ, filters=filters))
            self.assertLess(os.path.getsize(out), 4096)
            saved = series_base.MAX_DECODER_MEMORY
            try:
                series_base.MAX_DECODER_MEMORY = 8 << 20
                with self.assertRaises(series_base.Problem):
                    series_base.read_manifest(out)
                with self.assertRaises(series_base.Problem):
                    series_base.extract(out, tempfile.mkdtemp(dir=root))
            finally:
                series_base.MAX_DECODER_MEMORY = saved
            self.assertEqual(series_base.read_manifest(out)["files"], {})

    def test_a_missing_archive_is_a_missing_base(self):
        result = subprocess.run([sys.executable, str(ENGINE / "series-zero-fuzz.py"), "--platform", "mac", "--tarball",
                                 "/nonexistent/series-base.tar.xz"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("no series base archive at /nonexistent/series-base.tar.xz", result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_a_declared_length_over_the_cap_is_refused_before_reading(self):
        class Source(io.BytesIO):
            headers = {"Content-Length": "999"}
        with self.assertRaises(series_base.Problem):
            checker.copy_capped(Source(b""), io.BytesIO(), 50)

    def test_archives_past_the_size_or_entry_limits_are_refused(self):
        with tempfile.TemporaryDirectory() as root:
            out = os.path.join(root, "big.tar.xz")
            manifest = {"format": series_base.FORMAT, "files": {}, "absent": []}
            body = json.dumps(manifest).encode()
            with tarfile.open(out, "w:xz") as tar:
                info = tarfile.TarInfo("manifest.json")
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
                for n in range(5):
                    entry = tarfile.TarInfo(f"src/f{n}")
                    entry.size = 1000
                    tar.addfile(entry, io.BytesIO(b"\0" * 1000))
            saved = (series_base.MAX_ARCHIVE_BYTES, series_base.MAX_MEMBERS, series_base.MAX_EXPANDED_BYTES)
            try:
                series_base.MAX_ARCHIVE_BYTES = 10
                with self.assertRaises(series_base.Problem):
                    series_base.read_manifest(out)
                series_base.MAX_ARCHIVE_BYTES = saved[0]
                series_base.MAX_MEMBERS = 3
                with self.assertRaises(series_base.Problem):
                    series_base.extract(out, tempfile.mkdtemp(dir=root))
                series_base.MAX_MEMBERS = saved[1]
                series_base.MAX_EXPANDED_BYTES = 2500
                with self.assertRaises(series_base.Problem):
                    series_base.extract(out, tempfile.mkdtemp(dir=root))
            finally:
                series_base.MAX_ARCHIVE_BYTES, series_base.MAX_MEMBERS, series_base.MAX_EXPANDED_BYTES = saved


class Provenance(unittest.TestCase):
    def test_an_archive_without_provenance_is_refused(self):
        provenance = {"step3_run": "r", "step3_stamp_sha256": "s", "capture_sha256": "c"}
        series_base.require_provenance({"verified": list(series_base.VERIFIED), "provenance": provenance}, "a")
        for manifest in ({}, {"verified": list(series_base.VERIFIED)},
                         {"verified": list(series_base.VERIFIED)[:-1], "provenance": provenance},
                         {"verified": list(series_base.VERIFIED), "provenance": dict(provenance, step3_run="")}):
            with self.assertRaises(series_base.Problem):
                series_base.require_provenance(manifest, "a")

    def test_the_same_files_from_another_run_get_their_own_asset(self):
        manifest = {"files": {"chrome/f.cc": {"sha256": "0" * 64, "mode": "644"}}, "absent": [],
                    "provenance": {"step3_run": "one"}}
        other = dict(manifest, provenance={"step3_run": "two"})
        self.assertNotEqual(series_base.content_revision(manifest), series_base.content_revision(other))

    def test_the_archive_is_built_from_the_verified_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            base = os.path.join(root, "base")
            os.makedirs(os.path.join(base, "chrome"))
            pathlib.Path(base, "chrome/f.cc").write_text("verified\n")
            snapshot = series_base.snapshot_base(base)
            pathlib.Path(base, "chrome/f.cc").write_text("swapped\n")
            os.chmod(os.path.join(base, "chrome/f.cc"), 0o755)
            ident = series_base.identity("linux")
            _, out = series_base.write_tarball(snapshot, {"chrome/f.cc"}, ident, root)
            dest = tempfile.mkdtemp(dir=root)
            series_base.extract(out, dest)
            self.assertEqual(pathlib.Path(dest, "chrome/f.cc").read_text(), "verified\n")
            self.assertFalse(os.access(os.path.join(dest, "chrome/f.cc"), os.X_OK))
            self.assertNotEqual(series_base.snapshot_base(base), snapshot)


class Packer(unittest.TestCase):
    def test_step3_stages_must_all_have_run_for_the_platform(self):
        with tempfile.TemporaryDirectory() as root:
            src = os.path.join(root, "src")
            os.makedirs(src)
            marker = pathlib.Path(root, ".helium-stages-src")
            inode = f"tree-inode={os.stat(src).st_ino}"
            marker.write_text(inode + "\n" + "\n".join(series_base.STEP3_STAGES) + "\nplatform=mac\n")
            packer.verify_stages(src, "mac")
            with self.assertRaises(SystemExit):
                packer.verify_stages(src, "linux")
            marker.write_text(inode + "\npatches\nplatform=mac\n")
            with self.assertRaises(SystemExit):
                packer.verify_stages(src, "mac")

    def test_a_stage_marker_left_by_another_tree_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            src = os.path.join(root, "src")
            os.makedirs(src)
            pathlib.Path(root, ".helium-stages-src").write_text(
                f"tree-inode={os.stat(src).st_ino + 1}\n" + "\n".join(series_base.STEP3_STAGES) + "\nplatform=mac\n")
            with self.assertRaises(SystemExit):
                packer.verify_stages(src, "mac")

    def test_a_missing_or_dirty_helium_checkout_is_refused(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(SystemExit):
                packer.verify_helium(os.path.join(root, "helium"), "0" * 40, "helium_chromium")
            env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
            git = ["git", "-c", "user.name=t", "-c", "user.email=t@t"]
            subprocess.run(git + ["init", "-q"], cwd=root, env=env, check=True)
            pathlib.Path(root, "a").write_text("a")
            subprocess.run(git + ["add", "a"], cwd=root, env=env, check=True)
            subprocess.run(git + ["commit", "-qm", "a"], cwd=root, env=env, check=True)
            head = packer.git_head(root)
            packer.verify_helium(root, head, "helium_chromium")
            with self.assertRaises(SystemExit):
                packer.verify_helium(root, "0" * 40, "helium_chromium")
            pathlib.Path(root, "a").write_text("changed")
            with self.assertRaises(SystemExit):
                packer.verify_helium(root, head, "helium_chromium")

    def test_publish_refuses_an_archive_packed_without_the_builder_checks(self):
        with tempfile.TemporaryDirectory() as root:
            base = os.path.join(root, "base")
            os.makedirs(os.path.join(base, "chrome"))
            pathlib.Path(base, "chrome/f.cc").write_text(ORIGINAL)
            ident = series_base.identity("linux")
            _, out = series_base.write_tarball(base, {"chrome/f.cc"}, dict(ident, verified=[]), root)
            args = type("Args", (), {"archive": out, "repo": "nobody/nothing"})()
            with self.assertRaises(series_base.Problem):
                packer.cmd_publish(args)


FAKE_STEP3 = """
import os, sys
argv = sys.argv[1:]
tree = argv[argv.index("--tree") + 1]
if not os.path.isdir(tree):
    sys.exit(2)
stages = [s for s in os.environ["FAKE_STAGES"].split(",") if s]
if not stages:
    sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
marker = os.path.join(os.path.dirname(tree), ".helium-stages-" + os.path.basename(tree))
done = []
if os.path.exists(marker):
    done = open(marker).read().split()[1:]
with open(marker, "w") as handle:
    platform = argv[argv.index("--platform") + 1] if "--platform" in argv else "linux"
    handle.write("\\n".join(["tree-inode=%d" % os.stat(tree).st_ino] + done + stages + ["platform=" + platform]) + "\\n")
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
"""

FAKE_CAPTURE = """
import os, shutil, sys
base = os.environ["AC_SERIES_BASE"]
os.makedirs(os.path.join(base, "chrome"), exist_ok=True)
for name in os.environ["FAKE_CAPTURE"].split(","):
    target = os.path.join(base, "chrome", name)
    if not os.path.exists(target):
        shutil.copyfile(os.path.join(os.environ["CHROMIUM_SRC"], "chrome", name), target)
open(os.path.join(base, ".ardia-series-target"), "w").write("{}")
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
"""


class Step3Stamp(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ac-step3-test-")
        self.src = os.path.join(self.root, "src")
        self.base = os.path.join(self.root, "base")
        os.makedirs(os.path.join(self.src, "chrome"))
        pathlib.Path(self.src, "chrome/f.cc").write_text(ORIGINAL)
        pathlib.Path(self.src, "chrome/g.cc").write_text(ORIGINAL)
        self.helium = os.path.join(self.root, "fake-03-helium.py")
        pathlib.Path(self.helium).write_text(FAKE_STEP3)
        self.series = os.path.join(self.root, "fake-series.py")
        pathlib.Path(self.series).write_text(FAKE_CAPTURE)
        self.env = {"CHROMIUM_SRC": self.src, "AC_SERIES_BASE": self.base, "FAKE_CAPTURE": "f.cc", "FAKE_EXIT": "0"}
        self.saved = {key: os.environ.get(key) for key in [*self.env, "FAKE_STAGES"]}
        os.environ.update(self.env)
        self.digest = series_base.step3_digest()

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        subprocess.run(["rm", "-rf", self.root])

    def step3(self, stages=series_base.STEP3_STAGES, extra=(), exit_code=0):
        os.environ["FAKE_STAGES"] = ",".join(stages)
        os.environ["FAKE_EXIT"] = str(exit_code)
        with contextlib.redirect_stderr(io.StringIO()):
            code = step3.run(["--apply", "--platform", "linux", "--tree", self.src, *extra], helium=self.helium)
        os.environ["FAKE_EXIT"] = "0"
        return code

    def stamped(self):
        return series_base.step3_stamp(self.src).is_file()

    def capture(self, steps=()):
        with contextlib.redirect_stderr(io.StringIO()):
            return capturer.run(["--platform", "linux"], series=self.series, steps=list(steps))

    def verify(self, digest=None):
        _, stamp_sha = packer.verify_step3_stamp(self.src, "linux", digest or self.digest)
        return packer.verify_capture(self.base, stamp_sha, series_base.snapshot_base(self.base))

    def test_one_full_run_is_stamped_and_its_capture_packs(self):
        self.assertEqual(self.step3(), 0)
        self.assertTrue(self.stamped())
        self.assertEqual(self.capture(), 0)
        self.verify()

    def test_a_failed_run_then_a_direct_stage_then_a_wrapper_run_leaves_no_stamp(self):
        self.assertEqual(self.step3(stages=["patches"], exit_code=1), 1)
        self.assertFalse(self.stamped())
        os.environ["FAKE_STAGES"] = "fixups"
        subprocess.run([sys.executable, self.helium, "--tree", self.src], check=True)
        self.assertEqual(self.step3(stages=[s for s in series_base.STEP3_STAGES if s not in ("patches", "fixups")]), 0)
        self.assertFalse(self.stamped())
        with self.assertRaises(SystemExit):
            self.verify()

    def test_inputs_that_change_during_the_run_leave_no_stamp_and_a_revert_does_not_bring_one_back(self):
        digests = iter(["a" * 64, "b" * 64, "a" * 64, "a" * 64])
        with mock.patch.object(series_base, "step3_digest", lambda: next(digests)):
            self.step3(stages=series_base.STEP3_STAGES[:3])
            self.assertFalse(self.stamped())
            self.step3(stages=series_base.STEP3_STAGES[3:])
        self.assertFalse(self.stamped())

    def test_a_partial_or_unbranded_run_leaves_no_stamp(self):
        for extra in (["--only", "patches"], ["--from=patches"], ["--no-brand"], ["--onl", "patches"]):
            subprocess.run(["rm", "-f", str(series_base.stage_marker(self.src))])
            self.step3(extra=extra)
            self.assertFalse(self.stamped(), extra)

    def test_a_run_that_fails_before_any_work_keeps_the_stamp_and_the_record(self):
        self.step3()
        self.capture()
        self.assertEqual(self.step3(stages=[], exit_code=2), 2)
        self.assertTrue(self.stamped())
        self.verify()

    def test_a_run_that_fails_after_starting_work_leaves_a_stamp_that_no_longer_packs(self):
        self.step3()
        self.capture()
        self.assertEqual(self.step3(stages=["started:patches"], exit_code=1), 1)
        with self.assertRaises(SystemExit):
            self.verify()

    def test_an_unknown_option_keeps_both_records(self):
        self.step3()
        self.capture()
        record = pathlib.Path(self.base, series_base.CAPTURE_RECORD).read_bytes()
        result = subprocess.run([sys.executable, str(ENGINE / "run-step3.py"), "--apply", "--platform", "linux",
                                 "--tree", self.src, "--bogus"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("unrecognized arguments: --bogus", result.stderr)
        result = subprocess.run([sys.executable, str(ENGINE / "run-capture.py"), "--platform", "linux", "--bogus"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(self.stamped())
        self.assertEqual(pathlib.Path(self.base, series_base.CAPTURE_RECORD).read_bytes(), record)
        self.verify()

    def test_a_mode_change_after_capture_is_refused(self):
        self.step3()
        self.capture()
        os.chmod(os.path.join(self.base, "chrome/f.cc"), 0o755)
        with self.assertRaises(SystemExit):
            self.verify()

    def test_capture_hands_the_child_the_tree_whose_stamp_it_records(self):
        build = os.path.join(self.root, "build")
        tree = os.path.join(build, "chromium_git/chromium/src")
        os.makedirs(os.path.join(tree, "chrome"))
        pathlib.Path(tree, "chrome/f.cc").write_text(ORIGINAL)
        os.environ["FAKE_STAGES"] = ",".join(series_base.STEP3_STAGES)
        os.environ.pop("CHROMIUM_SRC")
        os.environ.pop("AC_SERIES_BASE")
        os.environ["AC_CHROMIUM_BUILD"] = build
        self.saved.setdefault("AC_CHROMIUM_BUILD", None)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            step3.run(["--apply", "--platform", "mac", "--tree", tree], helium=self.helium)
            try:
                capturer.run(["--platform", "mac"], series=self.series)
            except SystemExit:
                self.fail(err.getvalue())
        base = os.path.join(build, "series-base")
        self.assertEqual(pathlib.Path(base, "chrome/f.cc").read_text(), ORIGINAL)
        record = json.loads(pathlib.Path(base, series_base.CAPTURE_RECORD).read_text())
        self.assertEqual(record["step3_stamp_sha256"], series_base.sha256_file(series_base.step3_stamp(tree)))

    def test_a_step3_input_edited_after_step3_ran_is_refused(self):
        self.step3()
        self.capture()
        with self.assertRaises(SystemExit):
            self.verify("b" * 64)

    def test_a_stale_file_copied_into_the_base_after_capture_is_refused(self):
        self.step3()
        self.capture()
        stale = os.path.join(self.root, "stale.cc")
        pathlib.Path(stale).write_text("old\n")
        shutil.copy2(stale, os.path.join(self.base, "chrome/f.cc"))
        with self.assertRaises(SystemExit):
            self.verify()

    def test_a_file_added_to_the_base_after_capture_is_refused(self):
        self.step3()
        self.capture()
        pathlib.Path(self.base, "chrome/extra.cc").write_text("x\n")
        with self.assertRaises(SystemExit):
            self.verify()

    def test_capture_refuses_a_base_with_files_it_did_not_record(self):
        self.step3()
        os.makedirs(os.path.join(self.base, "chrome"))
        pathlib.Path(self.base, "chrome/f.cc").write_text("stale\n")
        with self.assertRaises(SystemExit):
            self.capture()

    def test_a_recapture_after_step4_can_not_restore_a_deleted_file(self):
        self.step3()
        self.capture()
        pathlib.Path(self.src, "chrome/f.cc").write_text("hooked by step 4\n")
        os.unlink(os.path.join(self.base, "chrome/f.cc"))
        with self.assertRaises(SystemExit):
            self.capture()
        self.assertFalse(os.path.exists(os.path.join(self.base, "chrome/f.cc")))
        with self.assertRaises(SystemExit):
            self.verify()

    def test_deleting_the_whole_base_does_not_allow_a_second_capture(self):
        self.step3()
        self.capture()
        shutil.rmtree(self.base)
        with self.assertRaises(SystemExit):
            self.capture()
        self.assertFalse(os.path.exists(self.base))

    def test_a_tree_step4_already_touched_can_not_be_captured(self):
        self.step3()
        step = FakeStep("hook.patch", make_patch(os.path.join(self.root, "p"), "hook.patch", "chrome/f.cc", ORIGINAL,
                                                 edited(ORIGINAL, l20="hooked\n")))
        subprocess.run(["git", "apply", step.patch], cwd=self.src, check=True)
        with self.assertRaises(SystemExit):
            self.capture(steps=[step])
        self.assertFalse(os.path.exists(self.base))
        os.makedirs(os.path.join(self.src, "chrome/browser/ardia"))
        self.assertIn("engine/chromium", capturer.series_started(self.src, []))

    def test_an_untouched_tree_counts_as_not_started(self):
        step = FakeStep("hook.patch", make_patch(os.path.join(self.root, "p"), "hook.patch", "chrome/f.cc", ORIGINAL,
                                                 edited(ORIGINAL, l20="hooked\n")))
        self.assertIsNone(capturer.series_started(self.src, [step]))

    def test_a_capture_for_another_step3_run_is_refused(self):
        self.step3()
        self.capture()
        subprocess.run(["rm", "-f", str(series_base.stage_marker(self.src))])
        self.step3()
        with self.assertRaises(SystemExit):
            self.verify()

    def test_capture_needs_a_stamp(self):
        with self.assertRaises(SystemExit):
            self.capture()

    def test_a_missing_tree_fails_as_03_helium_py_does(self):
        missing = os.path.join(self.root, "missing/src")
        helium = str(series_base.BUILD / "03-helium.py")
        direct = subprocess.run([sys.executable, helium, "--apply", "--platform", "linux", "--tree", missing],
                                capture_output=True, text=True)
        wrapped = subprocess.run([sys.executable, str(ENGINE / "run-step3.py"), "--apply", "--platform", "linux",
                                  "--tree", missing], capture_output=True, text=True)
        self.assertEqual(direct.returncode, 2)
        self.assertEqual((wrapped.returncode, wrapped.stdout, wrapped.stderr),
                         (direct.returncode, direct.stdout, direct.stderr))


class Workflow(unittest.TestCase):
    def test_every_input_of_the_layers_starts_the_workflow(self):
        text = (series_base.REPO / ".github/workflows/engine-series.yml").read_text()
        block = text.split("paths: &series\n", 1)[1]
        globs = []
        for line in block.splitlines():
            if not line.startswith("      - "):
                break
            globs.append(line.strip()[2:].strip('"'))

        def covered(path):
            for glob in globs:
                pattern = "^" + "".join(".*" if part == "**" else part.replace(".", "\\.").replace("*", "[^/]*")
                                        for part in re.split(r"(\*\*)", glob)) + "$"
                if re.match(pattern, path):
                    return True
            return False

        inputs = ["engine/patches/series", "engine/patches/series.py", "engine/patches/build/env.sh",
                  "engine/patches/build/helium-pins.ini", "engine/chromium/apply.sh", "engine/ardiacore/apply.sh",
                  "engine/ardiacore-linux/apply.sh", "engine/ardiacore-linux/copies.tsv"]
        copies = (series_base.REPO / "engine/ardiacore-linux/copies.tsv").read_text().splitlines()
        inputs += [line.split("\t")[0] for line in copies if line.strip()]
        inputs += [source for source, _ in series_base.resource_pairs()]
        missing = [path for path in inputs if not covered(path)]
        self.assertEqual(missing, [], "add these to engine-series.yml's paths")


class RealSeries(unittest.TestCase):
    def test_every_patch_path_is_safe_to_pack(self):
        series = series_base.load_series()
        for platform in ("linux", "mac"):
            required, optional = series_base.base_paths(series.read_series(platform))
            self.assertTrue(required)
            for path in list(required) + list(optional):
                self.assertTrue(series_base.safe_relative(path), path)


if __name__ == "__main__":
    unittest.main()
