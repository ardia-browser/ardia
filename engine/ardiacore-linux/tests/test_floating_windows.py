import importlib.util
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
LINUX = SOURCE / 'ardia' / 'linux'
PATCHES = ROOT.parent / 'patches'
REPO = ROOT.parents[1]
PATCH = PATCHES / 'chromium-linux-floating-windows.patch'
WIDGET = 'chrome/browser/ui/views/frame/browser_native_widget_aura_linux.cc'
WIDGET_HEADER = 'chrome/browser/ui/views/frame/browser_widget.h'

CORE = r'''#include <cassert>
#include <cstring>
#include "ardia/linux/ac_linux_window_lifecycle.h"

using namespace ardia::linux_window;

int main() {
  assert(std::strcmp(WindowClass("", true), "ardia-little") == 0);
  assert(std::strcmp(WindowClass("settings", false), "ardia-settings") == 0);
  assert(std::strcmp(WindowClass("import", false), "ardia-import") == 0);
  assert(std::strcmp(WindowClass("settings", true), "ardia-settings") == 0);
  assert(WindowClass("", false) == nullptr);
  assert(WindowClass("unknown", false) == nullptr);
  assert(OpensPinned("", true, false));
  assert(OpensPinned("settings", false, false));
  assert(OpensPinned("import", false, false));
  assert(!OpensPinned("", false, false));
  assert(!OpensPinned("settings", false, true));
  assert(!OpensPinned("", true, true));
  assert(kPinnedSizeHoldMs > 0 && kPinnedSizeHoldMs < kPinnedSizeLimitMs);
  assert(PinnedSizeReleaseDelayMs(0) == kPinnedSizeHoldMs);
  assert(PinnedSizeReleaseDelayMs(kPinnedSizeLimitMs - kPinnedSizeHoldMs) == kPinnedSizeHoldMs);
  assert(PinnedSizeReleaseDelayMs(2900) == 100);
  assert(PinnedSizeReleaseDelayMs(kPinnedSizeLimitMs) == 0);
  assert(PinnedSizeReleaseDelayMs(kPinnedSizeLimitMs + 500) == 0);
  return 0;
}
'''

WIDGET_FIXTURE = '''#include "chrome/browser/ui/views/frame/browser_native_widget_aura_linux.h"

#include <string>

#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/browser_widget.h"

bool ArdiaLinuxFramelessApp(const BrowserWindowInterface* browser);

BrowserNativeWidgetAuraLinux::BrowserNativeWidgetAuraLinux(
    BrowserWidget* browser_widget,
    BrowserView* browser_view)
    : BrowserNativeWidgetAura(browser_widget, browser_view) {
}
''' + '\n' * 60 + '''BrowserNativeWidgetAuraLinux::WindowClass
BrowserNativeWidgetAuraLinux::GetWindowClass() const {
  WindowClass window_class;
  if (is_app && browser.GetProfile()) {
    window_class.wayland_app_id = app_id;
  } else {
    window_class.wayland_app_id = window_class.wm_class_class;
    if (!is_app && browser.GetProfile()) {
      if (!desktop_id.empty()) {
        window_class.wm_class_name = desktop_id;
        window_class.wayland_app_id = desktop_id;
      }
    }
  }
  return window_class;
}

''' + '\n' * 70 + '''BrowserNativeWidget* BrowserNativeWidget::CreateBrowserNativeWidget(
    BrowserWidget* browser_widget,
    BrowserView* browser_view) {
  return new BrowserNativeWidgetAuraLinux(browser_widget, browser_view);
}
'''

WIDGET_HEADER_FIXTURE = '''class BrowserWidget : public views::Widget {
 public:
''' + '\n' * 60 + '''#if BUILDFLAG(IS_LINUX)
  bool tiled() const { return tiled_; }
  void set_tiled(bool tiled) { tiled_ = tiled; }
  const ui::WindowTiledEdges& tiled_edges() const { return tiled_edges_; }
  void set_tiled_edges(const ui::WindowTiledEdges& edges) {
    tiled_edges_ = edges;
  }
#endif

  // Initialize the frame (creates the underlying native window).
  void InitBrowserWidget();
};
'''


class FloatingWindowCoreTests(unittest.TestCase):
    def test_window_classes_and_the_pinned_opening(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            self.skipTest('C++ compiler is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-floating-core-') as scratch:
            root = pathlib.Path(scratch)
            (root / 'core.cc').write_text(CORE)
            binary = root / 'core'
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', str(SOURCE),
                                    str(root / 'core.cc'), str(LINUX / 'ac_linux_window_lifecycle.cc'), '-o', str(binary)],
                                   capture_output=True, text=True)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True)
            self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)


