import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plugin_clipboard_keys

HEADER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ac_cli_plugin_clipboard_keys.h")
TREES = [os.environ.get("CHROMIUM_SRC", ""), os.path.expanduser("~/chromium-build-158/chromium_git/chromium/src"),
         os.path.expanduser("~/chromium-build/chromium_git/chromium/src")]


def rows():
    return set((int(code), int(bits), key) for code, bits, key in
               re.findall(r'\{(\d+), (\d+), "([A-Za-z]*)"\}', open(HEADER).read()))


class PluginClipboardKeysTest(unittest.TestCase):
    def test_the_table_holds_every_clipboard_key_blink_knows_today(self):
        expected = {(0, 0, "Copy"), (0, 0, "Cut"), (0, 0, "Paste"), (45, 2, ""), (45, 8, ""), (46, 8, ""),
                    (67, 2, ""), (86, 2, ""), (86, 10, ""), (88, 2, "")}
        self.assertTrue(expected <= rows(), sorted(expected - rows()))

    def test_the_table_matches_editing_behavior_in_the_tree(self):
        tree = next((t for t in TREES if t and os.path.exists(os.path.join(t, plugin_clipboard_keys.EDITING_BEHAVIOR))), None)
        if not tree:
            self.skipTest("no Chromium tree here to derive the table from")
        self.assertEqual(open(HEADER).read(), plugin_clipboard_keys.header_text(plugin_clipboard_keys.entries(tree)))


if __name__ == "__main__":
    unittest.main()
