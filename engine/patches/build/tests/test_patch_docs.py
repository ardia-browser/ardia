#!/usr/bin/env python3
import importlib.util
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parents[4]
SERIES = REPO / 'engine/patches/series'
PATCHES = REPO / 'engine/patches'
SERIES_WIN = REPO / 'scripts/windows/engine/series-win'
SERIES_WIN_SCRIPT = REPO / 'scripts/windows/engine/series_win.py'
WIN_PATCHES = REPO / 'scripts/windows/engine/patches'
ENGINE_DOC = REPO / 'docs/engine-build.md'
WINDOWS_DOC = REPO / 'docs/engine-build-windows.md'

ENGINE_HEADER = ('Patch', 'What it does', 'Removable when')
WINDOWS_HEADER = ('Patch', 'Line', 'What it does', 'Removable when')
PATCH_CELL = re.compile(r'^`([^`\s]+\.patch)`$')
UNESCAPED_PIPE = re.compile(r'(?<!\\)\|')
DELIMITER_CELL = re.compile(r'^:?-{3,}:?$')
FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})')
COMMENT_OPEN = re.compile(r'^ {0,3}<!--')
SERIES_TAGS = ('all', 'mac', 'linux')


def load_series_win():
    spec = importlib.util.spec_from_file_location('series_win', SERIES_WIN_SCRIPT)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


series_win = load_series_win()


def series_patches(text):
    return [fields[1] for fields in (raw.split('#', 1)[0].split() for raw in text.splitlines())
            if fields and fields[0] == 'chromium']


def windows_shared_patches(series_text, takes=()):
    return series_win.series_lines(series_text, 'engine/patches/series', takes=takes)


def windows_own_patches(series_win_text):
    return series_win.series_lines(series_win_text, 'scripts/windows/engine/series-win')


def cells(row):
    return [cell.strip() for cell in UNESCAPED_PIPE.split(row.strip().removeprefix('|').removesuffix('|'))]


def hidden(lines):
    inside, opener, in_comment = {}, None, False
    for n, line in enumerate(lines):
        fence = FENCE.match(line)
        if in_comment:
            inside[n] = 'an HTML comment'
            in_comment = comment_open_after(line, True)
        elif opener is not None:
            inside[n] = 'a code fence'
            if fence and fence.group(1)[0] == opener[0] and len(fence.group(1)) >= len(opener) \
                    and not line.strip()[len(fence.group(1)):].strip():
                opener = None
        elif fence:
            opener = fence.group(1)
            inside[n] = 'a code fence'
        elif '<!--' in CODE_SPAN.sub('', line):
            if COMMENT_OPEN.match(line):
                inside[n] = 'an HTML comment'
            in_comment = comment_open_after(line, False)
    return inside


CODE_SPAN = re.compile(r'(`+)(?!`).*?(?<!`)\1(?!`)')


def comment_open_after(line, open_at_start):
    if not open_at_start:
        line = CODE_SPAN.sub('', line)
    position, is_open = 0, open_at_start
    while True:
        marker = '-->' if is_open else '<!--'
        found = line.find(marker, position)
        if found < 0:
            return is_open
        position, is_open = found + len(marker), not is_open


def is_delimiter(line, width):
    if not line.startswith('|'):
        return False
    row = cells(line)
    return len(row) == width and all(DELIMITER_CELL.match(cell) for cell in row)


def table(doc_text, header, where):
    lines = doc_text.splitlines()
    inside = hidden(lines)
    headed = [n for n, line in enumerate(lines) if line.startswith('|') and tuple(cells(line)) == header]
    starts = [n for n in headed if n not in inside]
    title = f'`| {" | ".join(header)} |`'
    if not starts and headed:
        return None, [f'{where}:{headed[0] + 1}: the table headed {title} is inside {inside[headed[0]]}']
    if len(starts) != 1:
        return None, [f'{where}: expected one table headed {title}, found {len(starts)}']
    start = starts[0]
    if start + 1 >= len(lines) or not is_delimiter(lines[start + 1], len(header)):
        return None, [f'{where}:{start + 2}: the table headed {title} needs a delimiter row of {len(header)} '
                      f'`---` cells under its header']
    rows, problems = [], []
    n = start + 2
    while n < len(lines) and lines[n].startswith('|'):
        row = cells(lines[n])
        if len(row) != len(header):
            problems.append(f'{where}:{n + 1}: {len(row)} cells where the table has {len(header)} (a `|` inside a cell?)')
        else:
            match = PATCH_CELL.match(row[0])
            if not match:
                problems.append(f'{where}:{n + 1}: the first cell is not one `<name>.patch` in backticks: {row[0]}')
            else:
                rows.append((match.group(1), dict(zip(header, row)), n + 1))
        n += 1
    if not rows and not problems:
        problems.append(f'{where}:{start + 1}: the table headed {title} has no rows')
    return rows, problems


