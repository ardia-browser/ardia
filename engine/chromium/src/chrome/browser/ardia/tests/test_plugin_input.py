import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
CORE_ROOT = os.path.abspath(os.path.join(SRC_ROOT, "..", "..", "ardiacore", "src"))


def compiler():
    for name in ("clang++", "c++", "g++"):
        path = shutil.which(name)
        if path:
            return path
    return None


class PluginInputTest(unittest.TestCase):
    def test_the_plugin_key_and_mouse_rules(self):
        cxx = compiler()
        if not cxx:
            self.skipTest("no C++ compiler here")
        with tempfile.TemporaryDirectory() as work:
            binary = os.path.join(work, "plugin_input_test")
            build = subprocess.run(
                [cxx, "-std=c++20", "-I", SRC_ROOT, "-I", CORE_ROOT, "-o", binary,
                 os.path.join(HERE, "plugin_input_test.cc"),
                 os.path.join(HERE, "..", "ac_cli_plugin_input.cc")],
                capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            run = subprocess.run([binary], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


if __name__ == "__main__":
    unittest.main()
