import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATCHES = ROOT.parent / 'patches'
PATCH = PATCHES / 'chromium-linux-ime-password-copies.patch'

COMPOSITION_STUB = '''#ifndef UI_BASE_IME_COMPOSITION_TEXT_H_
#define UI_BASE_IME_COMPOSITION_TEXT_H_
#include <string>
#include <vector>
namespace ui {
struct CompositionText {
  std::u16string text;
  std::vector<int> ime_text_spans;
};
}
#endif
'''

UNICODE_STUB = r'''#ifndef BASE_STRINGS_UTF_STRING_CONVERSION_UTILS_H_
#define BASE_STRINGS_UTF_STRING_CONVERSION_UTILS_H_
#include <cstdint>
#include <string>
#include <string_view>
namespace base_icu {
using UChar32 = int32_t;
}
namespace base {
inline bool ReadUnicodeCharacter(std::string_view src, size_t* index, base_icu::UChar32* out) {
  const unsigned char lead = static_cast<unsigned char>(src[*index]);
  size_t extra = lead < 0x80 ? 0 : (lead >> 5) == 0x6 ? 1 : (lead >> 4) == 0xE ? 2 : (lead >> 3) == 0x1E ? 3 : 4;
  if (extra == 4 || *index + extra >= src.size()) {
    *out = -1;
    return false;
  }
  base_icu::UChar32 code_point = extra == 0 ? lead : lead & (0x3F >> extra);
  for (size_t i = 1; i <= extra; ++i) {
    const unsigned char next = static_cast<unsigned char>(src[*index + i]);
    if ((next & 0xC0) != 0x80) {
      *index += i - 1;
      *out = -1;
      return false;
    }
    code_point = (code_point << 6) | (next & 0x3F);
  }
  *index += extra;
  *out = code_point;
  return true;
}
inline size_t WriteUnicodeCharacter(base_icu::UChar32 code_point, std::u16string* output) {
  if (code_point < 0x10000) {
    output->push_back(static_cast<char16_t>(code_point));
    return 1;
  }
  code_point -= 0x10000;
  output->push_back(static_cast<char16_t>(0xD800 + (code_point >> 10)));
  output->push_back(static_cast<char16_t>(0xDC00 + (code_point & 0x3FF)));
  return 2;
}
}
#endif
'''

