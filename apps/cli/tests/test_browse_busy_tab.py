import time
import unittest
from types import SimpleNamespace

from ardia_cli.browse.daemon import Daemon


class BusyOnStuckTab(unittest.TestCase):
    def daemon(self, unanswered_at):
        daemon = Daemon.__new__(Daemon)
        page = SimpleNamespace(target_id="T3", unanswered_at=unanswered_at)
        daemon.state = SimpleNamespace(extras={"running": {"name": "read", "since": time.monotonic() - 40}}, pages={"T3": page},
                                       tab_id=lambda target: "t3")
        return daemon

    def test_the_busy_message_names_a_tab_that_isnt_answering(self):
        error = self.daemon(time.monotonic() - 5).busy_error(waited=30)
        self.assertEqual(error.code, "session_busy")
        self.assertIn("`read`, which is waiting on [t3], a tab whose page isn't answering", error.message)

    def test_a_tab_that_answered_long_ago_isnt_named(self):
        self.assertNotIn("[t3]", self.daemon(time.monotonic() - 600).busy_error(waited=30).message)
        self.assertNotIn("[t3]", self.daemon(0.0).busy_error(waited=30).message)
