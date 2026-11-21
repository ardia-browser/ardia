import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINUX = ROOT / 'src/ardia/linux'
PATCHES = ROOT.parent / 'patches'
PATCH = PATCHES / 'chromium-linux-frameless-utility-windows.patch'
BROWSER_VIEW = 'chrome/browser/ui/views/frame/browser_view.cc'
NATIVE_WIDGET = 'chrome/browser/ui/views/frame/browser_native_widget_aura_linux.cc'
FRAME_LAYOUT = 'chrome/browser/ui/views/frame/browser_frame_view_layout_linux.cc'

GLOBALS_158 = '''int (*g_ardia_linux_window_tab_count)(const BrowserWindowInterface*) = nullptr;
bool (*g_ardia_linux_shell_passes_point)(gfx::NativeView child,
                                         const gfx::Point& location) = nullptr;
void (*g_ardia_linux_minimum_size)(const BrowserWindowInterface*,
                                   gfx::Size* minimum) = nullptr;

namespace {

bool ArdiaLinuxBackgroundInstance() {
'''
TITLE_158 = '''  return nullptr;
}

bool BrowserView::ShouldShowWindowTitle() const {
  return WindowFeatureController::From(browser_)->SupportsWindowFeature(
      WindowFeatureController::WindowFeature::kFeatureTitleBar);
}

bool BrowserView::ShouldShowWindowIcon() const {
#if !BUILDFLAG(IS_CHROMEOS)
  if (GetIsWebAppType() && !GetSupportsTabStrip()) {
    return true;
'''
INCLUDES_158 = '''#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/browser_widget.h"
#include "chrome/common/pref_names.h"
#include "ui/ozone/public/ozone_platform.h"
#include "ui/platform_window/platform_window.h"
#include "ui/views/widget/widget.h"

BrowserNativeWidgetAuraLinux::BrowserNativeWidgetAuraLinux(
    BrowserWidget* browser_widget,
    BrowserView* browser_view)
'''
CUSTOM_FRAME_158 = '''}

bool BrowserNativeWidgetAuraLinux::UseCustomFrame() const {
  if (!browser_view()) {
    return false;
  }

  // If the platform does not support server side decorations, ignore the user
  // preference and return true.
  if (!ui::OzonePlatform::GetInstance()
           ->GetPlatformRuntimeProperties()
           .supports_server_side_window_decorations) {
    return true;
'''
LAYOUT_INCLUDES_158 = '''#include "chrome/browser/ui/views/frame/browser_frame_view_layout_linux.h"

#include "base/i18n/rtl.h"
#include "chrome/browser/ui/views/frame/browser_frame_view_linux.h"
#include "chrome/browser/ui/views/frame/opaque_browser_frame_view_layout.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/views/window/frame_view_utils_linux.h"
'''
LAYOUT_CONSTRUCTORS_158 = '''
}  // namespace

BrowserFrameViewLayoutLinux::BrowserFrameViewLayoutLinux() = default;
BrowserFrameViewLayoutLinux::~BrowserFrameViewLayoutLinux() = default;

'''
LAYOUT_TOP_158 = '''}

int BrowserFrameViewLayoutLinux::NonClientExtraTopThickness() const {
  return delegate_->IsTabStripVisible() ? 0 : kExtraTopBorder;
}
'''


