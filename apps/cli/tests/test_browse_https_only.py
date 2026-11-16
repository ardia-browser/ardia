import unittest
from types import SimpleNamespace

from ardia_cli.browse.commands import failed_navigation


class HttpsOnlyBlock(unittest.TestCase):
    def ctx(self):
        return SimpleNamespace(state=SimpleNamespace(extras={}))

    def test_a_blocked_http_address_says_why(self):
        error = failed_navigation(self.ctx(), "http://example.test/page", "net::ERR_BLOCKED_BY_CLIENT")
        self.assertIn("Ardia loads http:// addresses over https", error.message)
        self.assertIn("Try the https:// address", error.message)

    def test_other_blocks_keep_the_plain_error(self):
        error = failed_navigation(self.ctx(), "https://example.test/page", "net::ERR_BLOCKED_BY_CLIENT")
        self.assertEqual(error.message, "Navigation to https://example.test/page failed: net::ERR_BLOCKED_BY_CLIENT")


if __name__ == "__main__":
    unittest.main()
