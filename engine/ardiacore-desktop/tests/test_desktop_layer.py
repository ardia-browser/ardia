import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / 'src'
DESKTOP = SOURCE / 'ardia' / 'desktop'
LINUX = REPO / 'engine/ardiacore-linux/src/ardia/linux'
WIN = REPO / 'scripts/windows/engine/src/ardia/win'
CHROMIUM_HEADERS = ('ac_desktop_document_reducer.h', 'ac_desktop_platform.h', 'ac_desktop_tab_policy.h')
FORBIDDEN_INCLUDE = re.compile(r'#include [<"](unistd\.h|fcntl\.h|sys/|windows\.h|dwmapi\.h|gtk|gio/|glib|dbus/|ui/ozone|ui/gtk|'
                               r'wayland|X11/|ardia/linux/|ardia/win/|libsecret|base/posix/|base/win/)')


def layer_files():
    return sorted(path.name for path in DESKTOP.iterdir() if path.is_file())


def gn_sources(text):
    return re.findall(r'^\s*"([^"/:]+\.(?:h|cc))",$', text, re.M)


class DesktopLayerTests(unittest.TestCase):
    def test_every_source_is_built_exactly_once(self):
        listed = gn_sources((DESKTOP / 'BUILD.gn').read_text())
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(sorted(listed), [name for name in layer_files() if name != 'BUILD.gn'])

    def test_the_layer_names_no_operating_system(self):
        for name in layer_files():
            text = (DESKTOP / name).read_text()
            with self.subTest(name=name):
                self.assertIsNone(FORBIDDEN_INCLUDE.search(text))
                self.assertNotRegex(text, r'\bnamespace [a-z_:]*linux|\bIS_LINUX\b|\bIS_WIN\b|\bOS_LINUX\b|_WIN32\b')
                if name.endswith('.h'):
                    self.assertIn(f'#define ARDIA_DESKTOP_{name[:-2].upper()}_H_', text)

    def test_the_build_serves_linux_and_windows_only(self):
        build = (DESKTOP / 'BUILD.gn').read_text()
        self.assertTrue(build.startswith('assert(is_linux || is_win)\n'))
        self.assertNotIn('$', build)

    def test_the_hosts_link_the_layer_and_no_moved_copy_is_left(self):
        moved = {name[len('ac_desktop_'):] for name in layer_files() if name.startswith('ac_desktop_')}
        for name in moved:
            with self.subTest(name=name):
                self.assertFalse((LINUX / f'ac_linux_{name}').exists())
        self.assertIn('"//ardia/desktop",', (LINUX / 'BUILD.gn').read_text())
        win_build = (WIN / 'BUILD.gn').read_text()
        self.assertIn('"//ardia/desktop",', win_build)
        self.assertIn('"webui/desktop_platform_win.cc",', win_build)

    def test_each_host_provides_the_platform_once(self):
        for host in (LINUX, WIN):
            found = [path for path in host.rglob('*.cc') if 'CreateDesktopPlatform() {' in path.read_text()]
            with self.subTest(host=host.name):
                self.assertEqual(len(found), 1, found)

    def test_every_platform_method_has_a_linux_and_a_windows_implementation(self):
        header = (DESKTOP / 'ac_desktop_platform.h').read_text()
        platform = header[header.index('class DesktopPlatform {'):]
        methods = re.findall(r'virtual [^;(]*?\b(\w+)\(.*= 0;', platform[:platform.index('};')])
        self.assertEqual(len(methods), 9)
        for path in (LINUX / 'ac_linux_desktop_platform.cc', WIN / 'webui/desktop_platform_win.cc'):
            text = path.read_text()
            for method in methods:
                with self.subTest(host=path.name, method=method):
                    self.assertRegex(text, rf'\b{method}\(.*\boverride\b')

    def test_the_capabilities_cover_the_design(self):
        header = (DESKTOP / 'ac_desktop_platform.h').read_text()
        names = re.findall(r'return "(\w+)";', header)
        self.assertEqual(names, ['secrets', 'reauth', 'defaultBrowser', 'loginItem', 'calendar', 'location', 'power',
                                 'openExternal', 'selfUpdate', 'windowDecorations'])

    def test_linux_routes_exactly_its_system_calls_through_the_platform(self):
        platform = (LINUX / 'ac_linux_desktop_platform.h').read_text()
        routed = re.findall(r'"(Ardia[A-Za-z]+\.[A-Za-z]+)"', platform)
        core = (LINUX / 'ac_linux_desktop_core.h').read_text()
        listed = core[core.index('kSystemCapabilities[] = {'):]
        system = re.findall(r'"(Ardia[A-Za-z]+\.[A-Za-z]+)"', listed[:listed.index('};')])
        self.assertEqual(sorted(routed), sorted(system))


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class StandaloneHeaderTests(unittest.TestCase):
    def test_each_plain_header_compiles_on_its_own(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-headers-') as scratch:
            for name in layer_files():
                if not name.endswith('.h') or name in CHROMIUM_HEADERS:
                    continue
                unit = pathlib.Path(scratch, f'{name}.cc')
                unit.write_text(f'#include "ardia/desktop/{name}"\n#include "ardia/desktop/{name}"\n')
                with self.subTest(name=name):
                    result = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsyntax-only',
                                             '-I', str(SOURCE), str(unit)], capture_output=True, text=True, timeout=120)
                    self.assertEqual(result.returncode, 0, result.stderr)


PATHS_PROGRAM = r"""
#include <cassert>
#include <string>
#include <string_view>

#include "ardia/desktop/ac_desktop_paths.h"

namespace paths = ardia::desktop_paths;

struct NarrowPath {
  using StringType = std::string;
  explicit NarrowPath(std::string_view text) : text(text) {}
  const std::string& value() const { return text; }
  std::string AsUTF8Unsafe() const { return "converted"; }
  static NarrowPath FromUTF8Unsafe(std::string_view) { return NarrowPath("converted"); }
  std::string text;
};

struct WidePath {
  using StringType = std::wstring;
  const std::wstring& value() const { return text; }
  std::string AsUTF8Unsafe() const {
    std::string out;
    for (wchar_t c : text) out.push_back(c < 0x80 ? static_cast<char>(c) : '?');
    return out;
  }
  static WidePath FromUTF8Unsafe(std::string_view text) {
    WidePath path;
    for (char c : text) path.text.push_back(static_cast<wchar_t>(static_cast<unsigned char>(c)));
    return path;
  }
  std::wstring text;
};

int main() {
  const std::string raw("/home/u/\xff\xfe not utf-8");
  assert(paths::Text(NarrowPath(raw)) == raw);
  assert(paths::FromText<NarrowPath>(raw).value() == raw);
  assert(paths::FromText<NarrowPath>("").value().empty());
  const WidePath wide = paths::FromText<WidePath>("C:\\Users\\u\\Report Drafts");
  assert(wide.value() == L"C:\\Users\\u\\Report Drafts");
  assert(paths::Text(wide) == "C:\\Users\\u\\Report Drafts");
  return 0;
}
"""


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class PathTextTests(unittest.TestCase):
    def test_narrow_paths_keep_their_bytes_and_wide_paths_convert_through_utf8(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-paths-') as scratch:
            unit = pathlib.Path(scratch, 'paths_test.cc')
            unit.write_text(PATHS_PROGRAM)
            binary = pathlib.Path(scratch, 'paths_test')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', str(SOURCE), str(unit),
                                    '-o', str(binary)], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)


if __name__ == '__main__':
    unittest.main()
