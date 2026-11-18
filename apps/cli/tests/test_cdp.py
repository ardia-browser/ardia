import asyncio
import json
import logging
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli import cdp, guard, wsclient

logging.getLogger("websockets").setLevel(logging.CRITICAL)


class Peer:
    def __init__(self, handler):
        self.handler = handler
        self.received = []
        self.server = None

    async def __aenter__(self):
        from websockets.asyncio.server import serve

        async def serve_one(ws):
            await self.handler(self, ws)

        self.server = await serve(serve_one, "127.0.0.1", 0, max_size=None, compression=None)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}/devtools/browser/x?token=t"
        return self

    async def __aexit__(self, *exc):
        self.server.close()
        await self.server.wait_closed()


async def echo_results(peer, ws):
    async for raw in ws:
        message = json.loads(raw)
        peer.received.append(message)
        method = message["method"]
        if method == "Test.fragmented":
            reply = json.dumps({"id": message["id"], "result": {"value": "x" * 5000}})
            await ws.send([reply[:10], reply[10:3000], reply[3000:]])
        elif method == "Test.large":
            await ws.send(json.dumps({"id": message["id"], "result": {"value": "y" * (9 << 20)}}))
        elif method == "Test.ping":
            await asyncio.wait_for(await ws.ping(b"hi"), 3)
            await ws.send(json.dumps({"id": message["id"], "result": {"ponged": True}}))
        elif method == "Test.error":
            await ws.send(json.dumps({"id": message["id"], "error": {"code": -32000, "message": "nope"}}))
        elif method == "Test.event":
            await ws.send(json.dumps({"method": "Page.loadEventFired", "params": {"n": 1}, "sessionId": "S"}))
            await ws.send(json.dumps({"id": message["id"], "result": {}}))
        elif method == "Test.silent":
            continue
        elif method == "Test.hangup":
            await ws.close(1001, "going away")
            return
        else:
            await ws.send(json.dumps({"id": message["id"], "result": {"echo": message.get("params")}}))


def run(coroutine):
    return asyncio.run(asyncio.wait_for(coroutine, 30))


