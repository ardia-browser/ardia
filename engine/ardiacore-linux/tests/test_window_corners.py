import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
LINUX = SOURCE / 'ardia/linux'
REPO = ROOT.parents[1]
HOST = (LINUX / 'ac_linux_host.cc').read_text()
CORE = (LINUX / 'ac_linux_window_corners.h').read_text()


def between(text, start, end):
    body = text[text.index(start):]
    return body[:body.index(end)]


class WindowCornersTests(unittest.TestCase):
    def test_the_decision_and_the_clip_rule(self):
        with tempfile.TemporaryDirectory(prefix='ardia-window-corners-') as directory:
            binary = Path(directory) / 'window-corners'
            subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(SOURCE),
                            str(ROOT / 'tests/window_corners_test.cc'), '-o', str(binary)],
                           check=True, text=True, timeout=180)
            result = subprocess.run([str(binary)], text=True, timeout=60, capture_output=True,
                                    env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, 'ok\n')

    def test_the_engine_and_the_shell_name_the_same_tiling_desktops(self):
        engine = re.findall(r'"([a-z0-9]+)"', CORE[CORE.index('kTilingDesktops[] = {'):CORE.index('};', CORE.index('kTilingDesktops[] = {'))])
        shell = REPO / 'apps/linux/src/tilingDesktop.ts'
        if not shell.exists():
            self.skipTest('the shell has no tiling desktop list on this branch yet')
        text = shell.read_text()
        listed = text[text.index('TILING_DESKTOPS'):]
        self.assertEqual(engine, re.findall(r'"([a-z0-9]+)"', listed[:listed.index(']')]))

    def test_every_window_clips_its_native_views_to_the_frames_corners(self):
        round_corners = between(HOST, 'void ShellHostView::RoundWindowCorners() {', '\n}\n')
        self.assertIn('frame ? frame->GetWindowRoundedCorners() : gfx::RoundedCornersF();', round_corners)
        self.assertNotIn('is_utility()) return', round_corners)
        self.assertLess(round_corners.index('if (window_corners_ == corners) return;'),
                        round_corners.index('shell_->holder()->SetNativeViewCornerRadii(rounded);'))
        self.assertIn('if (is_utility()) SetBackground(views::CreateRoundedRectBackground(kColorWebContentsBackground, rounded));', round_corners)
        self.assertIn('if (curtain_) curtain_->layer()->SetRoundedCornerRadius(rounded);', round_corners)
        self.assertIn('if (!browser_view_->layer() && !rounded.IsEmpty()) {\n    browser_view_->SetPaintToLayer();\n'
                      '    browser_view_->layer()->SetFillsBoundsOpaquely(false);\n  }\n'
                      '  if (browser_view_->layer()) browser_view_->layer()->SetRoundedCornerRadius(rounded);', round_corners)
        self.assertIn('ClipViewport(binding->viewport());\n    ClipViewport(binding->devtools_viewport());', round_corners)
        clip = between(HOST, 'void ShellHostView::ClipViewport(views::WebView* view) {', '\n}\n')
        self.assertIn('linux_window_corners::ClipToWindow(', clip)
        self.assertIn('width(), height(),', clip)
        self.assertIn('linux_window_corners::kPageCardRadius', clip)
        pane = between(HOST, 'void ShellHostView::LayoutPane(TabBinding* binding) {', '\nvoid ShellHostView::KeepPaneFocus(')
        self.assertNotIn('RoundedCornersF(12.0f)', pane)
        self.assertIn('    ClipViewport(page);\n', pane)
        self.assertIn('  ClipViewport(tools);\n', pane)

    def test_the_corners_follow_every_change_of_frame_or_window_state(self):
        self.assertIn('  RoundWindowCorners();\n  browser_view_->GetActiveContentsWebView()->SetVisible(false);',
                      between(HOST, 'void ShellHostView::LayoutOverlay() {', '\n}\n'))
        self.assertIn('  if (browser_view_) RoundWindowCorners();', between(HOST, 'void ShellHostView::OnWidgetThemeChanged(', '\n}\n'))
        self.assertTrue(between(HOST, 'void ShellHostView::RefreshEngineFrame() {', '\n}\n').rstrip().endswith('RoundWindowCorners();'))
        report = between(HOST, 'void ShellHostView::ReportWindowState() {', '\n}\n')
        self.assertLess(report.index('if (!GetWidget()) return;'), report.index('RoundWindowCorners();'))
        self.assertLess(report.index('RoundWindowCorners();'), report.index('if (window_id_.empty() ||'))

    def test_the_docs_give_the_rule(self):
        docs = (REPO / 'docs/linux-port.md').read_text()
        outer = docs[docs.index('- **Outer frame.**'):]
        outer = outer[:outer.index('- **Menu button.**')]
        for phrase in ('GetWindowRoundedCorners', 'server-side', 'ac_linux_window_corners.h', 'overflow'):
            self.assertIn(phrase, outer)


if __name__ == '__main__':
    unittest.main()
