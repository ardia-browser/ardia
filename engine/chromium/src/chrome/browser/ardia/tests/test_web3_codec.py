import pathlib
import shutil
import subprocess
import tempfile
import unittest


TESTS = pathlib.Path(__file__).resolve().parent
ROOT = TESTS.parent


@unittest.skipUnless(shutil.which("clang++"), "clang++ is required")
class Web3CodecTests(unittest.TestCase):
    def test_url_abi_and_name_scenarios(self):
        with tempfile.TemporaryDirectory(prefix="ardia-web3-codec-") as directory:
            executable = pathlib.Path(directory) / "web3-codec"
            compiled = subprocess.run([
                "clang++", "-std=c++20", "-Wall", "-Wextra", "-Werror", "-g", "-O0",
                "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
                "-I", str(ROOT.parents[2]),
                *(str(ROOT / name) for name in ("ac_web3_keccak.cc", "ac_web3_abi.cc", "ac_web3_codec.cc")),
                str(TESTS / "web3_codec" / "scenarios.cc"), "-o", str(executable),
            ], capture_output=True, text=True, timeout=180)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("web3 codec scenarios passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
