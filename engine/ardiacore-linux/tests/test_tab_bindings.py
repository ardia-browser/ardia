import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'


class TabBindingsTests(unittest.TestCase):
    def test_taking_a_binding_erases_it_and_its_per_tab_state_before_it_is_destroyed(self):
        with tempfile.TemporaryDirectory(prefix='ardia-tab-bindings-') as directory:
            binary = Path(directory) / 'tab-bindings'
            subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(SOURCE),
                            str(ROOT / 'tests/tab_bindings_test.cc'), '-o', str(binary)],
                           check=True, text=True, timeout=180)
            result = subprocess.run([str(binary)], text=True, timeout=60, capture_output=True,
                                    env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, 'ok\n')


if __name__ == '__main__':
    unittest.main()
