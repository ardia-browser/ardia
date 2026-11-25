#!/usr/bin/env python3
"""Tests that scripts/windows/engine/prebuilt.json pins the Windows engine key of the commit its engine was built from
(engine/engine-key.sh --platform win <source>), and that the patches the key hashes are the ones series_win.py applies.
Needs the source commit in this checkout (CI checks out with fetch-depth: 0).

Usage: python3 scripts/windows/engine/prebuilt_test.py
"""
import gc
import json
import os
import subprocess
import sys
import unittest
import warnings

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import series_win as build

PREBUILT = os.path.join(build.HERE, 'prebuilt.json')
ENGINE_KEY = os.path.join(build.REPO, 'engine', 'engine-key.sh')


def git(*args):
    return subprocess.run(['git', '-C', build.REPO, *args], capture_output=True, text=True)


class PrebuiltKeyTest(unittest.TestCase):
    def setUp(self):
        self.unclosed = []
        caught = warnings.catch_warnings()
        caught.__enter__()
        self.addCleanup(caught.__exit__, None, None, None)
        warnings.simplefilter('error', ResourceWarning)
        self.addCleanup(setattr, sys, 'unraisablehook', sys.unraisablehook)
        sys.unraisablehook = lambda unraisable: self.unclosed.append(repr(unraisable.exc_value))
        with open(PREBUILT) as f:
            self.pin = json.load(f)

    def tearDown(self):
        gc.collect()
        self.assertEqual(self.unclosed, [], 'a file was left open')

    def test_the_pin_names_its_source_commit_and_key(self):
        self.assertRegex(self.pin.get('source', ''), r'^[0-9a-f]{40}$')
        self.assertRegex(self.pin.get('key', ''), r'^[0-9a-f]{40}$')

    def test_the_key_is_the_windows_key_of_the_source_commit(self):
        source = self.pin['source']
        if git('cat-file', '-e', f'{source}^{{commit}}').returncode != 0:
            self.fail(f'{source}, the prebuilt engine\'s source, is not in this checkout: fetch its history (fetch-depth: 0)')
        keyed = subprocess.run([ENGINE_KEY, '--platform', 'win', source], capture_output=True, text=True)
        self.assertEqual(keyed.returncode, 0, keyed.stderr)
        self.assertEqual(keyed.stdout.strip(), self.pin['key'],
                         f'scripts/windows/engine/prebuilt.json: the Windows key of {source[:12]} is {keyed.stdout.strip()}, '
                         'not the pinned key: pin the key engine/engine-key.sh --platform win gives the engine\'s source commit')

    def test_the_key_hashes_the_patches_the_build_applies_in_order(self):
        planned = build.plan_patches(build.checkout_text)
        self.assertEqual([(name, build.checkout_path(rel)) for name, rel in planned], build.names())
        with open(os.path.join(build.HERE, 'accepted-patches.txt')) as f:
            self.assertEqual([name for name, _ in planned], [line.strip() for line in f])
        steps = subprocess.run([sys.executable, '-I', '-c', KEY_STEPS, build.REPO], capture_output=True, text=True)
        self.assertEqual(steps.returncode, 0, steps.stderr)
        self.assertEqual(steps.stdout.split(), [rel for _, rel in planned])


KEY_STEPS = '''
import importlib.util, pathlib, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('engine_key', pathlib.Path(sys.argv[1], 'engine', 'engine-key.py'))
key = importlib.util.module_from_spec(spec)
spec.loader.exec_module(key)
print('\\n'.join(path for _, path in key.WinPlan(key.WorkTree()).steps))
'''


if __name__ == '__main__':
    unittest.main()
