import asyncio
import itertools
import json
import logging

from ardia_cli import guard

log = logging.getLogger("ardia_cli.cdp")


class CdpError(Exception):
    pass


class ConnectionLost(Exception):
    pass


class CommandTimeout(CdpError):
    def __init__(self, method: str, timeout: float):
        super().__init__(f"{method} got no answer in {timeout:g}s")
        self.method = method
        self.timeout = timeout


class CommandFailed(CdpError):
    def __init__(self, method: str, error: dict):
        self.method = method
        self.code = error.get("code", 0) if isinstance(error, dict) else 0
        self.detail = (error.get("message") if isinstance(error, dict) else None) or ""
        super().__init__(self.detail or f"{method} failed")


def _settle(future: asyncio.Future) -> None:
    if not future.done():
        future.cancel()
    elif not future.cancelled():
        future.exception()


class Connection:
    def __init__(self, url: str, max_size: int | None = None):
        self.url = url
        self.max_size = max_size
        self.socket = None
        self.ids = itertools.count(1)
        self.pending: dict[int, asyncio.Future] = {}
        self.handlers: dict[str, list] = {}
        self.listeners: list = []
        self.reader: asyncio.Task | None = None
        self.lost = asyncio.Event()

    async def open(self, timeout: float | None = None):
        if self.socket is not None or self.lost.is_set():
            raise ConnectionLost()
        self.socket = await asyncio.wait_for(guard.direct_connect(self.url, max_size=self.max_size), timeout)
        self.reader = asyncio.ensure_future(self._read())

    def on(self, method: str, callback) -> None:
        self.handlers.setdefault(method, []).append(callback)

    async def _read(self):
        try:
            async for raw in self.socket:
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                ident = message.get("id")
                if isinstance(ident, int):
                    future = self.pending.pop(ident, None)
                    if future is not None and not future.done():
                        future.set_result(message)
                elif isinstance(message.get("method"), str):
                    self._dispatch(message)
        except Exception:
            log.debug("CDP reader stopped", exc_info=True)
        finally:
            self.lost.set()
            pending = list(self.pending.values())
            self.pending.clear()
            for future in pending:
                if not future.done():
                    future.set_exception(ConnectionLost())

    def _dispatch(self, message: dict) -> None:
        method = message["method"]
        params = message.get("params") or {}
        session = message.get("sessionId")
        for callback in (*self.handlers.get(method, ()), *self.listeners):
            try:
                callback(method, params, session)
            except (Exception, asyncio.CancelledError):
                log.exception("CDP event handler failed")

    def _usable(self) -> None:
        if self.socket is None or self.lost.is_set():
            raise ConnectionLost()

    async def execute_command(self, command: dict, timeout: float = 60) -> dict:
        from ardia_cli import wsclient

        guard.check_command(command)
        self._usable()
        method = command.get("method")
        ident = next(self.ids)
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        try:
            await asyncio.wait_for(self.socket.send(json.dumps({**command, "id": ident})), timeout)
            reply = await asyncio.wait_for(future, max(0.0, deadline - loop.time()))
        except asyncio.TimeoutError:
            raise CommandTimeout(method, timeout) from None
        except wsclient.Closed:
            raise ConnectionLost() from None
        finally:
            self.pending.pop(ident, None)
            _settle(future)
        if "error" in reply:
            raise CommandFailed(method, reply["error"])
        return reply

    async def execute_command_nowait(self, command: dict) -> None:
        from ardia_cli import wsclient

        guard.check_command(command)
        self._usable()
        try:
            await self.socket.send(json.dumps({**command, "id": next(self.ids)}))
        except wsclient.Closed:
            raise ConnectionLost() from None

    async def close(self):
        if self.socket is not None:
            try:
                await asyncio.wait_for(self.socket.close(), 3)
            except Exception:
                pass
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        self.lost.set()


class Cdp(Connection):
    def __init__(self, url: str):
        super().__init__(url)
        self.closed = self.lost

    async def send(self, method: str, params: dict | None = None, session: str | None = None, timeout: float = 15):
        command = {"method": method, "params": params or {}}
        if session:
            command["sessionId"] = session
        try:
            reply = await self.execute_command(command, timeout)
        except (CdpError, ConnectionLost):
            raise
        except Exception as error:
            if self.closed.is_set():
                raise ConnectionLost() from None
            raise CdpError(f"{method}: {error}") from None
        return reply.get("result") or {}
