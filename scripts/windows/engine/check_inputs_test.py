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

    def test_a_series_line_for_linux_and_win_still_reaches_windows(self):
        before = self.accepted()
        self.edit('engine/patches/series', 'chromium chromium-helium-branding.patch\n',
                  'chromium chromium-helium-branding.patch linux,win\n')
        result = self.accept()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.accepted(), before)

    def test_a_series_line_for_linux_alone_leaves_windows(self):
        self.edit('engine/patches/series', 'chromium chromium-helium-branding.patch\n',
                  'chromium chromium-helium-branding.patch linux\n')
        result = self.accept()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('chromium-helium-branding.patch', self.accepted()['accepted-patches.txt'].decode().split())

    def test_a_linux_line_series_win_takes_reaches_windows_at_its_place(self):
        self.edit('scripts/windows/engine/series-win', 'take chromium-linux-page-status.patch\n', '')
        result = self.accept()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        without = self.accepted()['accepted-patches.txt'].decode().split()
        self.assertNotIn('chromium-linux-page-status.patch', without)
        self.edit('scripts/windows/engine/series-win', 'take chromium-linux-wheel-zoom.patch\n',
                  'take chromium-linux-wheel-zoom.patch\ntake chromium-linux-page-status.patch\n')
        result = self.accept()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        taken = self.accepted()['accepted-patches.txt'].decode().split()
        self.assertEqual(taken.index('chromium-linux-page-status.patch') + 1, taken.index('chromium-linux-wheel-zoom.patch'))

    def test_a_take_that_names_no_linux_line_is_refused(self):
        for line, error in (('take chromium-linux-no-such.patch\n', 'names no `chromium` line'),
                            ('take chromium-helium-branding.patch\n', 'Windows applies already'),
                            ('take chromium-mac-secure-input-window-focus.patch\n', 'both taken and skipped')):
            with self.subTest(line=line):
                before = self.accepted()
                self.edit('scripts/windows/engine/series-win', 'skip chromium-embedder-discard-veto.patch\n',
                          'skip chromium-embedder-discard-veto.patch\n' + line)
                result = self.accept()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stdout)
                self.assertEqual(self.accepted(), before)
                self.edit('scripts/windows/engine/series-win', line, '')

    def test_a_series_layer_for_win_is_refused_until_windows_runs_series_layers(self):
        before = self.accepted()
        self.edit('engine/patches/series', 'layer engine/ardiacore-linux linux\n', 'layer engine/ardiacore-linux linux,win\n')
        result = self.accept()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('runs no series layer', result.stdout)
        self.assertEqual(self.accepted(), before)


class SelectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, HERE)
        cls.addClassCleanup(sys.path.remove, HERE)
        import series_win
        cls.build = series_win

    def test_series_lines_take_all_mac_and_win_lines(self):
        text = ''.join(f'chromium {name}.patch {tag}\n'.replace(' all\n', '\n') for name, tag in (
            ('shared', 'all'), ('mac', 'mac'), ('linux', 'linux'), ('win', 'win'), ('desktop', 'linux,win'),
            ('posix', 'mac,linux'), ('every', 'mac,linux,win')))
        self.assertEqual(self.build.series_lines(text, 'series'),
                         ['shared.patch', 'mac.patch', 'win.patch', 'desktop.patch', 'posix.patch', 'every.patch'])
        self.assertEqual(len(self.build.series_lines(text, 'series', self.build.SERIES_TAGS)), 7)

    def test_series_lines_refuse_a_selector_they_cannot_read(self):
        for tag in ('windows', 'linux,', ',win', 'linux,linux', 'all,win', 'Linux'):
            with self.subTest(tag=tag), self.assertRaisesRegex(self.build.InputError, 'unknown platform'):
                self.build.series_lines(f'chromium x.patch {tag}\n', 'series')

    def test_windows_takes_a_condition_by_the_platforms_it_names(self):
        for condition, taken in (('is_win', True), ('is_mac', False), ('is_linux', False), ('!is_win', False),
                                 ('!is_mac', True), ('!is_linux', True), ('is_linux || is_win', True),
                                 ('is_mac || is_linux', False), ('!(is_mac || is_linux)', True), ('!is_mac && !is_linux', True),
                                 ('is_win && !is_mac', True), ('is_linux && is_win', False), (' ( is_win ) ', True)):
            with self.subTest(condition=condition):
                self.assertIs(self.build.windows_takes(condition), taken)
        for condition in ('use_ozone', 'is_win && use_ozone', 'is_win ||', '(is_win', 'is_win)', 'is_win == true', ''):
            with self.subTest(condition=condition):
                self.assertIsNone(self.build.windows_takes(condition))

    def test_windows_sources_follow_platform_sets(self):
        text = ('ardia_sources = [\n  "shared.cc",\n]\n\n'
                'if (is_linux || is_win) {\n  ardia_sources += [\n    "desktop.cc",\n  ]\n}\n\n'
                'if (!is_mac) {\n  ardia_sources += [\n    "not_mac.cc",\n  ]\n}\n\n'
                'if (is_mac || is_linux) {\n  ardia_sources += [\n    "posix.cc",\n  ]\n}\n\n'
                'source_set("ardia") {\n  sources = ardia_sources\n}\n')
        self.assertEqual(self.build.windows_sources(text), ['shared.cc', 'desktop.cc', 'not_mac.cc'])
        with self.assertRaisesRegex(self.build.InputError, "can't tell whether it takes `if \\(is_win && use_ozone\\)`"):
            self.build.windows_sources(text.replace('is_linux || is_win', 'is_win && use_ozone'))

    def test_windows_sources_read_a_condition_wrapped_over_lines(self):
        block = 'if ({}) {{\n  ardia_sources += [\n    "{}",\n  ]\n}}\n\n'
        text = ('ardia_sources = [\n  "shared.cc",\n]\n\n'
                + block.format('is_mac ||\n    is_linux', 'posix.cc')
                + block.format('is_linux ||\n    is_win', 'desktop.cc')
                + block.format('!(is_mac ||\n      is_linux)', 'neither.cc')
                + 'source_set("ardia") {\n  sources = ardia_sources\n}\n')
        self.assertEqual(self.build.windows_sources(text), ['shared.cc', 'desktop.cc', 'neither.cc'])

    def test_windows_sources_read_any_layout_of_a_block(self):
        tail = 'source_set("ardia") {\n  sources = ardia_sources\n}\n'
        for text in ('if (is_win) { ardia_sources += [ "x.cc" ] }\n',
                     'if (is_win)\n{\n  ardia_sources += [\n    "x.cc",\n  ]\n}\n',
                     'if (is_win) {\n  ardia_sources += [ "x.cc" ]  # }\n}\n'):
            with self.subTest(text=text):
                self.assertEqual(self.build.windows_sources(text + tail), ['x.cc'])

    def test_windows_sources_follow_else_branches_wrapped_after_a_closing_brace(self):
        text = ('if (is_mac) {\n  ardia_sources += [ "mac.cc" ]\n}\n'
                'else if (is_linux ||\n         is_mac) {\n  ardia_sources += [ "linux.cc" ]\n}\n'
                'else {\n  ardia_sources += [ "other.cc" ]\n}\n\n'
                'if (is_linux || is_win) {\n  ardia_sources += [ "desktop.cc" ]\n} else {\n  ardia_sources += [ "mac_only.cc" ]\n}\n\n'
                'if (is_win) {\n  ardia_sources += [ "first.cc" ]\n} else if (!is_mac) {\n  ardia_sources += [ "second.cc" ]\n}\n\n'
                'source_set("ardia") {\n  sources = ardia_sources\n}\n')
        self.assertEqual(self.build.windows_sources(text), ['other.cc', 'desktop.cc', 'first.cc'])

    def test_windows_sources_ignore_braces_and_quotes_in_comments_and_strings(self):
        text = ('ardia_sources = [\n  "shared.cc",\n]\n\n'
                'if (is_mac) {\n  # {\n  ardia_sources += [ "mac.cc" ]\n  marker = "{ ( \\" }"\n}\n\n'
                'if (is_linux) {\n  # }\n  ardia_sources += [ "linux.cc" ]\n}\n\n'
                'ardia_sources += [ "later.cc" ]\n\n'
                'source_set("ardia") {\n  sources = ardia_sources\n}\n')
        self.assertEqual(self.build.windows_sources(text), ['shared.cc', 'later.cc'])

    def test_windows_sources_refuse_what_they_cannot_follow(self):
        tail = 'source_set("ardia") {\n  sources = ardia_sources\n}\n'
        for text, message in (
                ('if (is_mac ||\n', 'the end of the file'),
                ('if (is_win) {\n  ardia_sources += [ "x.cc" ]\n', 'a block that never closes'),
                ('}\n', 'closes nothing'),
                ('if (is_mac && marker == "(" ||\n    is_win) {\n}\n', "can't tell whether it takes `if \\(is_mac && marker == \"\\(\" \\|\\|\n    is_win\\)`"),
                ('if (is_win) {\n} else if (use_ozone) {\n}\n', "can't tell whether it takes `if \\(use_ozone\\)`"),
                ('ardia_sources += some_list\n', 'with anything but a list of names'),
                ('ardia_sources -= [ "x.cc" ]\n', 'taken out of the list'),
                ('else {\n}\n', 'a statement starting with `else`'),
                ('marker = "unterminated\n', "a character it can't read")):
            with self.subTest(text=text), self.assertRaisesRegex(self.build.InputError, message):
                self.build.windows_sources(text + tail)

    def test_an_assignment_to_ardia_sources_replaces_the_list(self):
        text = ('ardia_sources = [ "old.cc" ]\n'
                'if (is_win) {\n  ardia_sources = [ "new.cc" ]\n}\n'
                'if (is_mac) {\n  ardia_sources = [ "mac.cc" ]\n}\n'
                'ardia_sources += [ "more.cc" ]\n'
                'source_set("ardia") {\n  sources = ardia_sources\n  sources += [ "own.cc" ]\n}\n')
        self.assertEqual(self.build.windows_sources(text), ['new.cc', 'more.cc', 'own.cc'])

    def test_windows_sources_refuse_a_source_spelled_with_dollar_or_backslash(self):
        tail = 'source_set("ardia") {\n  sources = ardia_sources\n}\n'
        for text in ('ardia_sources = [ "desktop.c$0x63" ]\n', 'ardia_sources = [ "${stem}.cc" ]\n',
                     'ardia_sources = [ "desk\\$top.cc" ]\n',
                     'ardia_sources = []\nsource_set("x") {\n  sources += [ "$unit" ]\n}\n'):
            with self.subTest(text=text), self.assertRaisesRegex(self.build.InputError, 'spelled with'):
                self.build.windows_sources(text + tail)

    def test_brackets_that_do_not_pair_fail_cleanly(self):
        tail = 'source_set("ardia") {\n  sources = ardia_sources\n}\n'
        for text in ('print([)\n', 'print({)\n', 'if (is_win && (is_mac]) {\n}\n'):
            with self.subTest(text=text), self.assertRaisesRegex(self.build.InputError, 'to close a bracket'):
                self.build.windows_sources(text + tail)

    def test_the_windows_build_file_keeps_a_line_it_cannot_cut_to_one_entry(self):
        real = self.build.build_text
        line = 'if (is_win) { ardia_sources += [ "desktop.cc" ] } else { ardia_sources += [ "desktop.mm" ] }\n'
        self.addCleanup(setattr, self.build, 'build_text', real)
        self.build.build_text = lambda: real().replace('source_set("ardia") {\n', line + '\nsource_set("ardia") {\n', 1)
        with self.assertRaisesRegex(self.build.InputError, 'this line holds more than one entry'):
            self.build.ardia_build_file()
        self.build.build_text = lambda: real().replace(
            'source_set("ardia") {\n', 'if (is_win) {\n  ardia_sources += [ "desktop.cc" ]\n} else {\n  ardia_sources += [\n'
            '    "desktop.mm",\n  ]\n}\n\nsource_set("ardia") {\n', 1)
        generated = self.build.ardia_build_file()
        self.assertNotIn('desktop.mm', generated)
        self.assertIn('desktop.cc', self.build.windows_sources(generated))

    def test_ardia_sources_changed_inside_a_call_block_is_refused(self):
        tail = 'source_set("ardia") {\n  sources = ardia_sources\n}\n'
        for text in ('ardia_sources = [ "outer.cc" ]\ngroup("local") {\n  ardia_sources = [ "inner.cc" ]\n}\n',
                     'ardia_sources = [ "outer.cc" ]\ntemplate("t") {\n  if (is_win) {\n    ardia_sources += [ "inner.cc" ]\n  }\n}\n',
                     'ardia_sources = [ "outer.cc" ]\nlocal = {\n  ardia_sources = [ "inner.cc" ]\n}\n'):
            with self.subTest(text=text), self.assertRaisesRegex(self.build.InputError, 'a scope of its own'):
                self.build.windows_sources(text + tail)
        self.assertEqual(self.build.windows_sources('ardia_sources = [ "outer.cc" ]\ngroup("local") {\n  deps = []\n}\n' + tail),
                         ['outer.cc'])

    def test_sources_written_inside_a_foreach_loop_are_refused(self):
        head = 'ardia_sources = [ "shared.cc" ]\n'
        for body in ('  sources += [ "ac_passwords_page.cc" ]\n',
                     '  if (is_win) {\n    sources += [ "ac_passwords_page.cc" ]\n  }\n',
                     '  sources = ardia_sources\n',
                     '  sources -= [ "shared.cc" ]\n'):
            text = f'{head}source_set("ardia") {{\n  sources = ardia_sources\n  foreach(item, []) {{\n  {body}  }}\n}}\n'
            with self.subTest(body=body), self.assertRaisesRegex(self.build.InputError, 'inside a `foreach\\(...\\)` loop'):
                self.build.windows_sources(text)
        nested = f'{head}if (is_win) {{\n  foreach(item, []) {{\n    sources += [ "ac_passwords_page.cc" ]\n  }}\n}}\n'
        with self.assertRaisesRegex(self.build.InputError, 'inside a `foreach\\(...\\)` loop'):
            self.build.windows_sources(nested + 'source_set("ardia") {\n  sources = ardia_sources\n}\n')
        reading = f'{head}source_set("ardia") {{\n  sources = ardia_sources\n  foreach(item, sources) {{\n    print(item)\n  }}\n}}\n'
        self.assertEqual(self.build.windows_sources(reading), ['shared.cc'])

    def test_clearing_ardia_sources_then_listing_it_again_passes_the_rewrite_and_the_reader(self):
        real = self.build.build_text
        self.addCleanup(setattr, self.build, 'build_text', real)
        self.build.build_text = lambda: real().replace(
            'source_set("ardia") {\n',
            'ardia_sources = []\nardia_sources = [\n  "ac_zoom.cc",\n  "pip/ac_pip_mac.mm",\n  "ac_shared.cc",\n]\n\n'
            'source_set("ardia") {\n', 1)
        generated = self.build.ardia_build_file()
        self.assertEqual(self.build.windows_sources(generated), ['ac_zoom.cc', 'ac_shared.cc', 'ac_reauth.cc'])
        self.build.build_text = lambda: real().replace('ardia_sources = [\n', 'shared_sources = [\n', 1)
        with self.assertRaisesRegex(self.build.InputError, 'needs the shared source list'):
            self.build.ardia_build_file()

    def test_series_lines_refuse_every_spelling_of_a_series_layer_for_windows(self):
        for line in ('layer engine/extra', 'layer engine/extra all', 'layer engine/extra win', 'layer engine/extra linux,win',
                     'layer engine/extra mac,linux,win'):
            with self.subTest(line=line), self.assertRaisesRegex(self.build.InputError, 'runs no series layer yet but engine/chromium'):
                self.build.series_lines(f'{line}\n', 'series')
        for line in ('layer engine/chromium', 'layer engine/chromium all', 'layer engine/ardiacore mac',
                     'layer engine/ardiacore-linux linux', 'layer engine/extra mac,linux'):
            with self.subTest(line=line):
                self.assertEqual(self.build.series_lines(f'{line}\n', 'series'), [])


if __name__ == '__main__':
    unittest.main()
