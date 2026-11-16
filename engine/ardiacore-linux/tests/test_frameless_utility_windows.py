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

GLOBALS_157 = '''int (*g_ardia_linux_window_tab_count)(const BrowserWindowInterface*) = nullptr;
bool (*g_ardia_linux_shell_passes_point)(gfx::NativeView child,
                                         const gfx::Point& location) = nullptr;
void (*g_ardia_linux_minimum_size)(const BrowserWindowInterface*,
                                   gfx::Size* minimum) = nullptr;

namespace {

bool ArdiaLinuxBackgroundInstance() {
'''
TITLE_157 = '''  return nullptr;
}

bool BrowserView::ShouldShowWindowTitle() const {
  return WindowFeatureController::From(browser_)->SupportsWindowFeature(
      WindowFeatureController::WindowFeature::kFeatureTitleBar);
}

bool BrowserView::ShouldShowWindowIcon() const {
'''
INCLUDES_157 = '''#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/browser_widget.h"
#include "chrome/common/pref_names.h"
#include "ui/ozone/public/ozone_platform.h"
#include "ui/views/widget/widget.h"

BrowserNativeWidgetAuraLinux::BrowserNativeWidgetAuraLinux(
    BrowserWidget* browser_widget,
    BrowserView* browser_view)
'''
CUSTOM_FRAME_157 = '''}

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

    def test_the_patch_applies_to_the_chromium_157_frame_files(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-frameless-') as directory:
            view = Path(directory) / BROWSER_VIEW
            widget = Path(directory) / NATIVE_WIDGET
            view.parent.mkdir(parents=True)
            view.write_text('\n' * 431 + GLOBALS_157 + '\n' * 3580 + TITLE_157)
            widget.write_text('\n' * 13 + INCLUDES_157 + '\n' * 57 + CUSTOM_FRAME_157)
            result = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(PATCH)], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            patched_view = view.read_text()
            patched_widget = widget.read_text()
        self.assertIn('bool (*g_ardia_linux_frameless_app)(const std::string& app_name) = nullptr;\n', patched_view)
        self.assertIn('  const BrowserInitState* init = BrowserInitState::From(browser);\n'
                      '  return init && g_ardia_linux_frameless_app(init->create_params().app_name);\n', patched_view)
        self.assertIn('bool BrowserView::ShouldShowWindowTitle() const {\n'
                      '  if (ArdiaLinuxFramelessApp(browser_.get())) {\n    return false;\n  }\n', patched_view)
        self.assertIn('bool ArdiaLinuxFramelessApp(const BrowserWindowInterface* browser);\n', patched_widget)
        self.assertIn('  if (!browser_view()) {\n    return false;\n  }\n\n'
                      '  if (ArdiaLinuxFramelessApp(browser_view()->browser())) {\n    return true;\n  }\n', patched_widget)

    def test_the_host_names_its_settings_and_import_windows(self):
        self.assertIn('extern bool (*g_ardia_linux_frameless_app)(const std::string& app_name);', self.host)
        self.assertIn('g_ardia_linux_frameless_app = &IsUtilityAppName;', self.host)
        self.assertIn('return app_name == "ArdiaSettings" || app_name == "ArdiaImport";', self.host)
        self.assertIn('params.app_name = opening.kind == "settings" ? "ArdiaSettings" : "ArdiaImport";', self.host)

    def test_a_utility_window_opens_over_its_opener(self):
        opening = self.host[self.host.index('if (method == "ArdiaShell.openWindow") {'):self.host.index('if (method == "ArdiaShell.isDarkAppearance") {')]
        self.assertIn('requested = linux_window::RequestedUtilityFrame(', opening)
        self.assertIn('LifecycleRect(GetWidget()->GetWindowBoundsInScreen())', opening)
        native = self.host[self.host.index('void OpenNativeWindow('):self.host.index('void BeginWindowOpening(')]
        self.assertIn('if (opening.requested && opening.requested->positioned) {', native)
        self.assertIn('params.initial_bounds = gfx::Rect();', native)


if __name__ == '__main__':
    unittest.main()