class FloatingWindowHostTests(unittest.TestCase):
    def setUp(self):
        self.host = (LINUX / 'ac_linux_host.cc').read_text()

    def section(self, start, end):
        at = self.host.index(start)
        return self.host[at:self.host.index(end, at)]

    def test_a_window_gets_its_class_while_chrome_creates_it(self):
        self.assertIn('extern const char* (*g_ardia_linux_window_class)(const BrowserWindowInterface*);', self.host)
        opening = self.section('void OpenNativeWindow(WindowOpening opening,', 'void BeginWindowOpening(')
        self.assertIn('const char* const window_class = linux_window::WindowClass(opening.kind, opening.small);', opening)
        scope = opening.index('base::AutoReset<const char*> opening_class(&OpeningWindowClass(), window_class);')
        self.assertLess(scope, opening.index('created = CreateBrowserWindow(std::move(params));'))
        self.assertIn('request.window_class = window_class;', opening)

    def test_an_open_window_keeps_its_class_when_chrome_asks_again(self):
        hook = self.section('g_ardia_linux_window_class = [](', 'g_ardia_linux_pins_window_size = [](')
        self.assertIn('if (OpeningWindowClass() || !browser) return OpeningWindowClass();', hook)
        self.assertIn('return host->second->window_class();', hook)
        self.assertIn('requested->second.browser.get() == browser ? requested->second.window_class : nullptr', hook)
        self.assertIn('window_class_ = request.window_class;', self.host)

    def test_little_ardia_settings_and_import_open_pinned_unless_restored_maximized(self):
        opening = self.section('void OpenNativeWindow(WindowOpening opening,', 'void BeginWindowOpening(')
        self.assertIn('maximized = saved && placement->FindBool("maximized").value_or(false);', opening)
        self.assertIn('const bool pinned = linux_window::OpensPinned(opening.kind, opening.small, maximized);', opening)
        self.assertLess(opening.index('request.pinned = pinned;'), opening.index('RequestedWindows()[created->GetSessionID().id()] = std::move(request);'))
        self.assertLess(opening.index('RequestedWindows()[created->GetSessionID().id()] = std::move(request);'),
                        opening.index('ShowNativeWindow(created,'))

    def test_the_pin_is_read_from_the_request_until_the_host_attaches(self):
        self.assertIn('extern bool (*g_ardia_linux_pins_window_size)(const BrowserWindowInterface*);', self.host)
        hook = self.section('g_ardia_linux_pins_window_size = [](', 'g_ardia_linux_unhandled_key = [](')
        self.assertIn('return host->second->ReadPinnedSize();', hook)
        self.assertIn('requested->second.browser.get() != browser || !requested->second.pinned) return false;', hook)
        self.assertLess(hook.index('requested->second.pin_read = true;'), hook.index('return true;'))
        self.assertIn('pinned_ = request.pinned;', self.host)
        self.assertIn('pin_read_ = request.pin_read;', self.host)
        read = self.section('bool ReadPinnedSize() {', 'bool TakeOpenedFloating()')
        self.assertIn('if (pinned_) pin_read_ = true;', read)

    def test_the_pin_lets_go_after_the_window_is_presented_or_the_limit(self):
        presented = self.section('void ShellHostView::OnDidPresentCompositorFrame(', 'void ShellHostView::OnWidgetActivationChanged(')
        self.assertIn('base::Milliseconds(linux_window::PinnedSizeReleaseDelayMs(pinned_for))', presented)
        self.assertIn('pinned_at_ = base::TimeTicks::Now();', self.section('void ShellHostView::Initialize() {', 'SeedWindowActivation();'))
        initialize = self.section('void ShellHostView::Initialize() {', 'SeedWindowActivation();')
        self.assertIn('presented_ ? base::TimeDelta() : base::Milliseconds(linux_window::kPinnedSizeLimitMs)', initialize)
        release = self.section('void ReleasePinnedSize() {', 'void set_small(bool small) {')
        self.assertLess(release.index('pinned_ = false;'), release.index('GetWidget()->OnSizeConstraintsChanged();'))

    def test_a_window_restored_to_full_screen_lets_go_of_the_pin_first(self):
        restore = self.section('void ShellHostView::RestoreFullScreenNow() {', 'FinishFullScreenRestore();')
        self.assertLess(restore.index('ReleasePinnedSize();'), restore.index('widget->SetFullscreen(true, output->first);'))
        self.assertLess(restore.index('ReleasePinnedSize();'), restore.index('fullscreen->ToggleBrowserFullscreenMode(false);'))

    def test_tiled_edges_never_release_the_pin(self):
        hook = self.section('g_ardia_linux_tiled_edges_changed = [](', 'g_ardia_linux_minimum_size = [](')
        self.assertNotIn('ReleasePinnedSize', hook)

    def test_only_the_first_shell_bootstrap_says_the_window_opened_floating_and_only_once_chromium_read_the_pin(self):
        self.assertNotIn('openedFloating', self.section('base::DictValue ShellHostView::Bootstrap() const {', 'void ShellHostView::LayoutOverlay()'))
        served = self.section('  void StartDataRequest(', 'FileRunner()->PostTaskAndReplyWithResult(')
        self.assertIn('const bool shell_bootstrap = AssetPath(url) == "host-bootstrap.js";', served)
        self.assertIn('if (shell_bootstrap && host->TakeOpenedFloating()) bootstrap.Set("openedFloating", true);', served)
        self.assertIn('bool TakeOpenedFloating() { return std::exchange(opened_floating_, false) && pin_read_; }', self.host)
        self.assertIn('opened_floating_ = request.pinned;', self.host)


