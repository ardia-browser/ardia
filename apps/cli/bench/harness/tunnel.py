import copy
import http.client
import re
import shutil
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import registry
from procs import kill_group, proc_info, read_json, same_process, sh, terminate, wait_until, write_json

CLOUDFLARED = shutil.which("cloudflared") or "/opt/homebrew/bin/cloudflared"
PUBLIC_URL = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")

REWRITTEN_TYPES = registry.benchhttp.REWRITTEN_TYPES
DROPPED_REQUEST_HEADERS = {"host", "connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade",
                           "accept-encoding", "content-length", "transfer-encoding"}
DROPPED_RESPONSE_HEADERS = {"connection", "keep-alive", "transfer-encoding", "content-length", "date", "server"}
DOH = "https://1.1.1.1/dns-query"
PROVISION_ATTEMPTS = 8
PROVISION_BACKOFF_S = (30, 60, 120, 240, 480, 600, 600)
POOL = {}
POOL_LOCK = threading.Lock()


def state_path(lane):
    return registry.STATE_DIR / f"tunnels-{lane}.json"


class Mapping:
    def __init__(self, hosts):
        self.hosts = dict(hosts)
        ports = "|".join(str(p) for p in sorted(self.hosts, reverse=True))
        self.local = re.compile(rf"(https?://)?(?<![\w.-])(?:127\.0\.0\.1|localhost):({ports})(?!\d)")
        self.local_bytes = re.compile(self.local.pattern.encode())
        names = "|".join(re.escape(h) for h in self.hosts.values())
        self.public_re = re.compile(rf"https://({names})")
        self.port_of = {h: p for p, h in self.hosts.items()}

    def public(self, value):
        if isinstance(value, bytes):
            return self.local_bytes.sub(
                lambda m: (b"https://" if m.group(1) else b"") + self.hosts[int(m.group(2))].encode(), value)
        return self.local.sub(lambda m: ("https://" if m.group(1) else "") + self.hosts[int(m.group(2))], value)

    def private(self, value):
        return self.public_re.sub(lambda m: f"http://127.0.0.1:{self.port_of[m.group(1)]}", value)


MARKER = "X-Bench-Tunnel"


def reply(handler, code, text):
    data = text.encode()
    handler.send_response(code)
    handler.send_header(MARKER, "1")
    handler.send_header("Content-Type", "text/plain")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def proxy_handler(slot):
    class Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            pass

        def forward(self):
            port, exposure = slot.target, slot.exposure
            n = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(n) if n > 0 else None
            if port is None or exposure is None:
                return reply(self, 503, "bench tunnel: no task behind this tunnel right now")
            mapping = exposure.mapping
            headers = {k: (mapping.private(v) if mapping and k.lower() in ("origin", "referer") else v)
                       for k, v in self.headers.items() if k.lower() not in DROPPED_REQUEST_HEADERS}
            headers["Host"] = f"127.0.0.1:{port}"
            if body is not None:
                headers["Content-Length"] = str(len(body))
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
            try:
                conn.request(self.command, self.path, body=body, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
                ctype = resp.getheader("Content-Type") or ""
                if mapping and ctype.startswith(REWRITTEN_TYPES):
                    data = mapping.public(data)
                self.send_response(resp.status, resp.reason)
                for k, v in resp.getheaders():
                    if k.lower() not in DROPPED_RESPONSE_HEADERS:
                        self.send_header(k, mapping.public(v) if mapping else v)
                self.send_header("Content-Length", str(len(data)))
                self.send_header(MARKER, "1")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(data)
                exposure.requests += 1
            except Exception as e:
                exposure.errors.append(f"{self.command} {self.path}: {type(e).__name__}: {e}"[:300])
                reply(self, 502, "bench tunnel proxy: upstream failed")
            finally:
                conn.close()

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = forward

    return Proxy


def reachable(url):
    r = sh(["curl", "-s", "-D", "-", "-o", "/dev/null", "-m", "8", "--doh-url", DOH, url + "/"], timeout=15)
    return MARKER.lower() in r.stdout.lower()


class Slot:
    def __init__(self, lane, index, log_dir):
        self.lane, self.index, self.log_dir = lane, index, Path(log_dir)
        self.target = None
        self.exposure = None
        self.proc = None
        self.url = None
        self.provision_attempts = 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), proxy_handler(self))
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def log(self):
        return self.log_dir / f"cloudflared-{self.lane}-{self.index}.log"

    def registered(self):
        text = self.log.read_text(errors="replace")
        m = PUBLIC_URL.search(text)
        return m.group(0) if m and "Registered tunnel connection" in text else None

    def alive(self):
        return self.proc is not None and self.proc.poll() is None and self.url is not None

    def provision(self):
        self.close_tunnel()
        self.log_dir.mkdir(parents=True, exist_ok=True)
        last = None
        for attempt in range(PROVISION_ATTEMPTS):
            self.provision_attempts += 1
            with open(self.log, "wb") as lf:
                self.proc = subprocess.Popen([CLOUDFLARED, "tunnel", "--no-autoupdate", "--url",
                                              f"http://127.0.0.1:{self.server.server_port}"],
                                             stdin=subprocess.DEVNULL, stdout=lf, stderr=lf, start_new_session=True)
            save_state(self.lane)
            try:
                self.url = wait_until(self.registered, 60, f"cloudflared tunnel {self.lane}/{self.index}",
                                      pid=self.proc.pid)
                wait_until(lambda: reachable(self.url), 60, f"{self.url} through the tunnel", pid=self.proc.pid,
                           step=1.0)
                save_state(self.lane)
                return self.url
            except RuntimeError as e:
                last = e
                self.close_tunnel()
                time.sleep(PROVISION_BACKOFF_S[min(attempt, len(PROVISION_BACKOFF_S) - 1)])
        raise RuntimeError(f"cloudflared tunnel {self.lane}/{self.index}: {last}")

    def ensure(self):
        if not self.alive() or not reachable(self.url):
            self.provision()
        return self.url

    def close_tunnel(self):
        if self.proc is not None:
            kill_group(self.proc, grace=5)
        self.proc, self.url = None, None

    def close(self):
        self.close_tunnel()
        self.server.shutdown()
        self.server.server_close()