def duplicates(rows, where):
    seen, problems = {}, []
    for name, _, line in rows:
        if name in seen:
            problems.append(f'{where}:{line}: `{name}` already has a row at line {seen[name]}')
        seen.setdefault(name, line)
    return problems


HTML_COMMENT = re.compile(r'<!--.*?-->', re.S)
HTML_TAG = re.compile(r'</?[A-Za-z][^>]*>')
HTML_ENTITY = re.compile(r'&(#\d+|#[xX][0-9A-Fa-f]+|[A-Za-z]+);')
LINK = re.compile(r'!?\[([^\]]*)\]\([^)]*\)')
PLACEHOLDER = re.compile(r'^(todo|tbd|tbc|fixme|xxx|n/?a|none|-+|\?+|\.+)$', re.I)


def rendered(cell):
    text = HTML_COMMENT.sub('', cell)
    text = LINK.sub(r'\1', text)
    text = HTML_TAG.sub('', text)
    text = HTML_ENTITY.sub(' ', text)
    return re.sub(r'[`*_~\s]+', ' ', text).strip()


def empty_cells(rows, columns, where):
    return [f'{where}:{line}: `{name}` has an empty {column}'
            for name, row, line in rows for column in columns
            if not re.search(r'[A-Za-z0-9]', rendered(row[column])) or PLACEHOLDER.match(rendered(row[column]))]


def engine_problems(series_text, doc_text, patch_files, where='docs/engine-build.md'):
    rows, problems = table(doc_text, ENGINE_HEADER, where)
    if rows is None:
        return problems
    listed = set(series_patches(series_text))
    documented = {name for name, _, _ in rows}
    problems += duplicates(rows, where)
    problems += empty_cells(rows, ('What it does', 'Removable when'), where)
    for name in sorted(patch_files - listed):
        problems.append(f'engine/patches/{name} has no chromium line in engine/patches/series')
    for name in sorted(listed - patch_files):
        problems.append(f'engine/patches/series names `{name}`, which is not in engine/patches')
    for name in sorted((listed | patch_files) - documented):
        problems.append(f'{where}: `{name}` has no row')
    for name, _, line in rows:
        if name not in listed:
            problems.append(f'{where}:{line}: `{name}` is not a chromium line of engine/patches/series')
        if name not in patch_files:
            problems.append(f'{where}:{line}: `{name}` is not in engine/patches')
    return problems


def windows_problems(series_win_text, series_text, doc_text, win_patch_files, where='docs/engine-build-windows.md'):
    rows, problems = table(doc_text, WINDOWS_HEADER, where)
    if rows is None:
        return problems
    own = set(windows_own_patches(series_win_text))
    skips = series_win.skip_names(series_win_text)
    takes = series_win.take_names(series_win_text)
    selected = set(windows_shared_patches(series_text))
    every_shared = set(series_patches(series_text))
    kinds = {**{name: 'skip' for name in skips}, **{name: 'take' for name in takes}, **{name: 'chromium' for name in own}}
    documented = {name for name, _, _ in rows}
    problems += duplicates(rows, where)
    problems += empty_cells(rows, ('What it does', 'Removable when'), where)
    for name in sorted(skips & own):
        problems.append(f'series-win both skips and applies `{name}`')
    for name in sorted(takes - every_shared):
        problems.append(f'series-win takes `{name}`, but it is not in engine/patches/series')
    for name in sorted(takes & selected):
        problems.append(f'series-win takes `{name}`, which a Windows tree applies already')
    for name in sorted(skips - selected):
        reason = 'a Windows tree never takes it (a `linux` line)' if name in every_shared \
            else 'it is not in engine/patches/series'
        problems.append(f'series-win skips `{name}`, but {reason}')
    for name in sorted(win_patch_files - own):
        problems.append(f'scripts/windows/engine/patches/{name} has no chromium line in series-win')
    for name in sorted(own - win_patch_files):
        problems.append(f'series-win names `{name}`, which is not in scripts/windows/engine/patches')
    for name in sorted((set(kinds) | win_patch_files) - documented):
        problems.append(f'{where}: `{name}` has no row')
    for name, row, line in rows:
        kind = kinds.get(name)
        if kind is None:
            problems.append(f'{where}:{line}: `{name}` is not a line of series-win')
        elif row['Line'] != kind:
            problems.append(f'{where}:{line}: `{name}` says `{row["Line"]}` where series-win has `{kind}`')
    return problems


