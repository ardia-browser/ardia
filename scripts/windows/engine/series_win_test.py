#!/usr/bin/env python3
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import series_win as build

BASE = {
    'a.txt': ''.join(f'a line {n}\n' for n in range(1, 21)),
    'b.txt': ''.join(f'b line {n}\n' for n in range(1, 21)),
}


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.mkdtemp(prefix='series-win-ledger-')
        self.addCleanup(shutil.rmtree, self.scratch, ignore_errors=True)
        self.tree = os.path.join(self.scratch, 'chromium', 'src')
        self.patches = os.path.join(self.scratch, 'patches')
        os.makedirs(self.tree)
        os.makedirs(self.patches)
        self.write_tree(BASE)

    def write_tree(self, files):
        for rel, text in files.items():
            with open(os.path.join(self.tree, rel), 'w') as f:
                f.write(text)

    def tree_files(self):
        found = {}
        for rel in BASE:
            with open(os.path.join(self.tree, rel)) as f:
                found[rel] = f.read()
        return found

    def patch(self, name, rel, before, after, base=None):
        old = (base or BASE)[rel]
        assert before in old, before
        scratch = tempfile.mkdtemp(dir=self.scratch)
        for side, text in (('a', old), ('b', old.replace(before, after, 1))):
            os.makedirs(os.path.join(scratch, side))
            with open(os.path.join(scratch, side, rel), 'w') as f:
                f.write(text)
        diff = subprocess.run(['diff', '-u', '--label', f'a/{rel}', '--label', f'b/{rel}', f'a/{rel}', f'b/{rel}'],
                              cwd=scratch, capture_output=True, text=True).stdout
        path = os.path.join(self.patches, name)
        with open(path, 'w') as f:
            f.write(diff)
        return name, path

    def apply(self, plan):
        with contextlib.redirect_stdout(io.StringIO()):
            return build.apply_plan(self.tree, plan)

    def rewind(self, plan):
        with contextlib.redirect_stdout(io.StringIO()):
            return build.rewind(self.tree, plan)

    def test_each_applied_patch_is_recorded_with_its_place_content_and_a_copy(self):
        plan = [self.patch('one.patch', 'a.txt', 'a line 3\n', 'a line three\n'),
                self.patch('two.patch', 'b.txt', 'b line 9\n', 'b line nine\n')]
        rows, failed = self.apply(plan)
        self.assertEqual(failed, 0)
        self.assertEqual([r[1] for r in rows], ['clean', 'clean'])
        self.assertEqual(build.read_ledger(self.tree),
                         [(0, 'one.patch', build.patch_digest(plan[0][1])), (1, 'two.patch', build.patch_digest(plan[1][1]))])
        self.assertTrue(os.path.isfile(build.copy_of(self.tree, 1, 'two.patch')))
        rows, failed = self.apply(plan)
        self.assertEqual([r[1] for r in rows], ['already applied', 'already applied'])

    def test_a_recorded_patch_whose_content_changed_is_refused_before_anything_is_patched(self):
        first = self.patch('one.patch', 'a.txt', 'a line 3\n', 'a line three\n')
        self.apply([first])
        changed = self.patch('one.patch', 'a.txt', 'a line 3\n', 'a line THREE\n')
        later = self.patch('two.patch', 'b.txt', 'b line 9\n', 'b line nine\n')
        before = self.tree_files()
        with self.assertRaisesRegex(build.InputError, 'other content than the current patch'):
            self.apply([changed, later])
        self.assertEqual(self.tree_files(), before)

    def test_a_patch_taken_earlier_in_the_plan_is_refused_before_anything_is_patched(self):
        win = self.patch('win.patch', 'a.txt', 'a line 10\n', 'a line ten\n')
        self.apply([win])
        taken = self.patch('taken.patch', 'a.txt', 'a line 9\n', 'a line nine\n')
        before = self.tree_files()
        with self.assertRaisesRegex(build.InputError, 'at place 0, where the plan applies taken.patch'):
            self.apply([taken, win])
        self.assertEqual(self.tree_files(), before)

    def test_rewind_reverses_back_to_where_the_plans_part_and_apply_then_matches_a_fresh_tree(self):
        shared = self.patch('shared.patch', 'b.txt', 'b line 2\n', 'b line two\n')
        old_win = self.patch('win.patch', 'a.txt', 'a line 10\n', 'a line ten\n')
        self.apply([shared, old_win])
        taken = self.patch('taken.patch', 'a.txt', 'a line 9\n', 'a line nine\n')
        rebased = self.patch('win.patch', 'a.txt', 'a line 10\n', 'a line ten\n',
                             base={'a.txt': BASE['a.txt'].replace('a line 9\n', 'a line nine\n')})
        plan = [shared, taken, rebased]
        self.assertEqual(self.rewind(plan), 1)
        self.assertEqual(build.read_ledger(self.tree), [(0, 'shared.patch', build.patch_digest(shared[1]))])
        self.assertFalse(os.path.exists(build.copy_of(self.tree, 1, 'win.patch')))
        rows, failed = self.apply(plan)
        self.assertEqual(failed, 0)
        self.assertEqual([r[1] for r in rows], ['already applied', 'clean', 'clean'])
        expected = dict(BASE)
        expected['a.txt'] = BASE['a.txt'].replace('a line 9\n', 'a line nine\n').replace('a line 10\n', 'a line ten\n')
        expected['b.txt'] = BASE['b.txt'].replace('b line 2\n', 'b line two\n')
        self.assertEqual(self.tree_files(), expected)

    def test_a_failed_patch_stops_apply_and_a_retry_resumes_in_plan_order(self):
        first = self.patch('first.patch', 'a.txt', 'a line 3\n', 'a line three\n')
        second = self.patch('second.patch', 'b.txt', 'b line 9\n', 'b line nine\n')
        self.write_tree({'a.txt': BASE['a.txt'].replace('a line 2\na line 3\na line 4\n', 'drifted\n')})
        rows, failed = self.apply([first, second])
        self.assertEqual(failed, 1)
        self.assertEqual([r[1] for r in rows], ['FAILED', 'not reached'])
        skipped = [('skipped.patch', 'skipped (series-win)', 'OS-neutral', '')]
        self.assertEqual(build.apply_summary(skipped + rows), '0 of 2 patches in, 1 skipped, 1 failed, 1 not reached')
        self.assertEqual(build.read_ledger(self.tree), [])
        self.assertEqual(self.tree_files()['b.txt'], BASE['b.txt'])
        self.write_tree({'a.txt': BASE['a.txt']})
        rows, failed = self.apply([first, second])
        self.assertEqual(failed, 0)
        self.assertEqual([r[1] for r in rows], ['clean', 'clean'])
        self.assertEqual([entry[:2] for entry in build.read_ledger(self.tree)], [(0, 'first.patch'), (1, 'second.patch')])
        self.assertEqual(build.apply_summary(rows), '2 of 2 patches in, 0 skipped')
        rows, failed = self.apply([first, second])
        self.assertEqual([r[1] for r in rows], ['already applied', 'already applied'])

    def test_a_ledger_with_a_hole_is_refused_as_out_of_order(self):
        first = self.patch('first.patch', 'a.txt', 'a line 3\n', 'a line three\n')
        second = self.patch('second.patch', 'b.txt', 'b line 9\n', 'b line nine\n')
        build.write_ledger(self.tree, [(1, 'second.patch', build.patch_digest(second[1]))])
        with self.assertRaisesRegex(build.InputError, 'out of order'):
            self.apply([first, second])

    def test_a_name_only_ledger_is_kept_when_it_is_a_prefix_the_tree_still_carries_and_refused_otherwise(self):
        one = self.patch('one.patch', 'a.txt', 'a line 3\n', 'a line three\n')
        two = self.patch('two.patch', 'b.txt', 'b line 9\n', 'b line nine\n')
        subprocess.run(['git', 'apply', one[1]], cwd=self.tree, check=True)
        with open(build.state_path(self.tree), 'w') as f:
            f.write('one.patch\n')
        rows, failed = self.apply([one, two])
        self.assertEqual([r[1] for r in rows], ['already applied', 'clean'])
        self.assertEqual([entry[:2] for entry in build.read_ledger(self.tree)], [(0, 'one.patch'), (1, 'two.patch')])
        self.assertTrue(os.path.isfile(build.copy_of(self.tree, 0, 'one.patch')))
        with open(build.state_path(self.tree), 'w') as f:
            f.write('two.patch\n')
        with self.assertRaisesRegex(build.InputError, 'rewind'):
            self.apply([one, two])
        with self.assertRaisesRegex(build.InputError, 'no copy of two.patch'):
            self.rewind([one, two])


if __name__ == '__main__':
    unittest.main()
