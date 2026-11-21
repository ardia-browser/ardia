import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
LINUX = SOURCE / 'ardia' / 'linux'
PATCHES = ROOT.parent / 'patches'
PATCH = PATCHES / 'chromium-linux-floating-windows.patch'
WIDGET = 'chrome/browser/ui/views/frame/browser_native_widget_aura_linux.cc'
FRAME = 'chrome/browser/ui/views/frame/opaque_browser_frame_view.cc'
FRAME_HEADER = 'chrome/browser/ui/views/frame/opaque_browser_frame_view.h'

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

#include "base/functional/bind.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/shell_integration_linux.h"
#include "chrome/browser/ui/browser_init_state.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/views/frame/browser_desktop_window_tree_host_linux.h"
#include "chrome/browser/ui/views/frame/browser_native_widget_factory.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/browser_widget.h"
#include "chrome/common/pref_names.h"
#include "ui/ozone/public/ozone_platform.h"
#include "ui/platform_window/platform_window.h"
#include "ui/views/widget/widget.h"

bool ArdiaLinuxFramelessApp(const BrowserWindowInterface* browser);

BrowserNativeWidgetAuraLinux::BrowserNativeWidgetAuraLinux(
    BrowserWidget* browser_widget,
    BrowserView* browser_view)
    : BrowserNativeWidgetAura(browser_widget, browser_view) {
}

views::Widget::InitParams BrowserNativeWidgetAuraLinux::GetWidgetParams(
    views::Widget::InitParams::Ownership ownership) {
  views::Widget::InitParams params(ownership);
  if (app) {
    params.wayland_app_id = shell_integration_linux::GetXdgAppIdForWebApp(
        BrowserInitState::From(&browser)->create_params().app_name,
        browser.GetProfile()->GetPath());
  } else {
    params.wayland_app_id = params.wm_class_class;
  }

  return params;
}

bool BrowserNativeWidgetAuraLinux::UseCustomFrame() const {
  return true;
}
'''

FRAME_FIXTURE = '''// Copyright 2012 The Chromium Authors

#include "chrome/browser/ui/views/frame/opaque_browser_frame_view.h"

#include <algorithm>
#include <utility>

#include "base/trace_event/trace_event.h"
''' + '\n' * 50 + '''using content::WebContents;

namespace {

constexpr int kRoundedCaptionButtonSize = 16;
''' + '\n' * 50 + '''  return button && button->GetVisible() &&
         button->GetMirroredBounds().Contains(point);
}

}  // namespace

///////////////////////////////////////////////////////////////////////////////
''' + '\n' * 190 + '''}

gfx::Size OpaqueBrowserFrameView::GetMinimumSize() const {
  return layout_->GetMinimumSize(this);
}

void OpaqueBrowserFrameView::PaintAsActiveChanged() {
  UpdateCaptionButtonPlaceholderContainerBackground();
  BrowserFrameView::PaintAsActiveChanged();
}
'''

FRAME_HEADER_FIXTURE = '''class OpaqueBrowserFrameView {
''' + '\n' * 60 + '''  void WindowControlsOverlayEnabledChanged() override;
  void SetCaptionButtonsOpacity(float opacity) override;
  gfx::Size GetMinimumSize() const override;
  void PaintAsActiveChanged() override;
  void OnThemeChanged() override;

  gfx::Rect GetBoundsForClientView() const override;
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
        scope = opening.index('base::AutoReset<const char*> window_class(&OpeningWindowClass(), '
                              'linux_window::WindowClass(opening.kind, opening.small));')
        self.assertLess(scope, opening.index('created = CreateBrowserWindow(std::move(params));'))
        self.assertIn('g_ardia_linux_window_class = [](const BrowserWindowInterface*) { return OpeningWindowClass(); };', self.host)

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
        self.assertIn('return host->second->pins_size();', hook)
        self.assertIn('requested->second.browser.get() == browser && requested->second.pinned', hook)
        self.assertIn('pinned_ = request.pinned;', self.host)

    def test_the_pin_lets_go_after_the_window_is_presented_or_the_limit(self):
        presented = self.section('void ShellHostView::OnDidPresentCompositorFrame(', 'void ShellHostView::OnWidgetActivationChanged(')
        self.assertIn('base::Milliseconds(linux_window::PinnedSizeReleaseDelayMs(pinned_for))', presented)
        self.assertIn('pinned_at_ = base::TimeTicks::Now();', self.section('void ShellHostView::Initialize() {', 'SeedWindowActivation();'))
        initialize = self.section('void ShellHostView::Initialize() {', 'SeedWindowActivation();')
        self.assertIn('presented_ ? base::TimeDelta() : base::Milliseconds(linux_window::kPinnedSizeLimitMs)', initialize)
        release = self.section('void ReleasePinnedSize() {', 'void set_small(bool small) {')
        self.assertLess(release.index('pinned_ = false;'), release.index('GetWidget()->OnSizeConstraintsChanged();'))

    def test_the_bootstrap_says_the_window_opened_floating(self):
        bootstrap = self.section('base::DictValue ShellHostView::Bootstrap() const {', 'void ShellHostView::LayoutOverlay()')
        self.assertIn('if (opened_pinned_) bootstrap.Set("openedFloating", true);', bootstrap)


class FloatingWindowPatchTests(unittest.TestCase):
    def test_the_patch_is_linux_only_and_after_the_frameless_windows(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        at = names.index(PATCH.name)
        self.assertEqual(steps[at], ['chromium', PATCH.name, 'linux'])
        self.assertGreater(at, names.index('chromium-linux-frameless-utility-windows.patch'))
        self.assertGreater(at, names.index('chromium-linux-window-minimum-size.patch'))
        self.assertEqual(names.count(PATCH.name), 1)

    def test_the_patch_names_the_class_and_pins_the_frame(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-floating-patch-') as directory:
            for path, text in ((WIDGET, WIDGET_FIXTURE), (FRAME, FRAME_FIXTURE), (FRAME_HEADER, FRAME_HEADER_FIXTURE)):
                target = pathlib.Path(directory) / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            result = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(PATCH)], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            widget = (pathlib.Path(directory) / WIDGET).read_text()
            frame = (pathlib.Path(directory) / FRAME).read_text()
            header = (pathlib.Path(directory) / FRAME_HEADER).read_text()
        self.assertIn('const char* (*g_ardia_linux_window_class)(const BrowserWindowInterface*) =\n    nullptr;', widget)
        self.assertLess(widget.index('params.wayland_app_id = params.wm_class_class;'),
                        widget.index('    params.wm_class_name = ardia_class;\n    params.wayland_app_id = ardia_class;'))
        self.assertLess(widget.index('params.wayland_app_id = ardia_class;'), widget.index('  return params;'))
        self.assertIn('bool (*g_ardia_linux_pins_window_size)(const BrowserWindowInterface*) =\n    nullptr;', frame)
        self.assertIn('return frame->GetWidget()->GetWindowBoundsInScreen().size();', frame)
        minimum = frame[frame.index('gfx::Size OpaqueBrowserFrameView::GetMinimumSize() const {'):]
        self.assertLess(minimum.index('ArdiaLinuxPinnedWindowSize(this)'), minimum.index('return layout_->GetMinimumSize(this);'))
        maximum = frame[frame.index('gfx::Size OpaqueBrowserFrameView::GetMaximumSize() const {'):]
        self.assertLess(maximum.index('ArdiaLinuxPinnedWindowSize(this)'), maximum.index('return BrowserFrameView::GetMaximumSize();'))
        self.assertIn('  gfx::Size GetMaximumSize() const override;\n', header)


if __name__ == '__main__':
    unittest.main()
