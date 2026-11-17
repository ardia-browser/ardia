import asyncio
import time
import unittest
from types import SimpleNamespace

from ardia_cli.browse.page import FETCHES_TRACKED, Page
from ardia_cli.browse import readpages
from ardia_cli.browse.readpages import FETCH_FRESH, fetching


class FetchWait(unittest.TestCase):
    def tracker(self):
        return SimpleNamespace(fetches_started={}, fetch_loaders={}, fetches_busy_until=0.0, network_on=True)

    def test_an_unfinished_fetch_counts_until_it_ages_out(self):
        page = self.tracker()
        Page.track_fetch(page, "Network.requestWillBeSent", "r1", {"type": "Fetch"})
        self.assertTrue(fetching(page, frozenset()))
        page.fetches_started["r1"] -= FETCH_FRESH + 0.1
        self.assertFalse(fetching(page, frozenset()))

    def test_age_comes_from_when_the_request_started(self):
        page = self.tracker()
        page.fetches_started["old"] = time.monotonic() - 5
        self.assertFalse(fetching(page, frozenset()))

    def test_finished_other_types_and_earlier_requests_dont_count(self):
        page = self.tracker()
        Page.track_fetch(page, "Network.requestWillBeSent", "img", {"type": "Image"})
        Page.track_fetch(page, "Network.requestWillBeSent", "done", {"type": "XHR"})
        Page.track_fetch(page, "Network.loadingFinished", "done", {})
        Page.track_fetch(page, "Network.requestWillBeSent", "before", {"type": "XHR"})
        self.assertFalse(fetching(page, frozenset({"before"})))
        Page.track_fetch(page, "Network.requestWillBeSent", "failed", {"type": "XHR"})
        Page.track_fetch(page, "Network.loadingFailed", "failed", {})
        self.assertFalse(fetching(page, frozenset({"before"})))

    def test_a_fresh_fetch_pushed_out_by_a_burst_still_counts(self):
        page = self.tracker()
        for index in range(FETCHES_TRACKED + 1):
            Page.track_fetch(page, "Network.requestWillBeSent", f"r{index}", {"type": "Fetch"})
        self.assertNotIn("r0", page.fetches_started)
        for index in range(1, FETCHES_TRACKED + 1):
            Page.track_fetch(page, "Network.loadingFinished", f"r{index}", {})
        self.assertEqual(page.fetches_started, {})
        self.assertTrue(fetching(page, frozenset()))
        page.fetches_busy_until -= FETCH_FRESH + 0.1
        self.assertFalse(fetching(page, frozenset()))

    def test_expired_fetches_make_room_without_holding_the_wait(self):
        page = self.tracker()
        stale = time.monotonic() - FETCH_FRESH - 1
        page.fetches_started = {f"old{index}": stale for index in range(FETCHES_TRACKED)}
        Page.track_fetch(page, "Network.requestWillBeSent", "new", {"type": "XHR"})
        self.assertEqual(list(page.fetches_started), ["new"])
        self.assertEqual(page.fetches_busy_until, 0.0)

    def test_no_network_means_no_wait(self):
        page = self.tracker()
        Page.track_fetch(page, "Network.requestWillBeSent", "r1", {"type": "Fetch"})
        page.network_on = False
        self.assertFalse(fetching(page, frozenset()))


if __name__ == "__main__":
    unittest.main()

    def test_a_fetch_remembers_its_document_until_it_finishes(self):
        page = self.tracker()
        Page.track_fetch(page, "Network.requestWillBeSent", "r1", {"type": "Fetch", "loaderId": "L1"})
        self.assertEqual(page.fetch_loaders, {"r1": "L1"})
        Page.track_fetch(page, "Network.loadingFinished", "r1", {})
        self.assertEqual(page.fetch_loaders, {})


