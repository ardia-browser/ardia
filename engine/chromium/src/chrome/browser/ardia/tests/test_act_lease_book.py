import os
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


def compiler():
    for name in ("clang++", "c++", "g++"):
        path = shutil.which(name)
        if path:
            return path
    return None


class ActLeaseBookTest(unittest.TestCase):
    def test_grants_admission_and_release(self):
        cxx = compiler()
        if not cxx:
            self.skipTest("no C++ compiler here")
        with tempfile.TemporaryDirectory() as work:
            binary = os.path.join(work, "act_lease_book_test")
            build = subprocess.run(
                [cxx, "-std=c++20", "-O2", "-Wall", "-Werror", "-I", SRC_ROOT, "-o", binary,
                 os.path.join(HERE, "act_lease_book_test.cc"),
                 os.path.join(HERE, "..", "ac_cli_act_lease_book.cc")],
                capture_output=True, text=True)
            self.assertEqual(build.returncode, 0, build.stderr)
            run = subprocess.run([binary], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            print(run.stdout.strip())


if __name__ == "__main__":
    unittest.main()
