import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
DESKTOP_SOURCE = SOURCE.parents[1] / 'ardiacore-desktop' / 'src'
LINUX = SOURCE / 'ardia/linux'
REPO = ROOT.parents[1]


def body(source, start, end):
    text = source[source.index(start):]
    return text[:text.index(end)]


class AutomationWindowTests(unittest.TestCase):
    def test_refusals_and_devtools_target_generations(self):
        with tempfile.TemporaryDirectory(prefix='ardia-automation-window-') as directory:
            binary = Path(directory) / 'automation-window'
            subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(SOURCE), '-I', str(DESKTOP_SOURCE),
                            str(ROOT / 'tests/automation_window_test.cc'), '-o', str(binary)],
                           check=True, text=True, timeout=180)
            result = subprocess.run([str(binary)], text=True, timeout=60, capture_output=True,
                                    env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, 'ok\n')

    def test_the_automation_window_is_a_hidden_browser_that_chromium_and_the_cli_policy_see_as_one(self):
        window = (LINUX / 'ac_linux_automation_window.cc').read_text()
        create = body(window, 'BrowserWindowInterface* LinuxAutomationWindowFor(Profile* profile) {', '\n}\n')
        self.assertIn('profile->IsOffTheRecord()', create)
        self.assertIn('params.omit_from_session_restore = true;', create)
        self.assertNotIn('Show', create)
        host = (LINUX / 'ac_linux_host.cc').read_text()
        self.assertIn('return browser && (CompanionOwners().contains(browser->GetSessionID().id()) ||\n'
                      '                     ardiacore::IsLinuxAutomationWindow(browser));', host)
        self.assertIn('g_ardia_linux_automation_window = &ardiacore::IsLinuxAutomationWindow;', host)
        visibility = (REPO / 'engine/chromium/src/chrome/browser/ardia/ac_host_visibility_linux.cc').read_text()
        self.assertIn('return g_ardia_linux_automation_window && g_ardia_linux_automation_window(browser);', visibility)
        self.assertIn('FindBrowserWithTab(contents)', visibility)

    def test_moving_a_tab_off_screen_drops_its_binding_before_the_strip_change_and_release_then_succeeds(self):
        host = (LINUX / 'ac_linux_host.cc').read_text()
        move = body(host, 'std::optional<std::string> ShellHostView::MoveTabOffscreen(', 'void ShellHostView::FocusShell() {')
        self.assertLess(move.index('linux_automation_window::OffscreenRefusal('), move.index('bindings_.erase(id);'))
        self.assertLess(move.index('bindings_.erase(id);'), move.index('DetachWebContentsAtForInsertion(index)'))
        self.assertIn('offscreen_released_.insert(id);', move)
        release = body(host, 'if (method == "tab.release") {', 'if (method == "session.read") {')
        self.assertLess(release.index('offscreen_released_.erase('), release.index('return std::move(done).Run(false, base::Value("No owned live tab"));'))

    def test_releasing_a_tab_the_host_already_closed_succeeds_before_the_no_owned_live_tab_refusal(self):
        host = (LINUX / 'ac_linux_host.cc').read_text()
        release = body(host, 'if (method == "tab.release") {', 'if (method == "session.read") {')
        gone = 'if (!binding && TabIsGone(args.FindInt("id").value_or(0))) return std::move(done).Run(true, base::Value());'
        self.assertIn(gone, release)
        self.assertLess(release.index('offscreen_released_.erase('), release.index(gone))
        self.assertLess(release.index(gone), release.index('return std::move(done).Run(false, base::Value("No owned live tab"));'))

    def test_off_screen_tabs_close_with_the_last_browser_window_so_they_never_keep_ardia_running(self):
        host = (LINUX / 'ac_linux_host.cc').read_text()
        close = body(host, 'void CloseUtilitiesWithoutBrowserWindows() {', '\n}\n')
        self.assertLess(close.index('if (!host->is_utility()) return;'), close.index('ardiacore::CloseLinuxOffscreenTabs();'))

    def test_the_four_calls_are_routed_and_advertised(self):
        host = (LINUX / 'ac_linux_host.cc').read_text()
        for call in ('kOwnsTabCall', 'kMoveOffscreenCall', 'kCloseOffscreenTabsCall', 'kTabTargetsCall'):
            self.assertIn(f'name == ardiacore::linux_automation_window::{call}', host)
        self.assertIn('ardia::IsCliOwnedTab(', host)
        self.assertIn('ardiacore::TabWasInShownSlot(', host)
        self.assertIn('for (const char* capability : ardiacore::linux_automation_window::kCapabilities) capabilities.Append(capability);', host)
        header = (LINUX / 'ac_linux_automation_window.h').read_text()
        self.assertIn('kCapabilities[] = {"engine.cliOwnsTab", "engine.cliMoveOffscreen",', header)
        self.assertIn('"ac_linux_automation_window.cc"', (LINUX / 'BUILD.gn').read_text())


if __name__ == '__main__':
    unittest.main()
