import json
import os
import socket
import sys
import threading

channel = socket.socket(fileno=int(os.environ["ARDIA_PLUGIN_FD"]))
reader = channel.makefile("r", encoding="utf-8")
lock = threading.Lock()
values = {}
seen = []
waiting = {}
next_id = [0]


def send(message):
    with lock:
        channel.sendall((json.dumps(message) + "\n").encode())


def request(method, params=None):
    next_id[0] += 1
    rid = next_id[0]
    done = threading.Event()
    waiting[rid] = {"done": done}
    send({"id": rid, "method": method, "params": params or {}})
    done.wait(10)
    return waiting.pop(rid, {}).get("reply")


def greeting():
    text = values.get("greeting", "Hello")
    return text.upper() if values.get("loud") else text


def attempt(action):
    try:
        action()
        return "allowed"
    except OSError as error:
        return "refused: " + (error.strerror or str(error))


def probe(asked):
    report = {}
    for path in asked.get("read", []):
        report["read " + path] = attempt(lambda: open(path, "rb").close())
    for path in asked.get("write", []):
        report["write " + path] = attempt(lambda: open(path, "ab").close())
    for path in asked.get("unix", []):
        report["unix " + path] = attempt(lambda: socket.socket(socket.AF_UNIX).connect(path))
    for host, port in asked.get("tcp", []):
        report["tcp %s:%s" % (host, port)] = attempt(lambda: socket.create_connection((host, port), 3).close())
    return report


def answer(call):
    tool = call.get("tool")
    try:
        if tool == "hello":
            result = {"message": greeting(), "mood": values.get("mood")}
        elif tool == "new-tab":
            result = request("run", {"command": "newTab"})
        elif tool == "seen":
            result = {"events": seen[-20:]}
        elif tool == "probe":
            result = probe(call.get("input") or {})
        elif tool == "ask":
            target = call.get("input") or {}
            result = request("tools.call", {"plugin": target.get("plugin", "example"), "tool": target.get("tool", "hello")})
        else:
            raise ValueError("unknown tool " + str(tool))
        send({"id": "r-" + call["call"], "method": "result", "params": {"call": call["call"], "result": result}})
    except Exception as error:
        send({"id": "r-" + call["call"], "method": "result", "params": {"call": call["call"], "error": str(error)}})


def start():
    hello = request("hello")
    values.update(((hello or {}).get("result") or {}).get("values") or {})
    request("subscribe", {"events": ["*"]})
    sys.stderr.write("example helper ready\n")
    sys.stderr.flush()


threading.Thread(target=start, daemon=True).start()
for line in reader:
    message = json.loads(line)
    if "call" in message and "tool" in message:
        threading.Thread(target=answer, args=(message,), daemon=True).start()
    elif "pageMessage" in message:
        sys.stderr.write("page shows: " + json.dumps(message["pageMessage"].get("shown")) + "\n")
        sys.stderr.flush()
        send({"id": "post", "method": "page.post", "params": {"view": message["view"], "message": {"reply": "seen " + str(message["pageMessage"].get("shown"))}}})
    elif "event" in message:
        if message["event"] == "plugin.values":
            values.update(message["data"]["values"])
        else:
            seen.append({"event": message["event"], "tabId": message.get("data", {}).get("tabId")})
    elif (pending := waiting.get(message.get("id"))) is not None:
        pending["reply"] = message
        pending["done"].set()
sys.exit(0)
