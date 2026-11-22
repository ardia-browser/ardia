import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINUX = ROOT / 'src/ardia/linux'
PATCHES = ROOT.parent / 'patches'
PATCH = PATCHES / 'chromium-linux-borderless-frame.patch'
FRAMELESS = PATCHES / 'chromium-linux-frameless-utility-windows.patch'
FRAME = 'chrome/browser/ui/views/frame/'

HUNK = re.compile(r'^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@')


def preimages(patch_text):
    files = {}
    lines = None
    position = 0
    for line in patch_text.splitlines():
        if line.startswith('--- a/'):
            lines = files.setdefault(line[len('--- a/'):], {})
            continue
        if lines is None or line.startswith('+++ '):
            continue
        hunk = HUNK.match(line)
        if hunk:
            position = int(hunk.group(1))
        elif line.startswith((' ', '-')) or line == '':
            lines[position] = line[1:]
            position += 1
    return {path: '\n'.join(lines.get(number, '') for number in range(1, max(lines) + 1)) + '\n'
            for path, lines in files.items()}


class BorderlessFrameTests(unittest.TestCase):
    def setUp(self):
        self.host = (LINUX / 'ac_linux_host.cc').read_text()

    def contains(self, needle, text):
        self.assertTrue(needle in text, f'missing from the text: {needle!r}')

    def patched(self):
        if shutil.which('git') is None:
            self.skipTest('git is unavailable')
        self.assertTrue(PATCH.exists(), f'{PATCH.name} is missing')
        with tempfile.TemporaryDirectory(prefix='ardia-borderless-') as directory:
            root = Path(directory)
            before = preimages(PATCH.read_text())
            for path, text in before.items():
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_text(text)
            result = subprocess.run(['git', 'apply', '--whitespace=nowarn', str(PATCH)], cwd=directory,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, f'{PATCH.name}: {result.stderr}')
            return {path.removeprefix(FRAME): (root / path).read_text() for path in before}

    def test_the_patch_is_linux_only_and_after_the_frameless_patch(self):
        steps = [line.split() for line in (PATCHES / 'series').read_text().splitlines() if line.startswith('chromium ')]
        names = [step[1] for step in steps]
        self.contains(PATCH.name, names)
        at = names.index(PATCH.name)
        self.assertEqual(steps[at], ['chromium', PATCH.name, 'linux'])
        self.assertGreater(at, names.index(FRAMELESS.name))
        self.assertEqual(names.count(PATCH.name), 1)

    def test_the_hook_alone_names_the_borderless_windows(self):
        view = self.patched()['browser_view.cc']
        self.contains('bool (*g_ardia_linux_borderless_frame)(const BrowserWindowInterface*) = nullptr;\n', view)
        self.contains('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view) {\n'
                      '  if (!g_ardia_linux_borderless_frame || !browser_view) {\n    return false;\n  }\n'
                      '  const BrowserWindowInterface* browser = browser_view->browser();\n'
                      '  return browser && g_ardia_linux_borderless_frame(browser);\n}\n', view)
        self.assertNotIn('ArdiaLinuxFramelessApp(browser) ||', PATCH.read_text())

    def test_each_toplevel_keeps_its_compositors_answer_and_tells_the_host_which_window_changed(self):
        files = self.patched()
        toplevel = files['ui/ozone/platform/wayland/host/xdg_toplevel.cc']
        self.contains('void (*g_ardia_linux_compositor_decoration_changed)(gfx::AcceleratedWidget widget) = nullptr;\n\n'
                      'namespace ui {\n', toplevel)
        self.contains('  self->decoration_mode_ = ToDecorationMode(mode);\n'
                      '  self->compositor_decoration_mode_ = mode;\n'
                      '  if (g_ardia_linux_compositor_decoration_changed && self->window()) {\n'
                      '    g_ardia_linux_compositor_decoration_changed(self->window()->GetWidget());\n  }\n}\n', toplevel)
        self.assertNotIn('g_ardia_linux_compositor_decoration_mode', PATCH.read_text())
        header = files['ui/ozone/platform/wayland/host/xdg_toplevel.h']
        self.contains('  uint32_t compositor_decoration_mode() const {\n    return compositor_decoration_mode_;\n  }\n', header)
        self.contains('  uint32_t compositor_decoration_mode_ = 0;\n', header)
        self.contains('  virtual int CompositorDecorationMode() const = 0;\n', files['ui/platform_window/extensions/wayland_extension.h'])
        self.contains('  int CompositorDecorationMode() const override;\n', files['ui/ozone/platform/wayland/host/wayland_toplevel_window.h'])
        self.contains('int WaylandToplevelWindow::CompositorDecorationMode() const {\n  return xdg_toplevel_\n'
                      '             ? static_cast<int>(xdg_toplevel_->compositor_decoration_mode())\n             : 0;\n}\n',
                      files['ui/ozone/platform/wayland/host/wayland_toplevel_window.cc'])
        self.contains('extern void (*g_ardia_linux_compositor_decoration_changed)(gfx::AcceleratedWidget widget);', self.host)

    def test_the_frame_layout_gives_the_client_the_whole_window(self):
        files = self.patched()
        layout = files['browser_frame_view_layout_linux.cc']
        self.contains('class BrowserView;\n\nbool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view);\n', layout)
        self.contains('gfx::Insets BrowserFrameViewLayoutLinux::GetInputInsets() const {\n'
                      '  if (ArdiaBorderless()) {\n    return gfx::Insets();\n  }\n', layout)
        self.contains('gfx::Insets BrowserFrameViewLayoutLinux::RestoredFrameBorderInsets() const {\n'
                      '  if (ArdiaBorderless()) {\n    return gfx::Insets();\n  }\n', layout)
        self.contains('bool BrowserFrameViewLayoutLinux::ArdiaBorderless() const {\n'
                      '  return view_ && ArdiaLinuxBorderlessFrame(view_->GetBrowserView());\n}\n', layout)
        header = files['browser_frame_view_layout_linux.h']
        self.contains('  int NonClientExtraTopThickness() const override;\n\n'
                      '  bool ArdiaBorderless() const;\n', header)
        self.assertLess(header.index('bool ArdiaBorderless() const;'), header.index(' private:'))
        native = files['browser_frame_view_layout_linux_native.cc']
        self.contains('BrowserFrameViewLayoutLinuxNative::RestoredFrameBorderInsets()\n    const {\n'
                      '  if (ArdiaBorderless()) {\n    return gfx::Insets();\n  }\n', native)

    def test_the_frame_view_paints_no_border_shadow_or_corners(self):
        files = self.patched()
        view = files['browser_frame_view_linux.cc']
        self.contains('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view);\n', view)
        self.contains('void BrowserFrameViewLinux::PaintRestoredFrameBorder(\n    gfx::Canvas* canvas) const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return;\n  }\n', view)
        self.contains('bool BrowserFrameViewLinux::ShouldDrawRestoredFrameShadow() const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return false;\n  }\n', view)
        self.contains('float BrowserFrameViewLinux::GetRestoredCornerRadiusDip() const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return 0;\n  }\n', view)
        native = files['browser_frame_view_linux_native.cc']
        self.contains('bool ArdiaLinuxBorderlessFrame(const BrowserView* browser_view);\n', native)
        self.contains('float BrowserFrameViewLinuxNative::GetRestoredCornerRadiusDip() const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return 0;\n  }\n', native)
        self.contains('    gfx::Canvas* canvas) const {\n'
                      '  if (ArdiaLinuxBorderlessFrame(GetBrowserView())) {\n    return;\n  }\n'
                      '  layout_->GetFrameProvider()->PaintWindowFrame(\n', native)

    def test_a_thin_band_along_the_edges_still_resizes_the_window(self):
        view = self.patched()['browser_frame_view_linux.cc']
        hit = view[view.index('int BrowserFrameViewLinux::NonClientHitTest('):]
        hit = hit[:hit.index('float BrowserFrameViewLinux::GetRestoredCornerRadiusDip')]
        self.contains('ArdiaLinuxBorderlessFrame(GetBrowserView()) && !IsFrameCondensed() &&\n      !browser_widget()->tiled()) {', hit)
        self.contains('browser_widget()->widget_delegate()', hit)
        self.contains('point, gfx::Insets(kResizeTopBorderThickness)', hit)
        self.contains('if (delegate && delegate->CanResize()) {', hit)
        self.contains('kResizeAreaCornerSize, kResizeAreaCornerSize, true);', hit)
        self.contains('if (edge != HTNOWHERE) {\n        return edge;\n      }', hit)
        self.assertLess(hit.index('GetHTComponentForFrame('), hit.index('OpaqueBrowserFrameView::NonClientHitTest(point)'))

    def test_x11_rewrites_the_frame_extents_when_the_host_lays_the_frame_out_again(self):
        files = self.patched()
        extension = files['ui/platform_window/extensions/x11_extension.h']
        self.contains('  virtual void RefreshDecorationInsets() {}\n', extension)
        self.assertLess(extension.index('virtual void RefreshDecorationInsets() {}'), extension.index(' protected:'))
        self.contains('  void RefreshDecorationInsets() override;\n', files['ui/ozone/platform/x11/x11_window.h'])
        self.contains('void X11Window::RefreshDecorationInsets() {\n'
                      '  UpdateDecorationInsets();\n}\n',
                      files['ui/ozone/platform/x11/x11_window.cc'])
        self.contains('void BrowserDesktopWindowTreeHostLinux::FrameTypeChanged() {\n'
                      '  DesktopWindowTreeHostPlatform::FrameTypeChanged();\n  UpdateFrameHints();\n'
                      '  if (auto* x11_extension = GetX11Extension()) {\n'
                      '    x11_extension->RefreshDecorationInsets();\n  }\n}\n',
                      files['browser_desktop_window_tree_host_linux.cc'])
        refresh = self.host[self.host.index('void ShellHostView::RefreshEngineFrame() {'):]
        self.contains('GetWidget()->FrameTypeChanged();', refresh[:refresh.index('\n}\n')])

    def test_the_host_drops_the_frame_only_where_the_compositor_decorates_that_window(self):
        self.contains('extern bool (*g_ardia_linux_borderless_frame)(const BrowserWindowInterface*);', self.host)
        self.contains('g_ardia_linux_borderless_frame = [](const BrowserWindowInterface* browser) {\n'
                      '    if (!browser) return false;\n'
                      '    const auto found = Hosts().find(browser->GetSessionID().id());\n'
                      '    return found != Hosts().end() && found->second->FrameIsBorderless();\n  };', self.host)
        desktop = self.host[self.host.index('const std::string& LaunchDesktop() {'):]
        self.contains('static const base::NoDestructor<std::string> desktop(CurrentDesktop());', desktop[:desktop.index('\n}\n')])

    def test_the_host_lays_the_frame_out_again_only_for_a_window_the_compositor_decorates(self):
        initialize = self.host[self.host.index('void ShellHostView::Initialize() {'):]
        initialize = initialize[:initialize.index('\n}\n')]
        self.contains('  LayoutOverlay();\n  FollowDecorations();\n', initialize)
        follow = self.host[self.host.index('void ShellHostView::FollowDecorations() {'):]
        follow = follow[:follow.index('\n}\n')]
        self.contains('if (changed && (decorated || !attaching)) {\n    RefreshEngineFrame();', follow)
        refresh = self.host[self.host.index('void ShellHostView::RefreshEngineFrame() {'):]
        refresh = refresh[:refresh.index('\n}\n')]
        self.contains('GetWidget()->FrameTypeChanged();', refresh)
        self.contains('frame->InvalidateLayout();', refresh)
        self.contains('frame->SchedulePaint();\n  HideCaptionButtons();', refresh)

    def test_the_docs_say_what_the_frame_does(self):
        docs = (ROOT.parents[1] / 'docs/linux-port.md').read_text()
        outer = docs[docs.index('- **Outer frame.**'):]
        outer = outer[:outer.index('- **Menu button.**')]
        self.contains('chromium-linux-borderless-frame.patch', outer)
        self.assertNotIn("doesn't replace its frame", outer)


    def test_the_linux_window_sizer_marks_only_the_browsers_it_gives_the_default_size(self):
        files = self.patched()
        header = files['chrome/browser/ui/views/window_sizer_linux.h']
        self.contains('bool ArdiaLinuxTakeDefaultSizedBrowser(const BrowserWindowInterface* browser);', header)
        self.contains('  gfx::Rect GetDefaultWindowBounds(\n      const display::Display& display) const override;', header)
        self.contains('      "//components/sessions:session_id",\n', files['chrome/browser/ui/views/BUILD.gn'])
        sizer = files['chrome/browser/ui/views/window_sizer_linux.cc']
        self.contains('#include "components/sessions/core/session_id.h"', sizer)
        mark = sizer[sizer.index('gfx::Rect WindowSizerLinux::GetDefaultWindowBounds('):]
        self.assertLess(mark.index('ArdiaDefaultSizedBrowsers().insert(browser()->GetSessionID().id());'),
                        mark.index('return WindowSizer::GetDefaultWindowBounds(display);'))
        take = sizer[sizer.index('bool ArdiaLinuxTakeDefaultSizedBrowser('):]
        self.contains('ArdiaDefaultSizedBrowsers().erase(browser->GetSessionID().id()) > 0;', take[:take.index('\n}\n')])
        self.assertNotIn('ArdiaDefaultSizedBrowsers', sizer[:sizer.index('static base::flat_set<SessionID::id_type>& ArdiaDefaultSizedBrowsers()')])

    def test_the_patch_matches_a_real_tree_when_one_is_at_hand(self):
        tree = Path(os.environ.get('CHROMIUM_SRC', ''))
        if not os.environ.get('CHROMIUM_SRC') or not (tree / 'ui/ozone/platform/wayland/host/xdg_toplevel.cc').exists():
            self.skipTest('series.py check guards drift against the real tree; set CHROMIUM_SRC to a tree the series was applied to')
        result = subprocess.run(['git', 'apply', '--check', '-R', str(PATCH)], cwd=tree, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, f'{PATCH.name} is not what {tree} holds: {result.stderr}')


if __name__ == '__main__':
    unittest.main()
