import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli.browse.snapshot import Node, render


def card(title: str, ref: str) -> Node:
    return Node("generic", children=[Node("heading", title), Node("StaticText", "$39"), Node("button", "Add to cart", ref=ref)])


class RepeatLabels(unittest.TestCase):
    def test_repeated_buttons_name_the_card_they_sit_in(self):
        tree = [Node("RootWebArea", "Shop", children=[card("Steel kettle", "e1"), card("Glass kettle", "e2"), Node("button", "Checkout", ref="e3")])]
        shown = render(tree, interactive=True)
        self.assertIn('- button "Add to cart" [ref=e1] (near "Steel kettle")', shown)
        self.assertIn('- button "Add to cart" [ref=e2] (near "Glass kettle")', shown)
        self.assertIn('- button "Checkout" [ref=e3]', shown)
        self.assertNotIn('Checkout" [ref=e3] (near', shown)

    def test_a_nameless_control_gets_the_text_beside_it(self):
        tree = [Node("RootWebArea", "Mail", children=[Node("generic", children=[Node("StaticText", "Weekly report"), Node("button", "", ref="e9")])])]
        self.assertIn('[ref=e9] (near "Weekly report")', render(tree, interactive=True))


if __name__ == "__main__":
    unittest.main()
