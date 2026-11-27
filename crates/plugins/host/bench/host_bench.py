#!/usr/bin/env python3
"""Measure a plugin host with the sdk-bench fixture over fd 3.

usage: host_bench.py <runs> <host command...>

Each run spawns the host, answers hello, and records: cold start to the hello
request, start to ready, the cap-sized tree commit (mount to surface.render),
the 1,000-row list mount, twenty 1,000-row updates (event to surface.render),
plugin.stopping to deactivate's storage.set, and the host's peak RSS. Prints
one JSON object with medians and p90s.
"""
import json
import os
import socket
import statistics
import subprocess
import sys
import time

FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "sdk-bench")
UPDATES = 20


class Host:
    def __init__(self, command):
        self.parent, child = socket.socketpair()
        env = {"ARDIA_PLUGIN_FD": str(child.fileno()), "PATH": "/usr/bin:/bin"}
        self.started = time.perf_counter()
        self.process = subprocess.Popen(command + ["--entry", "dist/index.js"], cwd=FIXTURE, pass_fds=[child.fileno()], env=env, stderr=subprocess.DEVNULL)
        child.close()
        self.parent.settimeout(10)
        self.buffer = b""
        self.sizes = {}

    def message(self):
        while b"\n" not in self.buffer:
            chunk = self.parent.recv(1 << 20)
            if not chunk:
                raise RuntimeError("the host closed the channel")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        self.received = time.perf_counter()
        return json.loads(line), len(line)

    def send(self, message):
        self.parent.sendall(json.dumps(message).encode() + b"\n")

    def until(self, method, surface=None):
        while True:
            message, size = self.message()
            if "id" in message and "method" in message:
                result = None
                if message["method"] == "hello":
                    result = {"app": "Ardia", "version": "bench", "protocol": 2, "plugin": "sdk-bench", "values": {}}
                self.send({"id": message["id"], "result": result})
                if message["method"] == method and (surface is None or message["params"].get("surfaceId") == surface):
                    self.sizes[method] = size
                    return message


def find_handler(value):
    if isinstance(value, dict):
        if len(value) == 1 and isinstance(value.get("__handler"), str):
            return value["__handler"]
        for inner in value.values():
            found = find_handler(inner)
            if found:
                return found
    if isinstance(value, list):
        for inner in value:
            found = find_handler(inner)
            if found:
                return found
    return None


def one_run(command):
    host = Host(command)
    out = {}
    host.until("hello")
    out["cold_start_ms"] = (host.received - host.started) * 1000
    host.until("ready")
    out["ready_ms"] = (host.received - host.started) * 1000
    started = time.perf_counter()
    host.send({"surface": "mount", "surfaceId": "cap", "viewId": "cap", "kind": "sidebar"})
    host.until("surface.render", "cap")
    out["cap_commit_ms"] = (host.received - started) * 1000
    out["cap_bytes"] = host.sizes["surface.render"]
    started = time.perf_counter()
    host.send({"surface": "mount", "surfaceId": "rows", "viewId": "rows", "kind": "sidebar"})
    rows = host.until("surface.render", "rows")
    out["rows_mount_ms"] = (host.received - started) * 1000
    handler = find_handler(rows["params"]["tree"])
    updates = []
    for _ in range(UPDATES):
        started = time.perf_counter()
        host.send({"surface": "event", "surfaceId": "rows", "handlerId": handler, "args": []})
        host.until("surface.render", "rows")
        updates.append((host.received - started) * 1000)
    out["rows_update_ms"] = statistics.median(updates)
    started = time.perf_counter()
    host.send({"event": "plugin.stopping", "time": 0, "data": {}})
    while True:
        message = host.until("storage.set")
        if message["params"].get("key") == "deactivated":
            break
    out["stop_to_deactivate_ms"] = (host.received - started) * 1000
    host.parent.close()
    _, status, usage = os.wait4(host.process.pid, 0)
    out["peak_rss_mb"] = usage.ru_maxrss / (1 << 20) if sys.platform == "darwin" else usage.ru_maxrss / 1024
    out["exit"] = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status
    return out


def summary(runs):
    keys = [k for k in runs[0] if k != "exit"]
    result = {"runs": len(runs), "exits": sorted({r["exit"] for r in runs})}
    for key in keys:
        values = sorted(r[key] for r in runs)
        result[key] = {"median": round(statistics.median(values), 2), "p90": round(values[min(len(values) - 1, int(len(values) * 0.9))], 2), "min": round(values[0], 2)}
    return result


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    count, command = int(sys.argv[1]), sys.argv[2:]
    runs = [one_run(command) for _ in range(count)]
    print(json.dumps(summary(runs), indent=1))


main()
