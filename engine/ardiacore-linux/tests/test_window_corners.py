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
        self.assertIn('frame && views::Widget::IsWindowCompositingSupported()', round_corners)
        self.assertIn('? frame->GetWindowRoundedCorners()', round_corners)
        self.assertNotIn('is_utility()) return', round_corners)
        self.assertNotIn('return;', round_corners[round_corners.index('const linux_window_corners::Corners corners{'):])
        self.assertIn('  if (window_corners_ != corners) ApplyWindowCorners(corners);\n'
                      '  for (const auto& [id, binding] : bindings_) {\n    ClipViewport(binding->viewport());\n'
                      '    ClipViewport(binding->devtools_viewport());\n  }', round_corners)
        apply = between(HOST, 'void ShellHostView::ApplyWindowCorners(const linux_window_corners::Corners& corners) {', '\n}\n')
        self.assertLess(apply.index('window_corners_ = corners;'), apply.index('shell_->holder()->SetNativeViewCornerRadii(rounded);'))
        self.assertNotIn('ClipViewport', apply)
        round_corners = apply
        self.assertIn('if (is_utility()) SetBackground(views::CreateRoundedRectBackground(kColorWebContentsBackground, rounded));', round_corners)
        self.assertIn('if (curtain_) {\n    curtain_->layer()->SetRoundedCornerRadius(rounded);\n'
                      '    curtain_->layer()->SetIsFastRoundedCorner(true);\n  }', round_corners)
        self.assertIn('if (!browser_view_->layer() && !rounded.IsEmpty()) {\n    browser_view_->SetPaintToLayer();\n'
                      '    browser_view_->layer()->SetFillsBoundsOpaquely(false);\n  }\n'
                      '  if (browser_view_->layer()) {\n    browser_view_->layer()->SetRoundedCornerRadius(rounded);\n'
                      '    browser_view_->layer()->SetIsFastRoundedCorner(true);\n  }', round_corners)
        clip = between(HOST, 'void ShellHostView::ClipViewport(views::WebView* view) {', '\n}\n')
        self.assertIn('linux_window_corners::ClipToWindow(', clip)
        self.assertIn('width(), height(),', clip)
        self.assertIn('linux_window_corners::kPageCardRadius', clip)
        pane = between(HOST, 'void ShellHostView::LayoutPane(TabBinding* binding) {', '\nvoid ShellHostView::KeepPaneFocus(')
        self.assertNotIn('RoundedCornersF(12.0f)', pane)
        self.assertIn('    ClipViewport(page);\n', pane)
        self.assertIn('  ClipViewport(tools);\n', pane)

    def test_each_window_reads_its_own_compositors_answer_and_only_that_window_follows_a_change(self):
        self.assertNotIn('g_ardia_linux_compositor_decoration_mode', HOST)
        self.assertIn('extern void (*g_ardia_linux_compositor_decoration_changed)(gfx::AcceleratedWidget widget);', HOST)
        answer = between(HOST, 'linux_window_corners::DecorationAnswer ShellHostView::DecorationAnswer() const {', '\n}\n')
        self.assertIn('WaylandToplevelOf(GetWidget())', answer)
        self.assertIn('toplevel->CompositorDecorationMode()', answer)
        toplevel = between(HOST, 'const ui::WaylandToplevelExtension* WaylandToplevelOf(const views::Widget* widget) {', '\n}\n')
        self.assertIn('static_cast<aura::WindowTreeHostPlatform*>(window->GetHost())', toplevel)
        self.assertIn('ui::GetWaylandToplevelExtension(*platform)', toplevel)
        decided = between(HOST, 'bool ShellHostView::DecoratedByCompositor() const {', '\n}\n')
        self.assertIn('CompositorDecorates(DecorationAnswer(), LaunchDesktop())', decided)
        borderless = between(HOST, 'g_ardia_linux_borderless_frame = [](const BrowserWindowInterface* browser) {', '\n  };\n')
        self.assertIn('found->second->FrameIsBorderless()', borderless)
        borderless_decision = between(HOST, 'bool ShellHostView::FrameIsBorderless() const {', '\n}\n')
        self.assertIn('return followed_decorations_ ? followed_decorations_->first : DecoratedByCompositor();', borderless_decision)
        changed = between(HOST, 'g_ardia_linux_compositor_decoration_changed = [](gfx::AcceleratedWidget widget) {', '\n  };\n')
        self.assertIn('if (!host->HostsAcceleratedWidget(widget)) continue;', changed)
        self.assertIn('PostTask(\n          FROM_HERE, base::BindOnce(&ShellHostView::FollowDecorations, host->GetWeakPtr()));', changed)
        self.assertNotIn('RefreshEngineFrame', changed)
        follow = between(HOST, 'void ShellHostView::FollowDecorations() {', '\n}\n')
        self.assertIn('if (changed && (decorated || !attaching)) {\n    RefreshEngineFrame();\n  } else if (changed) {\n    RoundWindowCorners();\n  }', follow)
        self.assertIn('Event("ArdiaShell", linux_window_corners::kWindowDecorationsEvent', follow)
        initialize = between(HOST, 'void ShellHostView::Initialize() {', '\n}\n')
        self.assertIn('  LayoutOverlay();\n  FollowDecorations();\n', initialize)
        self.assertNotIn('RefreshEngineFrame();', initialize)
        route = HOST[HOST.index('if (method == "ArdiaShell.windowFrame" || method == "ArdiaShell.closeWindow" ||'):]
        self.assertLess(route.index('method == linux_window_corners::kWindowDecorationsCall ||'), route.index('ShellHostView* target = nullptr;'))
        self.assertIn('return std::move(done).Run(true, base::Value(target->WindowDecorationsValue()));', route)
        self.assertIn('for (const char* capability : ardia::linux_window_corners::kWindowCornersCapabilities) capabilities.Append(capability);', HOST)
        self.assertIn('bootstrap.Set("shellZoom", blink::ZoomLevelToZoomFactor(', HOST)

    def test_a_window_resize_reclips_every_page_even_when_the_frame_radii_stay(self):
        layout = between(HOST, 'void ShellHostView::LayoutOverlay() {', '\n}\n')
        self.assertLess(layout.index('SetBoundsRect(browser_view_->GetLocalBounds());'), layout.index('RoundWindowCorners();'))
        self.assertIn('void OnViewBoundsChanged(views::View*) override { LayoutOverlay(); }', HOST)
        round_corners = between(HOST, 'void ShellHostView::RoundWindowCorners() {', '\n}\n')
        self.assertLess(round_corners.index('ApplyWindowCorners(corners);'), round_corners.index('ClipViewport(binding->viewport());'))

    def test_a_window_still_at_the_default_size_keeps_its_visible_size_when_it_loses_the_frame(self):
        keep = between(HOST, 'void ShellHostView::KeepDefaultVisibleSize() {', '\n}\n')
        self.assertIn('const bool restored = !widget->IsMaximized() && !widget->IsFullscreen() && !widget->IsMinimized();', keep)
        self.assertNotIn('tiled()', keep)
        self.assertIn('DefaultWindowSizer(browser_).DefaultBounds(', keep)
        self.assertIn('linux_window_corners::DefaultBoundsWithoutFrame(', keep)
        self.assertIn('FramedRestoredInsets(), restored);\n  if (!kept) return;', keep)
        self.assertIn('widget->SetBounds(gfx::Rect(kept->x, kept->y, kept->width, kept->height));', keep)
        sizer = between(HOST, 'class DefaultWindowSizer : public WindowSizerLinux {', '\n};\n')
        self.assertIn('WindowSizerLinux(nullptr, browser)', sizer)
        self.assertIn('return GetDefaultWindowBounds(display);', sizer)
        framed = between(HOST, 'linux_window_corners::FrameInsets ShellHostView::FramedRestoredInsets() {', '\n}\n')
        self.assertLess(framed.index('base::AutoReset<bool> framed(&measuring_framed_insets_, true);'),
                        framed.index('tree_host->CalculateInsetsInDIP(ui::PlatformWindowState::kNormal)'))
        borderless = between(HOST, 'bool ShellHostView::FrameIsBorderless() const {', '\n}\n')
        self.assertLess(borderless.index('if (measuring_framed_insets_) return false;'),
                        borderless.index('return followed_decorations_'))
        follow = between(HOST, 'void ShellHostView::FollowDecorations() {', '\n}\n')
        self.assertEqual(follow.count('KeepDefaultVisibleSize();'), 1)
        self.assertIn('if (decorated && !default_size_followed_ &&\n'
                      '      (answer != linux_window_corners::DecorationAnswer::kNone || !HasWaylandToplevel())) {\n'
                      '    default_size_followed_ = true;\n    KeepDefaultVisibleSize();\n  }', follow)
        self.assertLess(follow.index('RefreshEngineFrame();'), follow.index('KeepDefaultVisibleSize();'))
        self.assertLess(follow.index('if (followed_decorations_ == std::pair(decorated, answer)) return;'),
                        follow.index('KeepDefaultVisibleSize();'))
        build = (LINUX / 'BUILD.gn').read_text()
        self.assertIn('"//chrome/browser/ui/views:window_sizer_linux",', build)

    def test_a_viewport_rounds_out_from_doubles_and_windows_report_the_decision_the_frame_follows(self):
        viewport = between(HOST, 'void ShellHostView::SetViewport(', '\n}\n')
        self.assertIn('linux_window_corners::EnclosingBox(left, top, right, bottom)', viewport)
        self.assertNotIn('gfx::RectF(left, top', viewport)
        decorations = between(HOST, 'base::DictValue ShellHostView::WindowDecorationsValue() const {', '\n}\n')
        self.assertIn('DecoratedByName(FrameIsBorderless())', decorations)
        self.assertIn('AnswerName(followed_decorations_ ? followed_decorations_->second', decorations)

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
        for phrase in ('GetWindowRoundedCorners', 'server-side', 'ac_linux_window_corners.h', 'overflow', 'per window',
                       'ArdiaShell.windowDecorations', 'shellZoom', 'SetIsFastRoundedCorner'):
            self.assertIn(phrase, outer)


if __name__ == '__main__':
    unittest.main()