def patch_names(directory):
    return {path.name for path in directory.glob('*.patch')}


ENGINE_DOC_SAMPLE = '''# Doc

| Patch | What it does | Removable when |
|---|---|---|
| `chromium-a.patch` | Does a | Upstream fixes a |
| `chromium-b.patch` | Does b | Never: Ardia feature |

After.
'''

WINDOWS_DOC_SAMPLE = '''| Patch | Line | What it does | Removable when |
|---|---|---|---|
| `chromium-b.patch` | skip | Mac only | With the Mac patch |
| `chromium-win-c.patch` | chromium | Does c | Never |
'''


class RealDocs(unittest.TestCase):
    def test_every_engine_patch_has_a_row_saying_when_it_can_go(self):
        problems = engine_problems(SERIES.read_text(encoding='utf-8'), ENGINE_DOC.read_text(encoding='utf-8'),
                                   patch_names(PATCHES))
        self.assertEqual(problems, [], '\n' + '\n'.join(problems))

    def test_every_series_win_line_has_a_row_saying_when_it_can_go(self):
        problems = windows_problems(SERIES_WIN.read_text(encoding='utf-8'), SERIES.read_text(encoding='utf-8'),
                                    WINDOWS_DOC.read_text(encoding='utf-8'), patch_names(WIN_PATCHES))
        self.assertEqual(problems, [], '\n' + '\n'.join(problems))

    def test_the_checks_read_real_patches(self):
        self.assertGreater(len(patch_names(PATCHES)), 100)
        self.assertGreater(len(patch_names(WIN_PATCHES)), 10)


