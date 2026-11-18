import unittest

from ardia_cli import command_metrics
from ardia_cli.browse.script import split_command_line


class ScriptCommandLine(unittest.TestCase):
    def setUp(self):
        self.metrics = command_metrics.Metrics("script", False, True)
        token = command_metrics.current.set(self.metrics)
        self.addCleanup(command_metrics.current.reset, token)

    def test_a_whole_command_line_in_one_string_is_split(self):
        self.assertEqual(split_command_line(["read --data"]), ["read", "--data"])
        self.assertEqual(split_command_line(["get text 'h1 > a'"]), ["get", "text", "h1 > a"])
        self.assertTrue(self.metrics.values["script_command_line_split"])

    def test_separate_arguments_and_plain_text_are_left_alone(self):
        self.assertEqual(split_command_line(["fill", "#q", "two words"]), ["fill", "#q", "two words"])
        self.assertEqual(split_command_line(["read"]), ["read"])
        self.assertEqual(split_command_line(["no such command here"]), ["no such command here"])
        self.assertEqual(split_command_line(["read 'unclosed"]), ["read 'unclosed"])
        self.assertNotIn("script_command_line_split", self.metrics.values)


if __name__ == "__main__":
    unittest.main()
