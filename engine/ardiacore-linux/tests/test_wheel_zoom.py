from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LINUX = ROOT / 'src/ardia/linux'
PATCHES = ROOT.parent / 'patches'
PATCH = PATCHES / 'chromium-linux-wheel-zoom.patch'
DELEGATE = 'chrome/browser/ui/browser_web_contents_delegate/browser_web_contents_delegate.cc'
CHROMIUM_157 = '''  }
}

void BrowserWebContentsDelegate::ContentsZoomChange(bool zoom_in) {
  chrome::ExecuteCommand(&*browser_, zoom_in ? IDC_ZOOM_PLUS : IDC_ZOOM_MINUS);
}

bool BrowserWebContentsDelegate::TakeFocus(content::WebContents* source,
                                           bool reverse) {
  return false;
}
'''


class WheelZoomTests(unittest.TestCase):
    def test_the_gate_patch_is_linux_only_and_follows_the_page_status_patch(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        at = names.index('chromium-linux-wheel-zoom.patch')
        self.assertEqual(steps[at], ['chromium', 'chromium-linux-wheel-zoom.patch', 'linux'])
        self.assertEqual(names[at - 1], 'chromium-linux-page-status.patch')
        self.assertEqual(names.count('chromium-linux-wheel-zoom.patch'), 1)

    def test_the_gate_patch_applies_to_the_chromium_157_zoom_handler(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-wheel-zoom-') as directory:
            target = Path(directory) / DELEGATE
            target.parent.mkdir(parents=True)
            target.write_text('\n' * 900 + CHROMIUM_157)
            result = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(PATCH)], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            patched = target.read_text()
        self.assertIn('bool g_ardia_linux_wheel_zoom_off = false;\n\nvoid BrowserWebContentsDelegate::ContentsZoomChange(bool zoom_in) {\n'
                      '  if (g_ardia_linux_wheel_zoom_off) {\n    return;\n  }\n  chrome::ExecuteCommand(', patched)

    def test_the_setting_is_a_routed_capability_that_only_flips_the_gate(self):
        routes = (LINUX / 'ac_linux_page_messages.h').read_text()
        listed = routes[routes.index('kLinuxPageMessageRoutes[] = {'):]
        self.assertIn('"webView.setCommandScrollZoom"', listed[:listed.index('};')])
        channel = (LINUX / 'ac_linux_page_channel.cc').read_text()
        self.assertIn('\nextern bool g_ardia_linux_wheel_zoom_off;\n\nnamespace ardiacore {', channel)
        option = channel[channel.index('bool SetLinuxPageOption('):]
        gate = option[option.index('if (route == "webView.setCommandScrollZoom") {'):option.index('if (route == "webView.setSelectionPopover") {')]
        self.assertIn('input.FindBool("enabled")', gate)
        self.assertIn('g_ardia_linux_wheel_zoom_off = !*enabled;', gate)
        self.assertNotIn('PushOptions', gate)
        host = (LINUX / 'ac_linux_host.cc').read_text()
        self.assertIn('for (const char* route : ardiacore::kLinuxPageMessageRoutes)\n    capabilities.Append(route);', host)
        for elsewhere in ('webView.setPeekOtherSiteTabs', 'webView.setLittleArdiaOpensNewTabLinks'):
            self.assertNotIn(elsewhere, routes)


if __name__ == '__main__':
    unittest.main()
