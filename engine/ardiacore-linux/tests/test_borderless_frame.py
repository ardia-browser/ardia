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

    def test_wayland_records_the_compositors_decoration_answer_and_tells_the_host(self):
        toplevel = self.patched()['ui/ozone/platform/wayland/host/xdg_toplevel.cc']
        self.contains('int g_ardia_linux_compositor_decoration_mode = 0;\n'
                      'void (*g_ardia_linux_compositor_decoration_changed)() = nullptr;\n\nnamespace ui {\n', toplevel)
        self.contains('  self->decoration_mode_ = ToDecorationMode(mode);\n'
                      '  g_ardia_linux_compositor_decoration_mode = static_cast<int>(mode);\n'
                      '  if (g_ardia_linux_compositor_decoration_changed) {\n'
                      '    g_ardia_linux_compositor_decoration_changed();\n  }\n}\n', toplevel)
        self.contains('extern int g_ardia_linux_compositor_decoration_mode;', self.host)
        self.contains('extern void (*g_ardia_linux_compositor_decoration_changed)();', self.host)

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
        self.contains('ArdiaLinuxBorderlessFrame(GetBrowserView()) && !IsFrameCondensed()', hit)
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

    def test_the_host_drops_the_frame_only_where_the_compositor_decorates(self):
        self.contains('extern bool (*g_ardia_linux_borderless_frame)(const BrowserWindowInterface*);', self.host)
        self.contains('g_ardia_linux_borderless_frame = [](const BrowserWindowInterface* browser) {\n'
                      '    return browser && Hosts().contains(browser->GetSessionID().id()) && CompositorDecorates();\n  };',
                      self.host)
        decides = self.host[self.host.index('bool CompositorDecorates() {'):]
        decides = decides[:decides.index('\n}\n')]
        self.contains('static const base::NoDestructor<std::string> desktop(CurrentDesktop());', decides)
        self.contains('DecorationAnswerOf(g_ardia_linux_compositor_decoration_mode), *desktop', decides)
        changed = self.host[self.host.index('g_ardia_linux_compositor_decoration_changed = [] {'):]
        changed = changed[:changed.index('\n  };\n')]
        self.assertLess(changed.index('if (followed == decorates) return;'),
                        changed.index('for (const auto& [id, host] : Hosts()) host->RefreshEngineFrame();'))

    def test_the_host_lays_the_frame_out_again_once_the_window_is_its_own(self):
        initialize = self.host[self.host.index('void ShellHostView::Initialize() {'):]
        initialize = initialize[:initialize.index('\n}\n')]
        self.contains('  LayoutOverlay();\n  RefreshEngineFrame();\n', initialize)
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


if __name__ == '__main__':
    unittest.main()