class FloatingWindowPackagingTests(unittest.TestCase):
    def test_the_packaged_window_classes_are_the_engine_s(self):
        header = (LINUX / 'ac_linux_window_lifecycle.h').read_text()
        engine = set(re.findall(r'k(?:Little|Settings|Import)WindowClass\[\] = "([^"]+)"', header))
        self.assertEqual(len(engine), 3)
        spec = importlib.util.spec_from_file_location('linux_formats', REPO / 'scripts/linux/linux_formats.py')
        formats = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(formats)
        self.assertEqual(set(formats.WINDOW_CLASSES), engine)
        smoke = (REPO / 'scripts/linux/smoke.mjs').read_text()
        listed = re.search(r'const WINDOW_DESKTOP_ENTRIES = \[([^\]]*)\]', smoke).group(1)
        self.assertEqual(set(re.findall(r'"([^"]+)\.desktop"', listed)), engine)


class FloatingWindowPatchTests(unittest.TestCase):
    def test_the_patch_is_linux_only_and_after_the_frameless_windows(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        at = names.index(PATCH.name)
        self.assertEqual(steps[at], ['chromium', PATCH.name, 'linux'])
        self.assertGreater(at, names.index('chromium-linux-frameless-utility-windows.patch'))
        self.assertGreater(at, names.index('chromium-linux-window-minimum-size.patch'))
        self.assertEqual(names.count(PATCH.name), 1)

    def test_the_patch_names_the_class_and_pins_the_widget(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-floating-patch-') as directory:
            for path, text in ((WIDGET, WIDGET_FIXTURE), (WIDGET_HEADER, WIDGET_HEADER_FIXTURE)):
                target = pathlib.Path(directory) / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            result = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(PATCH)], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            widget = (pathlib.Path(directory) / WIDGET).read_text()
            header = (pathlib.Path(directory) / WIDGET_HEADER).read_text()
        self.assertIn('const char* (*g_ardia_linux_window_class)(const BrowserWindowInterface*) =\n    nullptr;', widget)
        self.assertIn('bool (*g_ardia_linux_pins_window_size)(const BrowserWindowInterface*) =\n    nullptr;', widget)
        window_class = widget[widget.index('BrowserNativeWidgetAuraLinux::GetWindowClass() const {'):]
        self.assertLess(window_class.index('window_class.wayland_app_id = desktop_id;'),
                        window_class.index('    window_class.wm_class_name = ardia_class;\n    window_class.wayland_app_id = ardia_class;'))
        self.assertLess(window_class.index('window_class.wayland_app_id = ardia_class;'), window_class.index('  return window_class;'))
        for bound in ('Minimum', 'Maximum'):
            body = widget[widget.index(f'gfx::Size BrowserWidget::Get{bound}Size() const {{'):]
            self.assertLess(body.index('ArdiaLinuxPinsWindowSize(browser_view_.get())'), body.index('GetWindowBoundsInScreen().size()'))
            self.assertLess(body.index('GetWindowBoundsInScreen().size()'), body.index(f'views::Widget::Get{bound}Size();'))
        linux_block = header[header.index('#if BUILDFLAG(IS_LINUX)'):header.index('#endif')]
        self.assertIn('  gfx::Size GetMinimumSize() const override;\n  gfx::Size GetMaximumSize() const override;\n', linux_block)


if __name__ == '__main__':
    unittest.main()