SCENARIOS = r'''#include <malloc.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <new>
#include <optional>
#include <string>
#include <utility>
#include <vector>
#include "ui/base/ime/wipe_text.h"

static bool g_watching = false;
static const char16_t* volatile g_escaped = nullptr;
static int g_freed_secrets = 0;

static bool HoldsSecret(const void* block, size_t size) {
  static const char kNarrow[] = "QQQQ";
  static const char kWide[] = {'Q', 0, 'Q', 0, 'Q', 0, 'Q', 0};
  return memmem(block, size, kNarrow, 4) || memmem(block, size, kWide, sizeof(kWide));
}

void* operator new(size_t size) {
  void* block = std::malloc(size ? size : 1);
  if (!block) throw std::bad_alloc();
  return block;
}
void operator delete(void* block) noexcept {
  if (block && g_watching && HoldsSecret(block, malloc_usable_size(block))) ++g_freed_secrets;
  std::free(block);
}
void operator delete(void* block, size_t) noexcept { operator delete(block); }

template <typename Char>
static bool Zero(const Char* units, size_t count) {
  for (size_t i = 0; i <= count; ++i) {
    if (units[i] != 0) return false;
  }
  return true;
}

template <typename Text>
static void WipesInPlace(Text text) {
  const auto* units = text.data();
  const size_t capacity = text.capacity();
  ui::WipeText(text);
  assert(text.empty());
  assert(text.data() == units);
  assert(text.capacity() == capacity);
  assert(Zero(units, capacity));
}

int main() {
  WipesInPlace(std::u16string(u"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"));
  WipesInPlace(std::u16string(u"QQQQQ"));
  WipesInPlace(std::string("QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"));
  WipesInPlace(std::string("QQQQQ"));
  std::u16string shrunk(u"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
  shrunk.assign(u"ab");
  WipesInPlace(std::move(shrunk));

  g_watching = true;
  {
    std::u16string unwiped(u"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
    g_escaped = unwiped.data();
  }
  assert(g_freed_secrets == 1);
  g_freed_secrets = 0;

  std::optional<std::u16string> pending(u"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
  ui::WipeText(pending);
  assert(!pending.has_value());
  {
    ui::CompositionText composition;
    composition.text = u"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
    composition.ime_text_spans.push_back(1);
    ui::WipeComposition(composition);
    assert(composition.text.empty() && composition.ime_text_spans.empty());
  }
  {
    std::u16string replaced(u"QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ");
    ui::WipeText(replaced);
    replaced = std::u16string(u"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
  }
  {
    std::string mixed;
    mixed.reserve(256);
    mixed += "\xC3\xA9";
    for (int i = 0; i < 100; ++i) mixed += 'Q';
    std::u16string converted = ui::UTF8ToUTF16WithoutReallocation(mixed);
    assert(converted.size() == 101 && converted[0] == u'\u00e9' && converted[100] == u'Q');
    ui::WipeText(converted);
    std::string wide;
    wide.reserve(256);
    for (int i = 0; i < 8; ++i) wide += 'Q';
    for (int i = 0; i < 64; ++i) wide += "\xE4\xB8\xAD";
    converted = ui::UTF8ToUTF16WithoutReallocation(wide);
    assert(converted.size() == 72 && converted[8] == u'\u4e2d');
    ui::WipeText(converted);
    ui::WipeText(mixed);
    ui::WipeText(wide);
  }
  {
    std::u16string target;
    std::u16string short_text(u"QQQQQ");
    target = std::move(short_text);
    ui::WipeText(short_text);
    const char16_t* units = short_text.data();
    for (size_t i = 0; i < short_text.capacity(); ++i) assert(units[i] == 0);
    ui::WipeText(target);
  }
  {
    std::optional<std::u16string> moved(std::u16string(40, u'Q'));
    std::optional<std::u16string> taken = std::move(moved);
    moved = std::nullopt;
    ui::WipeText(taken);
  }
  g_watching = false;
  assert(g_freed_secrets == 0);
  {
    std::vector<size_t> offsets = {0, 1, 2, 3, 6, 10, 11, 12};
    bool valid = false;
    std::u16string converted = ui::UTF8ToUTF16WithoutReallocation(
        "a\xC3\xA9\xE2\x82\xAC\xF0\x9F\x98\x80", &offsets, &valid);
    assert(valid);
    assert(converted == u"a\u00e9\u20ac\U0001F600");
    const size_t npos = std::u16string::npos;
    assert((offsets == std::vector<size_t>{0, 1, npos, 2, 3, 5, npos, npos}));
    valid = true;
    converted = ui::UTF8ToUTF16WithoutReallocation("a\xFF" "b", nullptr, &valid);
    assert(!valid && converted == u"a\ufffdb");
  }
  std::puts("wipe text scenarios passed");
}
'''


def added_file(patch, path):
    lines = patch.splitlines()
    start = lines.index(f'+++ b/{path}')
    assert lines[start - 1] == '--- /dev/null'
    body = []
    for line in lines[start + 2:]:
        if not line.startswith('+'):
            break
        body.append(line[1:])
    return '\n'.join(body) + '\n'


def patched_hunks(patch, path):
    text = patch[patch.index(f'+++ b/{path}\n'):]
    end = text.find('\n--- ', 1)
    return text if end == -1 else text[:end]


