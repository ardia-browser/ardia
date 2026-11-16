import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli import command_metrics
from ardia_cli.browse import changes, commands, readpages
from ardia_cli.browse.errors import BrowseError, CdpError
from ardia_cli.browse.state import State

START = "https://mine.example/start"
DEST = "https://mine.example/dest"


class FakeBrowser:
    def __init__(self, state):
        self.state = state
        self.link = mock.Mock()
        self.sent = []
        self.attached = 0
        self.url = START
        self.loader = "L1"
        self.disable_hangs = False
        self.after_load = None
        self.params = []
        self.refuse_on_second_session = set()

    async def send(self, method, params=None, session=None, timeout=30, mutation=False):
        self.sent.append((method, session))
        self.params.append((method, params, session))
        if method in self.refuse_on_second_session and session != "S1":
            raise CdpError(method, "refused")
        if method == "Page.addScriptToEvaluateOnNewDocument":
            return {"identifier": "9"}
        if method == "Target.attachToTarget":
            self.attached += 1
            return {"sessionId": f"S{self.attached}"}
        if method == "Page.getFrameTree":
            return {"frameTree": {"frame": {"id": "F", "url": self.url, "loaderId": self.loader, "securityOrigin": "https://mine.example"}}}
        if method == "Page.getLayoutMetrics":
            return {"cssVisualViewport": {"clientWidth": 800, "clientHeight": 600}}
        if method == "Page.createIsolatedWorld":
            return {"executionContextId": 7}
        if method == "Runtime.callFunctionOn":
            source = params["functionDeclaration"]
            value = "Destination" if "document.title" in source else "complete" if "readyState" in source else False
            return {"result": {"value": value}}
        if method == "Page.navigate":
            self.url, self.loader = params["url"], "L2"
            asyncio.get_running_loop().call_soon(self.loaded, session)
            return {"frameId": "F", "loaderId": "L2"}
        if method == "Network.disable" and self.disable_hangs:
            await asyncio.sleep(30)
        return {}

    def loaded(self, session):
        self.state.on_event("Page.frameNavigated", {"frame": {"id": "F", "url": self.url, "loaderId": "L2"}}, session)
        self.state.on_event("Page.lifecycleEvent", {"frameId": "F", "loaderId": "L2", "name": "load"}, session)
        if self.after_load:
            self.after_load(session)


