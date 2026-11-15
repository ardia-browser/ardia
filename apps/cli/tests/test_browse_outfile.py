import io
import json
import os
import stat
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from ardia_cli.browse import outfile


def fake_run(payload):
    def run(argv):
        print(json.dumps(payload))
        return 0 if payload.get("success") else 1
    return run


class Content(unittest.TestCase):
    def test_read_of_the_tab_saves_its_text(self):
        text, summary = outfile.content("read", {"content": "hello world"}, Path("page.md"))
        self.assertEqual(text, "hello world\n")
        self.assertIn("hello world", summary)

    def test_rows_become_csv_with_first_seen_columns(self):
        text, _ = outfile.content("script", {"value": [{"a": 1}, {"b": [2], "a": None}]}, Path("t.csv"))
        self.assertEqual(text, 'a,b\n1,\n,[2]\n')


class Saving(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="ardia-out-"))

    def run_saving(self, payload, path, command="script"):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = outfile.run_saving(fake_run(payload), ["script"], command, str(path))
        return code, out.getvalue(), err.getvalue()

    def test_a_folder_path_is_refused_and_the_output_still_printed(self):
        code, out, err = self.run_saving({"success": True, "data": {"value": [1, 2]}}, self.folder)
        self.assertEqual(code, 1)
        self.assertIn("is a folder", err)
        self.assertIn("1", out)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_nothing_to_save_writes_nothing(self):
        target = self.folder / "empty.md"
        code, _, err = self.run_saving({"success": True, "data": {"content": ""}}, target, command="read")
        self.assertEqual(code, 1)
        self.assertIn("returned nothing to save", err)
        self.assertFalse(target.exists())

    def test_an_existing_files_mode_is_kept_and_no_temp_file_is_left(self):
        target = self.folder / "rows.json"
        target.write_text("old")
        os.chmod(target, 0o640)
        code, out, _ = self.run_saving({"success": True, "data": {"value": [{"n": 1}]}}, target)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(target.read_text()), [{"n": 1}])
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o640)
        self.assertEqual(sorted(path.name for path in self.folder.iterdir()), ["rows.json"])
        self.assertIn("Saved to", out)

    def test_a_planted_symlink_at_the_old_temp_name_is_not_followed(self):
        victim = self.folder / "victim.txt"
        victim.write_text("keep")
        (self.folder / ".rows.json.part").symlink_to(victim)
        code, _, _ = self.run_saving({"success": True, "data": {"value": [1]}}, self.folder / "rows.json")
        self.assertEqual(code, 0)
        self.assertEqual(victim.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
