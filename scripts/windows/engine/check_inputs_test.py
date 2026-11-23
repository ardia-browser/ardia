#!/usr/bin/env python3
"""Tests for check_inputs.py on a copy of the engine inputs: --accept never writes a list it could not compute.

Usage: python3 scripts/windows/engine/check_inputs_test.py
"""
import gc
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ACCEPTED = ('accepted-patches.txt', 'accepted-layer-sources.txt')


class AcceptTest(unittest.TestCase):
    def setUp(self):
        self.unclosed = []
        caught = warnings.catch_warnings()
        caught.__enter__()
        self.addCleanup(caught.__exit__, None, None, None)
        warnings.simplefilter('error', ResourceWarning)
        self.addCleanup(setattr, sys, 'unraisablehook', sys.unraisablehook)
        sys.unraisablehook = lambda unraisable: self.unclosed.append(repr(unraisable.exc_value))
        self.scratch = tempfile.mkdtemp(prefix='check-inputs-')
        self.root = os.path.join(self.scratch, 'repo')
        shutil.copytree(os.path.join(REPO, 'engine'), os.path.join(self.root, 'engine'), symlinks=True)
        shutil.copytree(HERE, os.path.join(self.root, 'scripts', 'windows', 'engine'), symlinks=True,
                        ignore=shutil.ignore_patterns('__pycache__'))
        app = os.path.join(self.root, 'apps', 'browser', 'windows', 'Ardia')
        os.makedirs(app)
        for name in ('EngineApi.h', 'Ardia.ico'):
            shutil.copyfile(os.path.join(REPO, 'apps', 'browser', 'windows', 'Ardia', name), os.path.join(app, name))
        for game in ('offline-game', 'offline-game-pipeline'):
            shutil.copytree(os.path.join(REPO, 'apps', 'browser', 'assets', game),
                            os.path.join(self.root, 'apps', 'browser', 'assets', game))
        self.engine = os.path.join(self.root, 'scripts', 'windows', 'engine')

    def tearDown(self):
        shutil.rmtree(self.scratch, ignore_errors=True)
        gc.collect()
        self.assertEqual(self.unclosed, [], 'a file was left open')

    def accepted(self):
        found = {}
        for name in ACCEPTED:
            with open(os.path.join(self.engine, name), 'rb') as f:
                found[name] = f.read()
        return found

    def accept(self):
        result = subprocess.run([sys.executable, '-I', '-X', 'dev', '-W', 'error::ResourceWarning',
                                 os.path.join(self.engine, 'check_inputs.py'), '--accept'],
                                capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
        self.assertNotIn('ResourceWarning', result.stderr)
        return result

    def edit(self, rel, old, new):
        path = os.path.join(self.root, rel)
        with open(path, encoding='utf-8') as f:
            text = f.read()
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

    def declare(self, edit):
        path = os.path.join(self.engine, 'key-inputs.json')
        with open(path) as f:
            declared = json.load(f)
        edit(declared)
        with open(path, 'w') as f:
            json.dump(declared, f)

    def test_key_inputs_that_leave_out_the_windows_plan_are_refused(self):
        before = self.accepted()
        self.declare(lambda declared: declared.update(
            trees=[tree for tree in declared['trees'] if tree != 'scripts/windows/engine'] + ['scripts/windows/engine/src'],
            files=declared['files'] + ['scripts/windows/engine/ardia-layer-win.patch'],
            excluded=['engine/patches/build/tests'], excluded_patterns=[]))
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        for path in ('sources scripts/windows/engine/series_win.py', 'sources scripts/windows/engine/04-series.sh',
                     'sources scripts/windows/engine/gn_defines.sh'):
            self.assertIn(path, result.stdout)
        self.assertEqual(self.accepted(), before)

    def test_key_inputs_that_exclude_what_the_build_reads_are_refused(self):
        self.declare(lambda declared: declared['excluded'].append('engine/chromium/src/chrome/browser/ardia'))
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('the Windows build reads engine/chromium/src/chrome/browser/ardia/BUILD.gn, which the Windows key does not hash',
                      result.stdout)

    def test_an_exclusion_spelled_with_dot_is_judged_as_the_key_reads_it(self):
        self.declare(lambda declared: declared['excluded'].append('./scripts/windows/engine/src'))
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('the Windows build reads scripts/windows/engine/src/ardia/win/', result.stdout)

    def test_excluding_a_script_a_build_step_sources_is_refused(self):
        self.declare(lambda declared: declared['excluded'].extend(
            ['engine/patches/build/game-resource.sh', 'scripts/windows/engine/gn_defines.sh']))
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('runs or sources engine/patches/build/game-resource.sh', result.stdout)
        self.assertIn('runs or sources scripts/windows/engine/gn_defines.sh', result.stdout)

    def test_a_new_file_series_win_reads_must_be_in_the_key(self):
        self.edit('scripts/windows/engine/series_win.py', 'def launch_switches_source():\n',
                  'def launch_switches_source():\n    open(os.path.join(REPO, "README.md")).close()\n')
        with open(os.path.join(self.root, 'README.md'), 'w') as f:
            f.write('readme\n')
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('the Windows build reads README.md, which the Windows key does not hash', result.stdout)

    def test_key_inputs_that_drop_a_resource_list_the_branding_reads_are_refused(self):
        self.declare(lambda declared: declared['resource_lists'].remove('scripts/windows/engine/ardia_resources_win.txt'))
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('03-helium.py brands with scripts/windows/engine/ardia_resources_win.txt, which resource_lists does not name',
                      result.stdout)

    def test_key_inputs_that_exclude_the_offline_game_assets_are_refused(self):
        self.declare(lambda declared: declared['excluded'].append('apps/browser/assets/offline-game/assets'))
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('the Windows build reads apps/browser/assets/offline-game/assets/manifest.js, which the Windows key does not hash',
                      result.stdout)

    def test_the_observation_leaves_no_scratch_tree(self):
        scratch = tempfile.mkdtemp(prefix='check-inputs-tmp-')
        self.addCleanup(shutil.rmtree, scratch, True)
        result = subprocess.run([sys.executable, '-I', os.path.join(self.engine, 'check_inputs.py')], capture_output=True,
                                text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': scratch})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(os.listdir(scratch), [])


if __name__ == '__main__':
    unittest.main()