async def deaf_peer():
    import base64
    import hashlib

    async def handle(reader, writer):
        request = await reader.readuntil(b"\r\n\r\n")
        key = next(line.split(b":", 1)[1].strip() for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key"))
        accept = base64.b64encode(hashlib.sha1(key + wsclient.ACCEPT_GUID).digest())
        writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
        await writer.drain()
        await asyncio.sleep(60)

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/devtools/browser/x"


class ConnectionTest(unittest.TestCase):
    def test_a_peer_that_stops_reading_times_commands_out_instead_of_hanging(self):
        async def scenario():
            server, url = await deaf_peer()
            connection = cdp.Connection(url)
            await connection.open(5)
            filler = "z" * (8 << 20)
            started = asyncio.get_running_loop().time()
            with self.assertRaises(cdp.CommandTimeout):
                await connection.execute_command({"method": "Test.echo", "params": {"fill": filler}}, timeout=0.5)
            with self.assertRaises(cdp.CommandTimeout):
                await connection.execute_command({"method": "Test.echo"}, timeout=0.3)
            self.assertLess(asyncio.get_running_loop().time() - started, 3)
            connection.socket.writer.transport.abort()
            server.close()

        run(scenario())

    def test_commands_events_frames_and_errors(self):
        async def scenario():
            async with Peer(echo_results) as peer:
                connection = cdp.Connection(peer.url, max_size=64 << 20)
                await connection.open(5)
                events = []
                connection.on("Page.loadEventFired", lambda method, params, session: events.append((method, params, session)))
                echoed, fragmented, large, ponged, _ = await asyncio.gather(
                    connection.execute_command({"method": "Test.echo", "params": {"a": "é" * 70000}}),
                    connection.execute_command({"method": "Test.fragmented"}),
                    connection.execute_command({"method": "Test.large"}),
                    connection.execute_command({"method": "Test.ping"}),
                    connection.execute_command({"method": "Test.event"}),
                )
                with self.assertRaises(cdp.CommandFailed) as failed:
                    await connection.execute_command({"method": "Test.error"})
                with self.assertRaises(cdp.CommandTimeout):
                    await connection.execute_command({"method": "Test.silent"}, timeout=0.2)
                after_timeout = await connection.execute_command({"method": "Test.echo", "params": {"b": 1}})
                await connection.close()
                return echoed, fragmented, large, ponged, events, failed.exception, after_timeout, connection

        echoed, fragmented, large, ponged, events, failed, after_timeout, connection = run(scenario())
        self.assertEqual(echoed["result"]["echo"], {"a": "é" * 70000})
        self.assertEqual(len(fragmented["result"]["value"]), 5000)
        self.assertEqual(len(large["result"]["value"]), 9 << 20)
        self.assertTrue(ponged["result"]["ponged"])
        self.assertEqual(events, [("Page.loadEventFired", {"n": 1}, "S")])
        self.assertEqual((failed.method, failed.code, failed.detail), ("Test.error", -32000, "nope"))
        self.assertEqual(after_timeout["result"]["echo"], {"b": 1})
        self.assertTrue(connection.lost.is_set())
        self.assertEqual(connection.pending, {})

    def test_peer_closing_fails_pending_commands_and_sets_lost(self):
        async def scenario():
            async with Peer(echo_results) as peer:
                connection = cdp.Connection(peer.url)
                await connection.open(5)
                waiting = asyncio.ensure_future(connection.execute_command({"method": "Test.silent"}, timeout=10))
                await asyncio.sleep(0.05)
                with self.assertRaises(cdp.ConnectionLost):
                    await connection.execute_command({"method": "Test.hangup"}, timeout=10)
                with self.assertRaises(cdp.ConnectionLost):
                    await waiting
                await asyncio.wait_for(connection.lost.wait(), 3)
                with self.assertRaises(cdp.ConnectionLost):
                    await connection.execute_command({"method": "Test.echo"})
                with self.assertRaises(cdp.ConnectionLost):
                    await connection.open(1)
                await connection.close()

        run(scenario())

    def test_message_over_max_size_ends_the_connection(self):
        async def scenario():
            async with Peer(echo_results) as peer:
                connection = cdp.Connection(peer.url, max_size=1 << 20)
                await connection.open(5)
                with self.assertRaises(cdp.ConnectionLost):
                    await connection.execute_command({"method": "Test.large"}, timeout=10)
                self.assertTrue(connection.lost.is_set())
                await connection.close()

        run(scenario())

    def test_forbidden_commands_never_reach_the_wire(self):
        async def scenario():
            async with Peer(echo_results) as peer:
                connection = cdp.Connection(peer.url)
                await connection.open(5)
                for method in sorted(guard.FORBIDDEN_METHODS):
                    with self.assertRaises(guard.ForbiddenCommand):
                        await connection.execute_command({"method": method})
                    with self.assertRaises(guard.ForbiddenCommand):
                        await connection.execute_command_nowait({"method": method})
                    with self.assertRaises(guard.ForbiddenCommand):
                        await connection.socket.send(json.dumps({"id": 1, "method": method}))
                    with self.assertRaises(guard.ForbiddenCommand):
                        await connection.socket.send(json.dumps([{"id": 1, "method": "Page.enable"}, {"id": 2, "method": method}]).encode())
                with self.assertRaises(guard.ForbiddenCommand):
                    await connection.socket.send("not json")
                with self.assertRaises(guard.ForbiddenCommand):
                    await connection.socket.send(iter(["{}"]))
                await connection.execute_command({"method": "Test.echo"})
                await connection.close()
                return peer.received

        received = run(scenario())
        self.assertEqual([message["method"] for message in received], ["Test.echo"])

    def test_handshake_refusal_is_a_clear_error(self):
        async def refuse(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()

        async def scenario():
            server = await asyncio.start_server(refuse, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            try:
                with self.assertRaises(wsclient.HandshakeError) as refused:
                    await wsclient.connect(f"ws://127.0.0.1:{port}/devtools/browser/x")
            finally:
                server.close()
            return str(refused.exception)

        self.assertIn("403", run(scenario()))

    def test_masking_round_trips(self):
        key = b"\x01\x02\x03\x04"
        payload = bytes(range(256)) * 3 + b"tail"
        self.assertEqual(wsclient.mask(wsclient.mask(payload, key), key), payload)
        self.assertEqual(wsclient.mask(b"abcd", key), bytes(a ^ b for a, b in zip(b"abcd", key)))


if __name__ == "__main__":
    unittest.main()