class CrossDocumentPage:
    def __init__(self, late_loader):
        self.late_loader = late_loader
        self.url = "http://s/first"
        self.main_frame = "F"
        self.frames = {"F": {"loader": "L1"}}
        self.lifecycle = {}
        self.network_on = True
        self.fetches_started = {}
        self.fetch_loaders = {}
        self.fetches_busy_until = 0.0

    def loader(self, frame_id):
        return self.frames[frame_id]["loader"]

    async def send(self, method, params=None, timeout=30, mutation=False):
        Page.track_fetch(self, "Network.requestWillBeSent", "late", {"type": "Fetch", "loaderId": self.late_loader})
        self.frames = {"F": {"loader": "L2"}}
        self.lifecycle = {"F": ("L2", {"DOMContentLoaded", "load"})}
        return {"frameId": "F", "loaderId": "L2"}

    async def call(self, function, *args, frame=None, read=False, **kwargs):
        return ["complete", "results", False]

    async def refresh_frames(self):
        return self.frames


class NavigationFetches(unittest.TestCase):
    def timed_goto(self, late_loader):
        page = CrossDocumentPage(late_loader)

        async def go():
            started = time.monotonic()
            await readpages.goto(None, page, "http://s/next", 10)
            return time.monotonic() - started

        return asyncio.run(go())

    def test_a_late_fetch_from_the_page_navigated_away_from_doesnt_hold_the_read(self):
        self.assertLess(self.timed_goto("L1"), FETCH_FRESH - 0.2)

    def test_a_fetch_from_the_new_page_still_holds_the_read(self):
        self.assertGreaterEqual(self.timed_goto("L2"), FETCH_FRESH - 0.1)


class KeepAwake(unittest.TestCase):
    def page(self, explicit, opened=True):
        state = SimpleNamespace(endpoint=SimpleNamespace(explicit=explicit), opened={"T"} if opened else set())
        page = SimpleNamespace(state=state, target_id="T", awake=False, sent=[])

        async def send(method, params=None, **kwargs):
            page.sent.append((method, params))
            return {}

        page.send = send
        return page

    def test_a_tab_on_a_plain_browser_gets_focus_emulation(self):
        page = self.page(explicit=True)
        asyncio.run(Page.keep_awake(page))
        self.assertEqual(page.sent, [("Emulation.setFocusEmulationEnabled", {"enabled": True})])
        self.assertTrue(page.awake)

    def test_ardias_token_path_is_left_to_the_engine(self):
        page = self.page(explicit=False)
        asyncio.run(Page.keep_awake(page))
        self.assertEqual(page.sent, [])
        self.assertFalse(page.awake)


class SilentSite(unittest.TestCase):
    def test_a_site_that_never_answers_is_a_timeout_naming_it(self):
        from ardia_cli.browse.errors import BrowseError, OutcomeUnknown

        page = CrossDocumentPage("L1")

        async def send(method, params=None, timeout=30, mutation=False):
            raise OutcomeUnknown("`Page.navigate`", f"Ardia didn't answer Page.navigate in {timeout:g}s after it was sent")

        page.send = send
        with self.assertRaises(BrowseError) as caught:
            asyncio.run(readpages.goto(None, page, "https://slow.example.gov/report?id=7", 5))
        self.assertNotIsInstance(caught.exception, OutcomeUnknown)
        self.assertEqual(caught.exception.code, "timeout")
        self.assertIn("slow.example.gov sent nothing back within 5 s", caught.exception.message)
        self.assertIn("as the site gave it", caught.exception.message)

    def test_a_tab_detached_mid_navigation_stays_an_unknown_outcome(self):
        from ardia_cli.browse.errors import OutcomeUnknown

        page = CrossDocumentPage("L1")

        async def send(method, params=None, timeout=30, mutation=False):
            raise OutcomeUnknown("`Page.navigate`", "Ardia detached the tab before it answered Page.navigate")

        page.send = send
        with self.assertRaises(OutcomeUnknown):
            asyncio.run(readpages.goto(None, page, "http://s/next", 5))