def save_state(lane):
    tunnels = []
    for (slot_lane, _), slot in sorted(POOL.items()):
        if slot_lane != lane or slot.proc is None:
            continue
        info = proc_info(slot.proc.pid) or {}
        tunnels.append({"pid": slot.proc.pid, "lstart": info.get("lstart"), "command": info.get("command"),
                        "url": slot.url, "index": slot.index})
    write_json(state_path(lane), {"tunnels": tunnels})


def slot_for(lane, index, log_dir):
    with POOL_LOCK:
        slot = POOL.get((lane, index))
        if slot is None:
            slot = POOL[(lane, index)] = Slot(lane, index, log_dir)
        return slot


class Exposure:
    def __init__(self, task, lane, log_dir):
        self.task, self.lane, self.log_dir = task, lane, Path(log_dir).parent / f"tunnels-{lane}"
        self.ports = list(task["server"]["ports"])
        self.mapping = None
        self.slots = []
        self.requests = 0
        self.errors = []
        self.setup_s = None

    def start(self):
        t0 = time.monotonic()
        try:
            hosts = {}
            for i, port in enumerate(self.ports):
                slot = slot_for(self.lane, i, self.log_dir)
                slot.target, slot.exposure = None, None
                hosts[port] = slot.ensure().removeprefix("https://")
                self.slots.append(slot)
            self.mapping = Mapping(hosts)
            for slot, port in zip(self.slots, self.ports):
                slot.target, slot.exposure = port, self
            self.setup_s = round(time.monotonic() - t0, 2)
            return self
        except BaseException:
            self.stop()
            raise

    def public_task(self):
        out = copy.deepcopy(self.task)
        out["start_url"] = self.mapping.public(self.task["start_url"])
        out["extra_urls"] = [self.mapping.public(u) for u in self.task.get("extra_urls", [])]
        out["prompt"] = self.mapping.public(self.task["prompt"])
        out["public_hosts"] = {str(p): h for p, h in self.mapping.hosts.items()}
        return out

    def summary(self):
        return {"hosts": {str(p): h for p, h in (self.mapping.hosts.items() if self.mapping else [])},
                "setup_s": self.setup_s, "requests": self.requests, "proxy_errors": self.errors[:20],
                "tunnel_provisions": {str(s.index): s.provision_attempts for s in self.slots}}

    def stop(self):
        for slot in self.slots:
            if slot.exposure is self:
                slot.target, slot.exposure = None, None
        self.slots = []


def stop_all():
    stopped = []
    with POOL_LOCK:
        for slot in POOL.values():
            if slot.proc is not None:
                stopped.append(f"cloudflared {slot.proc.pid}")
            slot.close()
        lanes = {lane for lane, _ in POOL}
        POOL.clear()
    for lane in lanes:
        state_path(lane).unlink(missing_ok=True)
    for p in sorted(registry.STATE_DIR.glob("tunnels-*.json")):
        for t in (read_json(p) or {}).get("tunnels", []):
            if t.get("lstart") and same_process(t) and terminate(t, grace=5):
                stopped.append(f"cloudflared {t['pid']}")
        p.unlink(missing_ok=True)
    return stopped
