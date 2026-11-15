import pathlib
import re
import unittest


HOST = pathlib.Path(__file__).resolve().parents[1] / 'src' / 'ardia' / 'linux' / 'ac_linux_host.cc'


class ShellCurtainTests(unittest.TestCase):
    def setUp(self):
        self.host = HOST.read_text()

    def body(self, signature):
        start = self.host.index(signature)
        end = self.host.index('\n}\n', start)
        return self.host[start:end]

    def test_window_is_covered_until_the_shell_paints(self):
        constructor = self.body('ShellHostView::ShellHostView(')
        self.assertIn('curtain->SetPaintToLayer();', constructor)
        self.assertIn('curtain->SetBackground(views::CreateSolidBackground(kColorWebContentsBackground));', constructor)
        self.assertIn('curtain->SetCanProcessEventsWithinSubtree(false);', constructor)
        self.assertLess(constructor.index('shell_ = AddChildView'), constructor.index('curtain_ = AddChildView'))

    def test_curtain_stays_above_the_shell_and_chrome_views(self):
        restack = self.body('void ShellHostView::Restack()')
        self.assertLess(restack.index('ReorderChildView(shell_, children().size());'),
                        restack.index('if (curtain_) ReorderChildView(curtain_, children().size());'))
        self.assertIn('if (curtain_) curtain_->SetBoundsRect(GetLocalBounds());', self.body('void ShellHostView::LayoutOverlay()'))

    def test_curtain_lifts_after_the_first_paint_or_a_deadline(self):
        initialize = self.body('void ShellHostView::Initialize()')
        self.assertIn('shell_first_paint_ = std::make_unique<ShellFirstPaint>(', initialize)
        self.assertIn('curtain_timer_.Start(FROM_HERE, kShellCurtainLimit,', initialize)
        self.assertIn('void DidFirstVisuallyNonEmptyPaint() override', self.host)
        painted = self.body('void ShellHostView::ShellPainted()')
        self.assertIn('kShellCurtainSettle', painted)
        lift = self.body('void ShellHostView::LiftCurtain()')
        self.assertIn('RemoveChildViewT(curtain);', lift)
        self.assertTrue(re.search(r'kShellCurtainLimit = base::Seconds\(\d+\);', self.host))


if __name__ == '__main__':
    unittest.main()
