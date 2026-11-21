import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import plugin_key_table

TREES = [os.environ.get("CHROMIUM_SRC", ""), os.path.expanduser("~/chromium-build-158/chromium_git/chromium/src"),
         os.path.expanduser("~/chromium-build/chromium_git/chromium/src")]


class PluginKeyTableTest(unittest.TestCase):
    def test_the_table_matches_the_keycode_tables_in_the_tree(self):
        tree = next((t for t in TREES if t and os.path.exists(os.path.join(t, plugin_key_table.KEYCODES, "dom_us_layout_data.h"))), None)
        if not tree:
            self.skipTest("no Chromium tree here to derive the table from")
        self.assertEqual(open(plugin_key_table.HEADER).read(), plugin_key_table.header_text(plugin_key_table.rows(tree)))


if __name__ == "__main__":
    unittest.main()
