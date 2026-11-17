import asyncio
import base64
import unittest
from types import SimpleNamespace

from ardia_cli.browse import commands
from ardia_cli.browse.errors import BrowseError


def ctx_with(answer):
    async def call(function, *args, frame=None, read=False, **kwargs):
        return answer

    page = SimpleNamespace(call=call, main_frame="F")

    async def get_page():
        return page

    return SimpleNamespace(state=SimpleNamespace(page=get_page))


class RemoteDownload(unittest.TestCase):
    def test_a_file_saved_on_the_browsers_machine_is_fetched_through_the_page(self):
        ctx = ctx_with({"data": base64.b64encode(b"city,price\nOslo,12").decode()})
        self.assertEqual(asyncio.run(commands.fetch_again(ctx, "https://s/export.csv")), b"city,price\nOslo,12")

    def test_a_failed_fetch_says_where_the_file_went(self):
        ctx = ctx_with({"status": 403})
        with self.assertRaises(BrowseError) as caught:
            asyncio.run(commands.fetch_again(ctx, "https://s/export.csv"))
        self.assertEqual(caught.exception.code, "download_remote")
        self.assertIn("saved the file on its own machine", caught.exception.message)
        self.assertIn("HTTP 403", caught.exception.message)