class ImePasswordCopiesTests(unittest.TestCase):
    patch = PATCH.read_text()

    def test_the_patch_is_a_linux_only_series_step(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        self.assertEqual(names.count(PATCH.name), 1)
        self.assertEqual(steps[names.index(PATCH.name)], ['chromium', PATCH.name, 'linux'])

    def test_the_wipe_helper_zeroes_text_before_its_memory_is_released(self):
        if not sys.platform.startswith('linux'):
            self.skipTest('the scenario watches frees with glibc\'s malloc_usable_size')
        compiler = shutil.which('clang++') or shutil.which('c++')
        self.assertIsNotNone(compiler, 'a C++ compiler (clang++ or c++) is required on Linux')
        with tempfile.TemporaryDirectory(prefix='ardia-wipe-text-') as scratch:
            scratch = pathlib.Path(scratch)
            ime = scratch / 'ui' / 'base' / 'ime'
            ime.mkdir(parents=True)
            (ime / 'wipe_text.h').write_text(added_file(self.patch, 'ui/base/ime/wipe_text.h'))
            (ime / 'composition_text.h').write_text(COMPOSITION_STUB)
            strings = scratch / 'base' / 'strings'
            strings.mkdir(parents=True)
            (strings / 'utf_string_conversion_utils.h').write_text(UNICODE_STUB)
            (scratch / 'scenarios.cc').write_text(SCENARIOS)
            binary = scratch / 'scenarios'
            compiled = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-O2', '-g', '-I', str(scratch),
                                       str(scratch / 'scenarios.cc'), '-o', str(binary)], capture_output=True, text=True, timeout=180)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('wipe text scenarios passed', result.stdout)

    def test_the_helper_is_listed_in_the_ime_types_target(self):
        build = patched_hunks(self.patch, 'ui/base/ime/BUILD.gn')
        self.assertIn('     "text_edit_commands.h",\n+    "wipe_text.h",\n   ]\n \n   defines = [ "IS_UI_BASE_IME_TYPES_IMPL" ]', build)

    def test_wayland_tracks_a_password_client_only_as_a_length_preserving_mask(self):
        context = patched_hunks(self.patch, 'ui/ozone/platform/wayland/host/wayland_input_method_context.cc')
        added = [line[1:] for line in context.splitlines() if line.startswith('+')]
        for plain, masked in (('surrounding_text_tracker_.OnSetCompositionText(preedit);',
                               'surrounding_text_tracker_.OnSetCompositionText(MaskedComposition(preedit));'),
                              ('surrounding_text_tracker_.OnSetCompositionText(composition_text);',
                               'MaskedComposition(composition_text));'),
                              ('surrounding_text_tracker_.Update(text, utf16_offset, selection_range);',
                               'surrounding_text_tracker_.Update(MaskedText(text), utf16_offset,'),
                              ('text_utf16,', 'MaskedText(text_utf16),')):
            at = [index for index, line in enumerate(added) if line.strip() == masked]
            self.assertEqual(len(at), 1, masked)
            branch = added[at[0] - 3:at[0] + 6]
            self.assertTrue(any(line.strip() == 'if (MasksTrackedText()) {' for line in branch), masked)
            self.assertTrue(any(line.strip() == plain for line in branch), plain)
        self.assertIn('  return attributes_.input_type == TEXT_INPUT_TYPE_PASSWORD;', added)
        self.assertIn('  attributes_ = new_client_attributes;\n+  if (MasksTrackedText()) {\n+    surrounding_text_tracker_.Reset();\n'
                      '+    surrounding_text_offset_ = 0;\n+  }', context)
        mask = context[context.index('+std::u16string MaskedText(std::u16string_view text) {'):]
        mask = mask[:mask.index('+}')]
        for unit in ("masked += u'x';", "masked += u'\\u00b7';", "masked += u'\\u2022';", 'masked += u"\\U0001F511";'):
            self.assertIn(unit, mask)
        for wipe in ('  WipeText(preedit.text);', '  WipeText(composition_text.text);', '  WipeText(text_utf16);',
                     '  WipeText(converted);', '    WipeText(converted);', '  WipeText(composed);'):
            self.assertIn(wipe, added)
        test = patched_hunks(self.patch, 'ui/ozone/platform/wayland/host/wayland_input_method_context_unittest.cc')
        self.assertIn('+TEST_P(WaylandInputMethodContextTest, PasswordClientTextIsTrackedMasked) {', test)

    def test_text_input_v3_keeps_no_applied_commit_and_wipes_its_event_strings(self):
        v3 = patched_hunks(self.patch, 'ui/ozone/platform/wayland/host/zwp_text_input_v3.cc')
        self.assertIn('-    self->applied_input_events_.commit =', v3)
        self.assertNotIn('+    self->applied_input_events_.commit =', v3)
        for wipe in ('+  WipeText(self->pending_input_events_.commit);', '+    WipeText(self->applied_input_events_.preedit->text);',
                     '+    WipeText(self->pending_input_events_.preedit->text);', '+  WipeText(commit);', '+    WipeText(preedit->text);'):
            self.assertIn(wipe, v3)
        self.assertIn('-ZwpTextInputV3Impl::InputEvents::~InputEvents() = default;', v3)
        for assign in ('+  preedit->text.assign(text ? text : "");', '+  self->pending_input_events_.commit.assign(text ? text : "");',
                       '   if (!self->client_) {\n+    self->pending_input_events_.Reset();\n     return;'):
            self.assertIn(assign, v3)

    def test_short_strings_are_wiped_after_they_are_moved_from(self):
        aura = patched_hunks(self.patch, 'ui/base/ime/linux/input_method_auralinux.cc')
        self.assertIn('+      result_text_ = std::move(joined);\n+      WipeText(joined);', aura)
        wayland = patched_hunks(self.patch, 'ui/ozone/platform/wayland/host/wayland_input_method_context.cc')
        self.assertIn('+  composition_text.text = std::move(converted_text);\n+  WipeText(converted_text);', wayland)
        pango = patched_hunks(self.patch, 'ui/base/ime/linux/composition_text_util_pango.cc')
        self.assertIn('+  composition->text = std::move(converted);\n+  WipeText(converted);', pango)

    def test_input_method_aura_linux_wipes_every_composition_and_commit_it_drops(self):
        aura = patched_hunks(self.patch, 'ui/base/ime/linux/input_method_auralinux.cc')
        removed = [line[1:].strip() for line in aura.splitlines() if line.startswith('-')]
        added = [line[1:].strip() for line in aura.splitlines() if line.startswith('+')]
        self.assertEqual(removed.count('composition_ = CompositionText();'), 4)
        self.assertNotIn('composition_ = CompositionText();', added)
        self.assertEqual(added.count('WipeComposition(composition_);'), 5)
        self.assertIn('result_text_ = std::nullopt;', removed)
        self.assertIn('result_text_->append(text);', removed)
        self.assertEqual(added.count('WipeText(result_text);'), 3)
        gtk = patched_hunks(self.patch, 'ui/gtk/input_method_context_impl_gtk.cc')
        self.assertIn('+  ui::WipeText(committed);', gtk)
        self.assertIn('+  ui::WipeText(composition_text.text);', gtk)
        self.assertIn('+    for (char& byte : UNSAFE_BUFFERS(base::span(str, strlen(str)))) {\n+      *static_cast<volatile char*>(&byte) = 0;', gtk)
        self.assertIn('std::optional<std::u16string> result_text = std::move(result_text_);', added)
        self.assertIn('if (filtered && NeedInsertChar(result_text)) {', [line[1:].strip() for line in aura.splitlines() if line.startswith(' ')])

    def test_password_text_is_converted_without_reallocating_a_plaintext_buffer(self):
        for path in ('ui/ozone/platform/wayland/host/wayland_input_method_context.cc', 'ui/gtk/input_method_context_impl_gtk.cc',
                     'ui/base/ime/linux/composition_text_util_pango.cc'):
            hunks = patched_hunks(self.patch, path)
            added = [line[1:] for line in hunks.splitlines() if line.startswith('+')]
            removed = [line[1:] for line in hunks.splitlines() if line.startswith('-')]
            self.assertTrue(any('UTF8ToUTF16WithoutReallocation(' in line for line in added), path)
            self.assertTrue(any('base::UTF8ToUTF16' in line for line in removed), path)
            self.assertFalse(any('base::UTF8ToUTF16' in line for line in added), path)
        helper = added_file(self.patch, 'ui/base/ime/wipe_text.h')
        self.assertIn('  converted.reserve(utf8.size());\n', helper)
        self.assertNotIn('shrink_to_fit', helper)


if __name__ == '__main__':
    unittest.main()
