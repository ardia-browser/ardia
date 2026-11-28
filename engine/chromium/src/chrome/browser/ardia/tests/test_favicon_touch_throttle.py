import pathlib
import shutil
import subprocess
import tempfile
import unittest


TESTS = pathlib.Path(__file__).resolve().parent
ROOT = TESTS.parent
SCENARIOS = TESTS / "favicon_touch_throttle" / "scenarios.cc"


@unittest.skipUnless(shutil.which("clang++"), "clang++ is required")
class FaviconTouchThrottleTests(unittest.TestCase):
    def test_throttle_prunes_and_stays_bounded(self):
        with tempfile.TemporaryDirectory(prefix="ardia-favicon-throttle-") as directory:
            executable = pathlib.Path(directory) / "throttle"
            build = subprocess.run([
                "clang++", "-std=c++20", "-Wall", "-Wextra", "-Werror", "-g",
                "-fsanitize=address,undefined", "-fno-sanitize-recover=undefined", "-fno-omit-frame-pointer",
                "-I", str(ROOT.parents[2]), str(SCENARIOS), "-o", str(executable),
            ], capture_output=True, text=True, timeout=180)
            self.assertEqual(build.returncode, 0, build.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("favicon touch throttle scenarios passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