class EngineChecker(unittest.TestCase):
    series = 'chromium chromium-a.patch\nchromium chromium-b.patch mac\nlayer engine/chromium\n'
    files = {'chromium-a.patch', 'chromium-b.patch'}

    def check(self, series=None, doc=ENGINE_DOC_SAMPLE, files=None):
        return engine_problems(self.series if series is None else series, doc,
                               self.files if files is None else files, 'doc')

    def test_a_complete_table_passes(self):
        self.assertEqual(self.check(), [])

    def test_a_series_patch_without_a_row_fails(self):
        self.assertEqual(self.check(series=self.series + 'chromium chromium-new.patch linux\n',
                                    files=self.files | {'chromium-new.patch'}),
                         ['doc: `chromium-new.patch` has no row'])

    def test_a_patch_on_disk_outside_the_series_and_the_table_fails(self):
        self.assertEqual(self.check(files=self.files | {'chromium-loose.patch'}),
                         ['engine/patches/chromium-loose.patch has no chromium line in engine/patches/series',
                          'doc: `chromium-loose.patch` has no row'])

    def test_an_empty_series_fails_though_every_row_is_there(self):
        self.assertEqual(self.check(series=''),
                         ['engine/patches/chromium-a.patch has no chromium line in engine/patches/series',
                          'engine/patches/chromium-b.patch has no chromium line in engine/patches/series',
                          'doc:5: `chromium-a.patch` is not a chromium line of engine/patches/series',
                          'doc:6: `chromium-b.patch` is not a chromium line of engine/patches/series'])

    def test_a_header_only_table_fails(self):
        doc = '| Patch | What it does | Removable when |\n|---|---|---|\n'
        self.assertEqual(self.check(series='', doc=doc),
                         ['doc:1: the table headed `| Patch | What it does | Removable when |` has no rows',
                          'engine/patches/chromium-a.patch has no chromium line in engine/patches/series',
                          'engine/patches/chromium-b.patch has no chromium line in engine/patches/series',
                          'doc: `chromium-a.patch` has no row',
                          'doc: `chromium-b.patch` has no row'])

    def test_prose_in_place_of_the_delimiter_row_fails(self):
        self.assertEqual(self.check(doc=ENGINE_DOC_SAMPLE.replace('|---|---|---|', 'Some prose.')),
                         ['doc:4: the table headed `| Patch | What it does | Removable when |` needs a delimiter '
                          'row of 3 `---` cells under its header'])

    def test_a_delimiter_row_of_the_wrong_width_fails(self):
        self.assertEqual(len(self.check(doc=ENGINE_DOC_SAMPLE.replace('|---|---|---|', '|---|---|'))), 1)

    def test_an_aligned_delimiter_row_passes(self):
        self.assertEqual(self.check(doc=ENGINE_DOC_SAMPLE.replace('|---|---|---|', '| :--- | :---: | ---: |')), [])

    def test_a_table_inside_a_code_fence_fails(self):
        self.assertEqual(self.check(doc='```markdown\n' + ENGINE_DOC_SAMPLE + '```\n'),
                         ['doc:4: the table headed `| Patch | What it does | Removable when |` is inside a code fence'])

    def test_a_table_inside_a_multiline_html_comment_fails(self):
        self.assertEqual(self.check(doc='<!--\n' + ENGINE_DOC_SAMPLE + '-->\n'),
                         ['doc:4: the table headed `| Patch | What it does | Removable when |` is inside an HTML comment'])

    def test_a_comment_closing_later_on_a_text_line_still_hides_the_table(self):
        doc = '<!-- old inventory\n' + ENGINE_DOC_SAMPLE.replace('After.', 'After. -->')
        self.assertEqual(len(self.check(doc=doc)), 1)

    def test_a_second_comment_opened_after_a_closing_marker_hides_the_table(self):
        for opener in ('<!-- a --> <!--\n', 'text <!-- a --> more <!--\n', 'intro <!--\n'):
            self.assertEqual(len(self.check(doc=opener + ENGINE_DOC_SAMPLE + '-->\n')), 1, opener)

    def test_a_comment_marker_inside_a_code_span_hides_nothing(self):
        for line in ('Use `<!--` to start a comment.\n', 'Write ``<!-- a`` or `<!--`.\n'):
            self.assertEqual(self.check(doc=line + ENGINE_DOC_SAMPLE), [], line)

    def test_comments_that_all_close_on_their_line_hide_nothing(self):
        self.assertEqual(self.check(doc='<!-- a --> text <!-- b -->\n' + ENGINE_DOC_SAMPLE), [])

    def test_a_one_line_comment_before_the_table_passes(self):
        self.assertEqual(self.check(doc='<!-- note -->\n' + ENGINE_DOC_SAMPLE), [])

    def test_a_table_after_a_closed_multiline_comment_passes(self):
        self.assertEqual(self.check(doc='<!--\nhidden\n-->\n\n' + ENGINE_DOC_SAMPLE), [])

    def test_a_comment_marker_inside_a_fence_hides_nothing_after_it(self):
        self.assertEqual(self.check(doc='```\n<!--\n```\n\n' + ENGINE_DOC_SAMPLE), [])

    def test_a_fence_marker_inside_a_comment_opens_no_fence(self):
        self.assertEqual(self.check(doc='<!--\n```\n-->\n\n' + ENGINE_DOC_SAMPLE), [])

    def test_a_tilde_fence_counts_too(self):
        self.assertEqual(len(self.check(doc='~~~\n' + ENGINE_DOC_SAMPLE + '~~~\n')), 1)

    def test_a_table_after_a_closed_fence_passes(self):
        self.assertEqual(self.check(doc='```\ncode\n```\n\n' + ENGINE_DOC_SAMPLE), [])

    def test_an_empty_removable_when_fails(self):
        self.assertEqual(self.check(doc=ENGINE_DOC_SAMPLE.replace('Upstream fixes a', '')),
                         ['doc:5: `chromium-a.patch` has an empty Removable when'])

    def test_a_removable_when_that_renders_nothing_fails(self):
        for blank in ('<!-- TODO -->', 'TODO', 'n/a', '-', '`` **  **', '<br>', '[](x)', '&#160;', '<span></span>', '<BR>', '&nbsp; &#xA0;', '\\|'):
            self.assertEqual(self.check(doc=ENGINE_DOC_SAMPLE.replace('Upstream fixes a', blank)),
                             ['doc:5: `chromium-a.patch` has an empty Removable when'], blank)

    def test_a_row_for_a_removed_patch_fails(self):
        self.assertEqual(self.check(series='chromium chromium-a.patch\n', files={'chromium-a.patch'}),
                         ['doc:6: `chromium-b.patch` is not a chromium line of engine/patches/series',
                          'doc:6: `chromium-b.patch` is not in engine/patches'])

    def test_a_listed_patch_missing_from_disk_fails(self):
        self.assertEqual(self.check(files={'chromium-a.patch'}),
                         ['engine/patches/series names `chromium-b.patch`, which is not in engine/patches',
                          'doc:6: `chromium-b.patch` is not in engine/patches'])

    def test_a_commented_line_is_not_in_the_series(self):
        self.assertIn('doc:6: `chromium-b.patch` is not a chromium line of engine/patches/series',
                      self.check(series='chromium chromium-a.patch\n# chromium chromium-b.patch\n'))

    def test_a_pipe_inside_a_cell_fails(self):
        self.assertIn('doc:5: 4 cells where the table has 3 (a `|` inside a cell?)',
                      self.check(doc=ENGINE_DOC_SAMPLE.replace('Does a', 'Does a | b')))

    def test_an_escaped_pipe_stays_in_its_cell(self):
        self.assertEqual(self.check(doc=ENGINE_DOC_SAMPLE.replace('Does a', 'Does `a\\|b`')), [])

    def test_a_duplicate_row_fails(self):
        doc = ENGINE_DOC_SAMPLE.replace('\nAfter.', '| `chromium-a.patch` | Again | Later |\n\nAfter.')
        self.assertEqual(self.check(doc=doc), ['doc:7: `chromium-a.patch` already has a row at line 5'])

    def test_a_missing_table_fails(self):
        self.assertEqual(self.check(doc='# Doc\n'),
                         ['doc: expected one table headed `| Patch | What it does | Removable when |`, found 0'])


