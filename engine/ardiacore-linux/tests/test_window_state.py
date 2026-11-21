import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
LINUX = SOURCE / 'ardia/linux'
REPO = ROOT.parents[1]
HOST = (LINUX / 'ac_linux_host.cc').read_text()


def between(text, start, end):
    body = text[text.index(start):]
    return body[:body.index(end)]


class WindowStateTests(unittest.TestCase):
    def test_tiled_means_the_compositor_tiled_all_four_edges_and_never_on_x11(self):
        with tempfile.TemporaryDirectory(prefix='ardia-window-state-') as directory:
            binary = Path(directory) / 'window-state'
            subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(SOURCE),
                            str(ROOT / 'tests/window_state_test.cc'), '-o', str(binary)],
                           check=True, text=True, timeout=180)
            result = subprocess.run([str(binary)], text=True, timeout=60, capture_output=True,
                                    env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, 'ok\n')

    def test_the_host_advertises_both_calls_under_their_contract_names(self):
        core = (LINUX / 'ac_linux_window_state.h').read_text()
        self.assertIn('kWindowButtonLayoutCall[] = "ArdiaShell.windowButtonLayout"', core)
        self.assertIn('kWindowStateCall[] = "ArdiaShell.windowState"', core)
        self.assertIn('kWindowButtonLayoutEvent[] = "windowButtonLayout"', core)
        self.assertIn('kWindowStateEvent[] = "windowState"', core)
        self.assertIn('for (const char* capability : ardia::linux_window_state::kWindowStateCapabilities) capabilities.Append(capability);', HOST)
        self.assertIn('"ac_linux_window_state.h"', (LINUX / 'BUILD.gn').read_text())

    def test_window_state_answers_for_a_window_the_caller_reaches_and_errors_for_an_unknown_one(self):
        route = HOST[HOST.index('if (method == "ArdiaShell.windowFrame" || method == "ArdiaShell.closeWindow" ||'):]
        self.assertLess(route.index('method == linux_window_state::kWindowStateCall ||'), route.index('ShellHostView* target = nullptr;'))
        self.assertLess(route.index('if (!target) return std::move(done).Run(false, base::Value("No such native window"));'),
                        route.index('if (method == linux_window_state::kWindowStateCall) {'))
        self.assertIn('return std::move(done).Run(true, base::Value(WindowStateValue(target->NativeWindowState())));', route)
        value = between(HOST, 'base::DictValue WindowStateValue(', '\n}\n')
        for key, field in (('maximized', 'maximized'), ('tiled', 'tiled'), ('fullScreen', 'full_screen')):
            self.assertIn(f'.Set("{key}", state.{field})', value)

    def test_window_state_reads_the_compositors_edges_and_reports_each_change_once(self):
        facts = between(HOST, 'linux_window_state::NativeWindow ShellHostView::NativeWindowFacts() const {', '\n}\n')
        self.assertIn('browser_view_->browser_widget()->tiled_edges()', facts)
        for fact in ('.maximized = widget->IsMaximized(),', '.widget_full_screen = widget->IsFullscreen(),',
                     '.window_full_screen = WindowFullScreen(),', '.compositor_reports_edges = !GlobalScreenCoordinates(),'):
            self.assertIn(fact, facts)
        native = between(HOST, 'linux_window_state::WindowState ShellHostView::NativeWindowState() const {', '\n}\n')
        self.assertIn('StateOf(NativeWindowFacts(), settled_window_state_)', native)
        schedule = between(HOST, 'void ShellHostView::ScheduleWindowStateReport() {', '\n}\n')
        self.assertIn('if (std::exchange(window_state_report_pending_, true)) return;', schedule)
        self.assertIn('GetWeakPtr()', schedule)
        report = between(HOST, 'void ShellHostView::ReportWindowState() {', '\n}\n')
        self.assertLess(report.index('if (reported_window_state_ == state) return;'), report.index('Event("ArdiaShell", linux_window_state::kWindowStateEvent'))
        self.assertLess(report.index('if (!linux_window_state::PageFullScreen(native)) settled_window_state_ = state;'),
                        report.index('if (reported_window_state_ == state) return;'))
        self.assertIn('.Set("windowId", window_id_)', report)
        for observer in ('void ShellHostView::OnWidgetBoundsChanged(views::Widget*, const gfx::Rect&) {\n  ScheduleWindowStateReport();',
                         'void ShellHostView::OnWidgetShowStateChanged(views::Widget* widget) {\n  ScheduleWindowStateReport();'):
            self.assertIn(observer, HOST)
        hook = between(HOST, 'g_ardia_linux_tiled_edges_changed = [](views::Widget* widget) {', '\n  };\n')
        self.assertIn('if (host->GetWidget() == widget) host->ScheduleWindowStateReport();', hook)

    def test_button_layout_is_gtks_raw_string_or_null_and_changes_reach_every_window_once(self):
        value = between(HOST, 'base::Value WindowButtonLayoutValue() {', '\n}\n')
        self.assertIn('linux_ui ? linux_ui->GetWindowButtonLayout() : std::nullopt', value)
        self.assertIn('ReportableToolkitString(*layout) ? base::Value(*layout) : base::Value()', value)
        self.assertIn('.Set("desktop", CurrentDesktop())', value)
        watch = between(HOST, 'class WindowButtonLayoutWatch : public ui::WindowButtonOrderObserver {', '\n};\n')
        self.assertIn('observation_.Observe(linux_ui)', watch)
        self.assertLess(watch.index('if (layout == reported_) return;'), watch.index('for (const auto& [id, host] : Hosts())'))
        self.assertIn('host->Event("ArdiaShell", linux_window_state::kWindowButtonLayoutEvent, layout.Clone());', watch)
        self.assertIn('static base::NoDestructor<WindowButtonLayoutWatch> window_button_layout_watch;', HOST)
        desktop = between(HOST, 'std::string CurrentDesktop() {', '\n}\n')
        self.assertIn('GetVar("XDG_CURRENT_DESKTOP")', desktop)
        call = between(HOST, 'if (method == linux_window_state::kWindowButtonLayoutCall) {', '\n  }\n')
        self.assertIn('return std::move(done).Run(true, WindowButtonLayoutValue());', call)

    def test_the_chromium_patch_keeps_the_raw_layout_and_the_tiled_edges_and_is_in_the_series(self):
        patch = (REPO / 'engine/patches/chromium-linux-window-state.patch').read_text()
        self.assertIn('+  virtual std::optional<std::string> GetWindowButtonLayout() const;', patch)
        self.assertIn('+  delegate_->SetWindowButtonLayout(gtk_layout);\n   delegate_->SetWindowButtonOrdering(', patch)
        self.assertIn('+  browser_widget_->set_tiled_edges(new_tiled_edges);', patch)
        self.assertIn('+void (*g_ardia_linux_tiled_edges_changed)(views::Widget* widget) = nullptr;', patch)
        self.assertIn('+  if (window_states.tiled_edges != notified_tiled_edges_) {', patch)
        self.assertIn('+    notified_tiled_edges_ = window_states.tiled_edges;\n     auto weak_this = AsWeakPtr();\n     delegate()->OnWindowTiledStateChanged(', patch)
        self.assertIn('+  std::optional<std::string> QtUi::GetWindowButtonLayout() const {'.replace('+  ', '+'), patch)
        self.assertIn('fallback_linux_ui_->GetWindowButtonLayout()', patch)
        self.assertIn('extern void (*g_ardia_linux_tiled_edges_changed)(views::Widget* widget);', HOST)
        self.assertIn('chromium chromium-linux-window-state.patch linux\n', (REPO / 'engine/patches/series').read_text())


if __name__ == '__main__':
    unittest.main()
