import asyncio
import base64
import hashlib
import os
import struct
from urllib.parse import urlsplit

from ardia_cli import guard

ACCEPT_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CONTINUATION, TEXT, BINARY, CLOSE, PING, PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA
CONTROL = frozenset({CLOSE, PING, PONG})
READ_BUFFER = 4 * 1024 * 1024
CLOSE_WAIT = 2.0
SEND_DRAIN_LIMIT = 30.0


class HandshakeError(ConnectionError):
    pass


class Closed(ConnectionError):
    def __init__(self, code: int | None = None, reason: str = ""):
        super().__init__(f"WebSocket closed ({code}{': ' + reason if reason else ''})" if code else "WebSocket closed")
        self.code = code
        self.reason = reason


def mask(payload: bytes, key: bytes) -> bytes:
    if not payload:
        return payload
    size = len(payload)
    stream = (key * (size // 4 + 1))[:size]
    return (int.from_bytes(payload, "little") ^ int.from_bytes(stream, "little")).to_bytes(size, "little")


def frame(opcode: int, payload: bytes) -> bytes:
    size = len(payload)
    if size < 126:
        header = struct.pack("!BB", 0x80 | opcode, 0x80 | size)
    elif size < 1 << 16:
        header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, size)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, size)
    key = os.urandom(4)
    return header + key + mask(payload, key)


def accept_key(key: bytes) -> str:
    return base64.b64encode(hashlib.sha1(key + ACCEPT_GUID).digest()).decode()


class Socket:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, max_size: int | None):
        self.reader = reader
        self.writer = writer
        self.max_size = max_size
        self.drain_lock = asyncio.Lock()
        self.close_sent = False
        self.closed: Closed | None = None

    def _write(self, opcode: int, payload: bytes) -> None:
        self.writer.write(frame(opcode, payload))

    async def _drain(self) -> None:
        async with self.drain_lock:
            await self.writer.drain()

    async def _send_close(self, payload: bytes) -> None:
        if self.close_sent:
            return
        self.close_sent = True
        try:
            self._write(CLOSE, payload)
            await asyncio.wait_for(self._drain(), CLOSE_WAIT)
        except (ConnectionError, OSError, asyncio.TimeoutError):
            pass

    async def send(self, message) -> None:
        if not isinstance(message, (str, bytes, bytearray, memoryview)):
            raise guard.ForbiddenCommand("ardia only sends whole messages, not fragments")
        guard.check_message(message)
        if self.closed is not None or self.close_sent:
            raise self.closed or Closed()
        if isinstance(message, str):
            opcode, payload = TEXT, message.encode()
        else:
            opcode, payload = BINARY, bytes(message)
        try:
            self._write(opcode, payload)
            await asyncio.wait_for(self._drain(), SEND_DRAIN_LIMIT)
        except asyncio.TimeoutError:
            raise self._lost(TimeoutError(f"the browser read nothing for {SEND_DRAIN_LIMIT:g}s")) from None
        except (ConnectionError, OSError) as error:
            raise self._lost(error) from None

    def _lost(self, error: BaseException | None = None) -> Closed:
        if self.closed is None:
            self.closed = Closed(1006, str(error) if error else "")
            self.writer.transport.abort()
        return self.closed

    async def recv(self):
        if self.closed is not None:
            raise self.closed
        try:
            return await self._message()
        except Closed:
            raise
        except (asyncio.IncompleteReadError, ConnectionError, OSError) as error:
            raise self._lost(error) from None

    async def _message(self):
        parts: list[bytes] = []
        size = 0
        kind = None
        while True:
            first, second = await self.reader.readexactly(2)
            fin, opcode, length = first & 0x80, first & 0x0F, second & 0x7F
            if first & 0x70 or second & 0x80:
                await self._fail(1002, "reserved bits or a masked server frame")
            if length == 126:
                (length,) = struct.unpack("!H", await self.reader.readexactly(2))
            elif length == 127:
                (length,) = struct.unpack("!Q", await self.reader.readexactly(8))
            if opcode in CONTROL:
                if not fin or length > 125:
                    await self._fail(1002, "a fragmented or oversized control frame")
                await self._control(opcode, await self.reader.readexactly(length))
                continue
            if opcode == CONTINUATION:
                if kind is None:
                    await self._fail(1002, "a continuation with nothing to continue")
            elif opcode in (TEXT, BINARY):
                if kind is not None:
                    await self._fail(1002, "a new message inside a fragmented one")
                kind = opcode
            else:
                await self._fail(1002, f"unknown opcode {opcode}")
            size += length
            if self.max_size is not None and size > self.max_size:
                await self._fail(1009, f"a message over {self.max_size} bytes")
            parts.append(await self.reader.readexactly(length))
            if fin:
                payload = b"".join(parts)
                if kind == BINARY:
                    return payload
                try:
                    return payload.decode()
                except UnicodeDecodeError:
                    await self._fail(1007, "text that isn't UTF-8")

    async def _control(self, opcode: int, payload: bytes) -> None:
        if opcode == PING:
            if not self.close_sent:
                self._write(PONG, payload)
            return
        if opcode == PONG:
            return
        code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
        reason = payload[2:].decode(errors="replace")
        await self._send_close(payload[:2])
        self.closed = Closed(code, reason)
        self.writer.close()
        raise self.closed

    async def _fail(self, code: int, reason: str):
        await self._send_close(struct.pack("!H", code) + reason.encode()[:120])
        self.closed = Closed(code, reason)
        self.writer.transport.abort()
        raise self.closed

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return await self.recv()
        except Closed:
            raise StopAsyncIteration from None

    async def close(self, code: int = 1000) -> None:
        if self.closed is None:
            await self._send_close(struct.pack("!H", code))
        if self.closed is None:
            self.closed = Closed(code)
        self.writer.close()
        try:
            await asyncio.wait_for(self.writer.wait_closed(), CLOSE_WAIT)
        except (ConnectionError, OSError, asyncio.TimeoutError):
            self.writer.transport.abort()


async def connect(url: str, max_size: int | None = None) -> Socket:
    parts = urlsplit(url)
    if parts.scheme not in ("ws", "wss") or not parts.hostname:
        raise HandshakeError(f"not a ws:// URL: {parts.scheme}://")
    secure = parts.scheme == "wss"
    port = parts.port or (443 if secure else 80)
    context = None
    if secure:
        import ssl

        context = ssl.create_default_context()
    reader, writer = await asyncio.open_connection(parts.hostname, port, ssl=context, limit=READ_BUFFER)
    try:
        key = base64.b64encode(os.urandom(16))
        host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
        if parts.port:
            host = f"{host}:{parts.port}"
        target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        writer.write((f"GET {target} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key.decode()}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        await writer.drain()
        try:
            head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError) as error:
            raise HandshakeError("the server closed the connection during the WebSocket handshake") from error
        lines = head.decode("latin-1").split("\r\n")
        status = lines[0].split(" ", 2)
        if len(status) < 2 or status[1] != "101":
            raise HandshakeError(f"server rejected WebSocket connection: HTTP {status[1] if len(status) > 1 else '?'}")
        headers = {}
        for line in lines[1:]:
            name, _, value = line.partition(":")
            if name:
                headers[name.strip().lower()] = value.strip()
        if headers.get("upgrade", "").lower() != "websocket" or headers.get("sec-websocket-accept") != accept_key(key):
            raise HandshakeError("the server's WebSocket handshake answer doesn't match")
    except BaseException:
        writer.transport.abort()
        raise
    return Socket(reader, writer, max_size)