class FramelessUtilityWindowTests(unittest.TestCase):
    def setUp(self):
        self.host = (LINUX / 'ac_linux_host.cc').read_text()

    def test_the_patch_is_linux_only_and_after_the_minimum_size_patch(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        at = names.index(PATCH.name)
        self.assertEqual(steps[at], ['chromium', PATCH.name, 'linux'])
        self.assertGreater(at, names.index('chromium-linux-window-minimum-size.patch'))
        self.assertEqual(names.count(PATCH.name), 1)

    def test_the_patch_applies_to_the_chromium_158_frame_files(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-frameless-') as directory:
            view = Path(directory) / BROWSER_VIEW
            widget = Path(directory) / NATIVE_WIDGET
            layout = Path(directory) / FRAME_LAYOUT
            view.parent.mkdir(parents=True)
            view.write_text('\n' * 431 + GLOBALS_158 + '\n' * 3580 + TITLE_158)
            widget.write_text('\n' * 15 + INCLUDES_158 + '\n' * 99 + CUSTOM_FRAME_158)
            layout.write_text('\n' * 4 + LAYOUT_INCLUDES_158 + '\n' * 11 + LAYOUT_CONSTRUCTORS_158 + '\n' * 43 + LAYOUT_TOP_158)
            result = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(PATCH)], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            patched_view = view.read_text()
            patched_widget = widget.read_text()
            patched_layout = layout.read_text()
        self.assertIn('bool (*g_ardia_linux_frameless_app)(const std::string& app_name) = nullptr;\n', patched_view)
        self.assertIn('  const BrowserInitState* init = BrowserInitState::From(browser);\n'
                      '  return init && g_ardia_linux_frameless_app(init->create_params().app_name);\n', patched_view)
        self.assertIn('bool BrowserView::ShouldShowWindowTitle() const {\n'
                      '  if (ArdiaLinuxFramelessApp(browser_.get())) {\n    return false;\n  }\n', patched_view)
        self.assertIn('bool BrowserView::ShouldShowWindowIcon() const {\n'
                      '  if (ArdiaLinuxFramelessApp(browser_.get())) {\n    return false;\n  }\n', patched_view)
        self.assertIn('bool ArdiaLinuxFramelessApp(const BrowserWindowInterface* browser);\n', patched_layout)
        self.assertIn('int BrowserFrameViewLayoutLinux::NonClientExtraTopThickness() const {\n'
                      '  if (view_ && ArdiaLinuxFramelessApp(view_->GetBrowserView()->browser())) {\n    return 0;\n  }\n'
                      '  return delegate_->IsTabStripVisible() ? 0 : kExtraTopBorder;\n', patched_layout)
        self.assertIn('bool ArdiaLinuxFramelessApp(const BrowserWindowInterface* browser);\n', patched_widget)
        self.assertIn('  if (!browser_view()) {\n    return false;\n  }\n\n'
                      '  if (ArdiaLinuxFramelessApp(browser_view()->browser())) {\n    return true;\n  }\n', patched_widget)

    def test_the_host_names_its_settings_and_import_windows(self):
        self.assertIn('extern bool (*g_ardia_linux_frameless_app)(const std::string& app_name);', self.host)
        self.assertIn('g_ardia_linux_frameless_app = &IsUtilityAppName;', self.host)
        self.assertIn('return app_name == "ArdiaSettings" || app_name == "ArdiaImport";', self.host)
        self.assertIn('params.app_name = opening.kind == "settings" ? "ArdiaSettings" : "ArdiaImport";', self.host)

    def test_a_utility_window_rounds_its_page_with_the_frame(self):
        overlay = self.host[self.host.index('void ShellHostView::LayoutOverlay() {'):self.host.index('void ShellHostView::ShellPainted() {')]
        self.assertIn('  RoundWindowCorners();\n', overlay)
        self.assertIn('frame ? frame->GetWindowRoundedCorners() : gfx::RoundedCornersF();', overlay)
        self.assertIn('if (is_utility()) SetBackground(views::CreateRoundedRectBackground(kColorWebContentsBackground, rounded));', overlay)
        self.assertIn('shell_->holder()->SetNativeViewCornerRadii(rounded);', overlay)
        self.assertIn('if (curtain_) curtain_->layer()->SetRoundedCornerRadius(rounded);', overlay)
        theme = self.host[self.host.index('void ShellHostView::OnWidgetThemeChanged(views::Widget*) {'):]
        self.assertIn('  if (browser_view_) RoundWindowCorners();\n}', theme[:theme.index('\n}\n') + 3])

    def test_a_utility_window_opens_over_its_opener(self):
        opening = self.host[self.host.index('if (method == "ArdiaShell.openWindow") {'):self.host.index('if (method == "ArdiaShell.isDarkAppearance") {')]
        self.assertIn('requested = linux_window::RequestedUtilityFrame(', opening)
        self.assertIn('LifecycleRect(GetWidget()->GetWindowBoundsInScreen())', opening)
        native = self.host[self.host.index('void OpenNativeWindow('):self.host.index('void BeginWindowOpening(')]
        self.assertIn('if (opening.requested && opening.requested->positioned) {', native)
        self.assertIn('params.initial_bounds = gfx::Rect();', native)


if __name__ == '__main__':
    unittest.main()
