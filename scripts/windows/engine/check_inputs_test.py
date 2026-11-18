#!/usr/bin/env python3
"""Tests for check_inputs.py on a copy of the engine inputs: --accept never writes a list it could not compute.

Usage: python3 scripts/windows/engine/check_inputs_test.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ACCEPTED = ('accepted-patches.txt', 'accepted-layer-sources.txt')


class AcceptTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix='check-inputs-')
        self.root = os.path.join(self.scratch, 'repo')
        shutil.copytree(os.path.join(REPO, 'engine'), os.path.join(self.root, 'engine'), symlinks=True)
        shutil.copytree(HERE, os.path.join(self.root, 'scripts', 'windows', 'engine'), symlinks=True,
                        ignore=shutil.ignore_patterns('__pycache__'))
        self.engine = os.path.join(self.root, 'scripts', 'windows', 'engine')

    def tearDown(self):
        shutil.rmtree(self.scratch, ignore_errors=True)

    def accepted(self):
        return {name: open(os.path.join(self.engine, name), 'rb').read() for name in ACCEPTED}

    def accept(self):
        return subprocess.run([sys.executable, '-I', os.path.join(self.engine, 'check_inputs.py'), '--accept'],
                              capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})

    def edit(self, rel, old, new):
        path = os.path.join(self.root, rel)
        text = open(path, encoding='utf-8').read()
        self.assertIn(old, text, rel)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text.replace(old, new, 1))

    def test_accepting_the_tree_as_it_is_changes_nothing(self):
        before = self.accepted()
        result = self.accept()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.accepted(), before)

    def test_a_series_line_it_cannot_read_writes_nothing(self):
        before = self.accepted()
        self.edit('engine/patches/series', 'chromium chromium-helium-branding.patch\n',
                  'chromium chromium-helium-branding.patch windows\n')
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('nothing accepted', result.stdout)
        self.assertEqual(self.accepted(), before)

    def test_a_build_file_it_cannot_read_writes_nothing(self):
        before = self.accepted()
        self.edit('engine/chromium/src/chrome/browser/ardia/BUILD.gn', 'assert(is_mac || is_linux)', 'assert(true)')
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('nothing accepted', result.stdout)
        self.assertEqual(self.accepted(), before)

    def test_a_target_whose_sources_replace_the_shared_list_is_refused(self):
        before = self.accepted()
        self.edit('engine/chromium/src/chrome/browser/ardia/BUILD.gn', '  sources = ardia_sources\n',
                  '  sources = [\n    "ac_engine.cc",\n  ]\n')
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('only follows', result.stdout)
        self.assertEqual(self.accepted(), before)

    def test_a_target_that_takes_sources_out_is_refused(self):
        before = self.accepted()
        self.edit('engine/chromium/src/chrome/browser/ardia/BUILD.gn', '  sources = ardia_sources\n',
                  '  sources = ardia_sources\n  sources -= [ "ac_zoom.cc" ]\n')
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('only follows', result.stdout)
        self.assertEqual(self.accepted(), before)


if __name__ == '__main__':
    unittest.main()
