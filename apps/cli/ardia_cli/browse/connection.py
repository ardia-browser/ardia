import asyncio
import logging

from ardia_cli import command_metrics
from ardia_cli.browse.errors import POLICY_REFUSAL, CdpError, CdpTimeout, ConnectionLost, Gated, OutcomeUnknown, Unreachable, refusal_reason

MAX_MESSAGE = 256 * 1024 * 1024
CONNECT_TIMEOUT = 10
EVENTS = (
    "Target.targetCreated",
    "Target.targetDestroyed",
    "Target.targetInfoChanged",
    "Target.detachedFromTarget",
    "Target.attachedToTarget",
    "Inspector.detached",
    "Inspector.targetCrashed",
    "Inspector.targetReloadedAfterCrash",
    "Page.lifecycleEvent",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Page.loadEventFired",
    "Page.domContentEventFired",
    "Page.javascriptDialogOpening",
    "Page.javascriptDialogClosed",
    "Page.frameDetached",
    "Page.screencastFrame",
    "Input.dragIntercepted",
    "Runtime.consoleAPICalled",
    "Runtime.exceptionThrown",
    "Runtime.executionContextsCleared",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Network.loadingFinished",
    "Network.loadingFailed",
    "Network.dataReceived",
    "Fetch.requestPaused",
    "Fetch.authRequired",
    "Tracing.dataCollected",
    "Tracing.tracingComplete",
    "Browser.downloadWillBegin",
    "Browser.downloadProgress",
)


MUTATING_METHODS = frozenset({
    "Page.navigate", "Page.reload", "Page.handleJavaScriptDialog", "Page.addScriptToEvaluateOnNewDocument",
    "Page.removeScriptToEvaluateOnNewDocument", "Page.bringToFront", "DOM.setFileInputFiles", "DOM.focus", "Network.setCookie",
    "Network.setCookies", "Network.clearBrowserCookies", "Network.setExtraHTTPHeaders", "Network.emulateNetworkConditions",
    "Fetch.fulfillRequest", "Fetch.failRequest", "Fetch.continueRequest", "Fetch.continueWithAuth", "Overlay.highlightNode",
    "Target.createTarget", "Target.closeTarget", "Target.activateTarget", "Browser.setDownloadBehavior", "Browser.grantPermissions",
})


def is_mutation(method: str) -> bool:
    return method in MUTATING_METHODS or method.startswith(("Input.", "Emulation."))


def failure(method: str, error) -> Exception:
    detail = error.detail or "The browser rejected the command"
    text = f"{method}: {detail} (code {error.code})"
    if POLICY_REFUSAL in text:
        return Gated(method, reason=refusal_reason(text, method))
    return CdpError(method, detail)


class Browser:
    def __init__(self, endpoint, on_event):
        self.endpoint = endpoint
        self.on_event = on_event
        self.link = None
        self.closed_by_us = False

    @property
    def instance(self) -> str | None:
        return self.endpoint.instance

    async def open(self):
        from ardia_cli.cdp import Connection

        self.link = Connection(self.endpoint.ws, max_size=MAX_MESSAGE)
        try:
            await self.link.open(CONNECT_TIMEOUT)
        except Exception as error:
            from ardia_cli.browse.daemon import unreachable_message

            raise Unreachable(unreachable_message(self.endpoint, error)) from None
        for name in EVENTS:
            self.link.on(name, self._event)

    def _event(self, method: str, params: dict, session: str | None):
        try:
            self.on_event(method, params, session)
        except Exception:
            logging.getLogger("ardia_cli.browse").exception("event handler failed")

    @property
    def alive(self) -> bool:
        return self.link is not None and not self.link.lost.is_set()

    async def send(self, method: str, params: dict | None = None, session: str | None = None, timeout: float = 30, mutation: bool = False):
        from ardia_cli import cdp

        method = getattr(method, "value", method)
        if not self.alive:
            raise ConnectionLost()
        command = {"method": method, "params": params or {}}
        if session:
            command["sessionId"] = session
        started = command_metrics.clock()
        try:
            response = await self.link.execute_command(command, timeout=timeout)
        except cdp.CommandFailed as error:
            raise failure(method, error) from None
        except cdp.CommandTimeout:
            if mutation or is_mutation(method):
                raise OutcomeUnknown(f"`{method}`", f"Ardia didn't answer {method} in {timeout:g}s after it was sent") from None
            raise CdpTimeout(method, timeout) from None
        except cdp.ConnectionLost:
            raise ConnectionLost() from None
        command_metrics.cdp_call(started)
        return response.get("result") or {}

    async def close(self):
        self.closed_by_us = True
        if self.link is not None:
            try:
                await asyncio.wait_for(self.link.close(), 3)
            except Exception:
                pass
