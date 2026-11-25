#!/usr/bin/env python3
"""Run conformance.js in a plugin host over fd 3 and print the report as JSON.

usage: record.py <folder holding conformance.js> <host command...>
"""
import json
import os
import socket
import subprocess
import sys
import time


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    folder, command = sys.argv[1], sys.argv[2:]
    parent, child = socket.socketpair()
    env = {"ARDIA_PLUGIN_FD": str(child.fileno()), "PATH": "/usr/bin:/bin"}
    process = subprocess.Popen(command + ["--entry", "conformance.js"], cwd=folder, pass_fds=[child.fileno()], env=env, stderr=subprocess.PIPE)
    child.close()
    parent.settimeout(0.5)
    data = b""
    deadline = time.time() + 10
    report = None
    while time.time() < deadline and report is None:
        try:
            chunk = parent.recv(1 << 20)
        except socket.timeout:
            continue
        if not chunk:
            break
        data += chunk
        while b"\n" in data:
            line, data = data.split(b"\n", 1)
            message = json.loads(line)
            if "conformance" in message:
                report = message["conformance"]
    parent.close()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    if report is None:
        sys.stderr.write(process.stderr.read().decode(errors="replace"))
        sys.exit("the host sent no conformance report")
    json.dump(report, sys.stdout, ensure_ascii=True, indent=1, sort_keys=True)
    sys.stdout.write("\n")


main()
