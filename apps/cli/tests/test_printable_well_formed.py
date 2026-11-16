import io
import unittest
from contextlib import redirect_stderr, redirect_stdout

from ardia_cli.printable import complain, say, well_formed


class WellFormed(unittest.TestCase):
    def test_a_lone_surrogate_becomes_a_replacement_character(self):
        self.assertEqual(well_formed("a \ud83e b"), "a � b")
        well_formed("a \ud83e b").encode("utf-8")

    def test_a_surrogate_pair_becomes_its_character(self):
        self.assertEqual(well_formed("🤝"), "\U0001f91d")

    def test_ordinary_text_is_returned_as_is(self):
        text = "Ka'Chava 🤝 café"
        self.assertIs(well_formed(text), text)


    def test_say_and_complain_print_text_with_half_an_emoji(self):
        out, err = io.TextIOWrapper(io.BytesIO(), encoding="utf-8"), io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        with redirect_stdout(out), redirect_stderr(err):
            say("title \ud83e")
            complain("title \ud83e")
        out.seek(0)
        err.seek(0)
        self.assertEqual(out.read(), "title \ufffd\n")
        self.assertEqual(err.read(), "title \ufffd\n")


if __name__ == "__main__":
    unittest.main()