class WindowsChecker(unittest.TestCase):
    series = 'chromium chromium-a.patch\nchromium chromium-b.patch mac\nchromium chromium-l.patch linux\n'
    series_win = 'skip chromium-b.patch\nchromium chromium-win-c.patch\n'
    files = {'chromium-win-c.patch'}

    def check(self, series_win=None, doc=WINDOWS_DOC_SAMPLE, files=None, series=None):
        return windows_problems(self.series_win if series_win is None else series_win,
                                self.series if series is None else series, doc,
                                self.files if files is None else files, 'doc')

    def test_a_complete_table_passes(self):
        self.assertEqual(self.check(), [])

    def test_a_line_without_a_row_fails(self):
        self.assertEqual(self.check(series_win=self.series_win + 'chromium chromium-win-d.patch\n',
                                    files=self.files | {'chromium-win-d.patch'}),
                         ['doc: `chromium-win-d.patch` has no row'])

    def test_a_patch_file_without_a_line_or_row_fails(self):
        self.assertEqual(self.check(files=self.files | {'chromium-win-e.patch'}),
                         ['scripts/windows/engine/patches/chromium-win-e.patch has no chromium line in series-win',
                          'doc: `chromium-win-e.patch` has no row'])

    def test_an_empty_series_win_fails_though_every_row_is_there(self):
        self.assertEqual(self.check(series_win=''),
                         ['scripts/windows/engine/patches/chromium-win-c.patch has no chromium line in series-win',
                          'doc:3: `chromium-b.patch` is not a line of series-win',
                          'doc:4: `chromium-win-c.patch` is not a line of series-win'])

    def test_a_skip_of_a_linux_only_patch_fails(self):
        self.assertEqual(self.check(series='chromium chromium-a.patch\nchromium chromium-b.patch linux\n'),
                         ['series-win skips `chromium-b.patch`, but a Windows tree never takes it (a `linux` line)'])

    def test_a_skip_of_nothing_fails(self):
        self.assertEqual(self.check(series='chromium chromium-a.patch\n'),
                         ['series-win skips `chromium-b.patch`, but it is not in engine/patches/series'])

    def test_an_untagged_patch_can_be_skipped(self):
        self.assertEqual(self.check(series='chromium chromium-b.patch\n'), [])

    def test_a_patch_both_skipped_and_applied_fails(self):
        self.assertIn('series-win both skips and applies `chromium-win-c.patch`',
                      self.check(series_win=self.series_win + 'skip chromium-win-c.patch\n'))

    def test_a_take_of_a_linux_line_needs_a_take_row(self):
        series_win = self.series_win + 'take chromium-l.patch\n'
        self.assertEqual(self.check(series_win=series_win), ['doc: `chromium-l.patch` has no row'])
        doc = WINDOWS_DOC_SAMPLE + '| `chromium-l.patch` | take | Linux hooks | Series sets |\n'
        self.assertEqual(self.check(series_win=series_win, doc=doc), [])
        self.assertEqual(self.check(series_win=series_win, doc=doc.replace('| take |', '| chromium |')),
                         ['doc:5: `chromium-l.patch` says `chromium` where series-win has `take`'])

    def test_a_take_of_a_line_windows_applies_or_of_nothing_fails(self):
        doc = WINDOWS_DOC_SAMPLE + '| `chromium-a.patch` | take | Shared | Never |\n'
        self.assertEqual(self.check(series_win=self.series_win + 'take chromium-a.patch\n', doc=doc),
                         ['series-win takes `chromium-a.patch`, which a Windows tree applies already'])
        doc = WINDOWS_DOC_SAMPLE + '| `chromium-z.patch` | take | Gone | Never |\n'
        self.assertEqual(self.check(series_win=self.series_win + 'take chromium-z.patch\n', doc=doc),
                         ['series-win takes `chromium-z.patch`, but it is not in engine/patches/series'])

    def test_an_empty_removable_when_fails(self):
        self.assertEqual(self.check(doc=WINDOWS_DOC_SAMPLE.replace('With the Mac patch', '')),
                         ['doc:3: `chromium-b.patch` has an empty Removable when'])

    def test_a_row_for_a_removed_line_fails(self):
        self.assertEqual(self.check(series_win='chromium chromium-win-c.patch\n'),
                         ['doc:3: `chromium-b.patch` is not a line of series-win'])

    def test_a_wrong_line_kind_fails(self):
        self.assertEqual(self.check(doc=WINDOWS_DOC_SAMPLE.replace('| skip |', '| chromium |')),
                         ['doc:3: `chromium-b.patch` says `chromium` where series-win has `skip`'])

    def test_a_windows_patch_missing_from_disk_fails(self):
        self.assertEqual(self.check(files=set()),
                         ['series-win names `chromium-win-c.patch`, which is not in scripts/windows/engine/patches'])

    def test_prose_in_place_of_the_delimiter_row_fails(self):
        self.assertEqual(len(self.check(doc=WINDOWS_DOC_SAMPLE.replace('|---|---|---|---|', 'Prose.'))), 1)

    def test_a_table_inside_a_code_fence_fails(self):
        self.assertEqual(len(self.check(doc='```\n' + WINDOWS_DOC_SAMPLE + '```\n')), 1)

    def test_a_table_inside_an_html_comment_fails(self):
        self.assertEqual(self.check(doc='<!--\n' + WINDOWS_DOC_SAMPLE + '-->\n'),
                         ['doc:2: the table headed `| Patch | Line | What it does | Removable when |` is inside an HTML comment'])


if __name__ == '__main__':
    unittest.main()