class OpenAfterDetach(unittest.TestCase):
    def setUp(self):
        self.state = State({"session": "t", "data_root": "/nowhere"}, lambda: None)
        self.state.instance = "I"
        self.state.target_infos = {"T": {"targetId": "T", "url": START, "type": "page"}}
        self.state.current = "T"
        self.browser = FakeBrowser(self.state)
        self.state.browser = self.browser
        self.metrics = command_metrics.Metrics("open", False, True)

        async def connect():
            return None

        async def before_navigating(page, url):
            return None

        async def arrival(ctx, page, came_from):
            return None

        self.state.connect = connect
        for patch in (mock.patch.object(readpages, "before_navigating", before_navigating), mock.patch.object(changes, "arrival", arrival),
                      mock.patch.object(changes, "STOP_TIMEOUT", 0.05)):
            patch.start()
            self.addCleanup(patch.stop)

    def open(self):
        async def run():
            command_metrics.current.set(self.metrics)
            await self.state.page("T")
            ctx = commands.Ctx(self.state, {}, "/", {}, None, "open")
            return await commands.cmd_open(ctx, [DEST])

        return asyncio.run(run())

    def test_an_open_whose_network_disable_goes_unanswered_keeps_its_tab_and_finishes(self):
        self.browser.disable_hangs = True
        result = self.open()
        self.assertEqual(result.data["url"], DEST)
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 1)
        self.assertNotIn("Target.detachFromTarget", [method for method, _ in self.browser.sent])
        self.assertEqual(self.state.pages["T"].session_id, "S1")
        self.assertTrue(self.metrics.values.get("network_disable_unconfirmed"))
        self.assertNotIn("reattached_after_detach", self.metrics.values)

    def detach_after_load(self):
        self.browser.after_load = lambda session: self.state.on_event("Target.detachedFromTarget", {"sessionId": session, "targetId": "T"}, None)

    def test_an_open_whose_session_ardia_ended_while_the_tab_stayed_open_attaches_again_and_finishes(self):
        self.detach_after_load()
        result = self.open()
        self.assertEqual(result.data["url"], DEST)
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 2)
        self.assertEqual(self.state.pages["T"].session_id, "S2")
        self.assertTrue(self.metrics.values.get("reattached_after_detach"))

    def test_a_renderer_that_exits_keeps_the_session_and_opens_no_other(self):
        def exits(session):
            for _ in range(3):
                self.state.on_event("Inspector.detached", {"reason": "Render process gone."}, session)

        self.browser.after_load = exits
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        self.assertEqual(self.browser.attached, 1)
        self.assertNotIn("Target.detachFromTarget", [method for method, _ in self.browser.sent])
        self.assertEqual(self.state.pages["T"].session_id, "S1")
        self.assertTrue(self.metrics.values.get("renderer_exit_kept_session"))
        self.assertNotIn("reattached_after_detach", self.metrics.values)

    def set_up_session(self):
        async def setup():
            page = await self.state.page("T")
            page.init_scripts["1"] = "window.hooked = 1"
            page.script_sources["1"] = "window.hooked = 1"
            page.overrides["Emulation.setGeolocationOverride"] = {"latitude": 1.0, "longitude": 2.0, "accuracy": 10}
            self.state.extras["claims"] = {("T", "route")}
            self.state.extras["credentials"] = {"username": "u", "password": "p"}

        asyncio.run(setup())

    def on_second_session(self):
        return [(method, params) for method, params, session in self.browser.params if session == "S2"]

    def test_a_reattach_puts_back_init_scripts_overrides_and_routes(self):
        self.set_up_session()
        self.detach_after_load()
        result = self.open()
        self.assertEqual(result.data["title"], "Destination")
        again = self.on_second_session()
        self.assertIn(("Page.addScriptToEvaluateOnNewDocument", {"source": "window.hooked = 1"}), again)
        self.assertIn(("Emulation.setGeolocationOverride", {"latitude": 1.0, "longitude": 2.0, "accuracy": 10}), again)
        self.assertIn(("Fetch.enable", {"patterns": [{"urlPattern": "*", "requestStage": "Request"}], "handleAuthRequests": True}), again)
        page = self.state.pages["T"]
        self.assertEqual(page.script_ids, {"1": "9"})
        self.assertTrue(self.metrics.values.get("setup_restored"))

    def test_a_reattach_that_cant_put_back_its_setup_fails_and_names_what_was_lost(self):
        self.set_up_session()
        self.browser.refuse_on_second_session = {"Emulation.setGeolocationOverride", "Page.addScriptToEvaluateOnNewDocument"}
        self.detach_after_load()
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "setup_lost")
        self.assertIn("init script 1", failed.exception.message)
        self.assertIn("the geolocation", failed.exception.message)
        page = self.state.pages["T"]
        self.assertEqual((page.init_scripts, page.overrides), ({}, {}))
        self.assertTrue(self.metrics.values.get("setup_restore_failed"))

    def test_an_open_whose_tab_closed_still_fails_as_detached(self):
        self.browser.after_load = lambda session: self.state.on_event("Target.targetDestroyed", {"targetId": "T"}, None)
        with self.assertRaises(BrowseError) as failed:
            self.open()
        self.assertEqual(failed.exception.code, "tab_detached")
        self.assertEqual(self.browser.attached, 1)
        self.assertNotIn("reattached_after_detach", self.metrics.values)


if __name__ == "__main__":
    unittest.main()
