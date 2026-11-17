import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

import ardia_side
import opencode_side
import registry
from procs import http, kill_on_failure, listener_pids, proc_info, read_json, sh, terminate, wait_until, write_json

ARDIA_APP = str(Path.home() / "ardia-scratch/bench-proper/app-geom/Ardia.app")
CLOUD_API = "https://api.browser-use.com/api/v4"
CLOUD_KEY_FILE = Path(os.environ.get("BENCH_BU_KEY_FILE", Path.home() / "ardia-scratch/bu-bench/.bu_api_key"))
CLOUD_STATE_GLOB = "cloud-*.json"
CDP_TAB = Path(__file__).resolve().parent / "cdp_tab.mjs"


def chrome_binary(chrome=None):
    return Path(chrome).expanduser().resolve() if chrome else opencode_side.chrome_binary({})


def launch_chrome(chrome, home, cdp_port, logs, window_size="1440,900", extra_args=()):
    args = [str(chrome_binary(chrome)), "--headless=new", f"--user-data-dir={home / 'profile'}",
            f"--remote-debugging-port={cdp_port}", "--no-first-run", "--no-default-browser-check",
            "--use-mock-keychain", "--password-store=basic", f"--window-size={window_size}", *extra_args, "about:blank"]
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=logs, stderr=logs, start_new_session=True)
    version = kill_on_failure(proc, lambda: opencode_side.chrome_ready(proc, {"cdp_port": cdp_port}))
    return dict(opencode_side.record_of(proc), kind="chrome", browser=version.get("Browser"),
                user_agent=version.get("User-Agent"), args=args, cdp_port=cdp_port)


def launch_ardia(app, data, port, switches=(), ardia_test="cdpTabsVisible"):
    app = ardia_side.app_path({"app": app or ARDIA_APP})
    busy = listener_pids(port)
    if busy:
        raise SystemExit(f"port {port} is used by pid {busy}, not by this harness")
    if data.exists():
        shutil.rmtree(data)
    data.mkdir(parents=True)
    (data / "onboarding.json").write_text(json.dumps({"version": 1, "completedAt": 1}))
    log = data / "app.out.log"
    env_args = ["--env", "ARDIA_BACKGROUND=1", "--env", f"ARDIA_DATA_DIR={data}",
                "--env", f"ARDIA_REMOTE_DEBUGGING_PORT={port}"]
    if ardia_test:
        env_args += ["--env", f"ARDIA_TEST={ardia_test}"]
    if switches:
        env_args += ["--env", f"ARDIA_INSTANCE=chromiumSwitches={' '.join(switches)}"]
    t0 = time.monotonic()
    subprocess.run(["open", "-g", "-n", *env_args, "--stdout", str(log), "--stderr", str(log), str(app)],
                   check=True, timeout=30)
    exe = str(app / "Contents/MacOS/Ardia")

    def owned_listener():
        for pid in listener_pids(port):
            info = proc_info(pid)
            if info and info["command"].startswith(exe):
                return pid, info
        return None

    pid, info = wait_until(owned_listener, 90, "Ardia DevTools port")
    rec = {"pid": pid, "lstart": info["lstart"], "command": info["command"], "kind": "ardia", "app": str(app),
           "data": str(data), "cdp_port": port, "args": list(switches)}
    try:
        version = wait_until(lambda: http("GET", f"http://127.0.0.1:{port}/json/version"), 60,
                             "Ardia /json/version", pid=pid)
    except BaseException:
        terminate(rec, grace=10)
        raise
    rec.update(browser=version.get("Browser"), user_agent=version.get("User-Agent"),
               launch_s=round(time.monotonic() - t0, 2))
    return rec


def stop_browser(rec):
    if not rec:
        return False
    if rec.get("kind") == "cloud":
        return bool(cloud_stop(rec))
    return terminate(rec, grace=30 if rec.get("kind") == "ardia" else 10)


def cloud_key():
    return CLOUD_KEY_FILE.read_text().strip()


def cloud_request(method, path, body=None, timeout=60):
    req = urllib.request.Request(f"{CLOUD_API}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Browser-Use-API-Key": cloud_key(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def cloud_state_path(lane):
    return registry.STATE_DIR / f"cloud-{lane}.json"


def cloud_start(lane, minutes, country="us"):
    session = cloud_request("POST", "/browsers", {"proxyCountryCode": country, "timeout": int(minutes)})
    rec = {"kind": "cloud", "id": session["id"], "cdp_url": session.get("cdpUrl"), "lane": lane,
           "created_at": time.time()}
    write_json(cloud_state_path(lane), rec)
    t0 = time.monotonic()
    try:
        def ws_url():
            with urllib.request.urlopen(f"{rec['cdp_url']}/json/version", timeout=10) as r:
                return json.loads(r.read()).get("webSocketDebuggerUrl")

        rec["ws"] = wait_until(ws_url, 90, "cloud browser /json/version", step=1.0)
        with urllib.request.urlopen(f"{rec['cdp_url']}/json/version", timeout=10) as r:
            version = json.loads(r.read())
        rec.update(browser=version.get("Browser"), user_agent=version.get("User-Agent"),
                   launch_s=round(time.monotonic() - t0, 2))
        write_json(cloud_state_path(lane), rec)
        return rec
    except BaseException:
        cloud_stop(rec)
        raise


def cloud_stop(rec):
    if not rec or not rec.get("id"):
        return {}
    out = {"id": rec["id"]}
    try:
        cloud_request("PATCH", f"/browsers/{rec['id']}", {"action": "stop"})
        out["stopped"] = True
    except Exception as e:
        out["stop_error"] = str(e)[:300]
    try:
        final = cloud_request("GET", f"/browsers/{rec['id']}")
        out.update(status=final.get("status"), browser_cost=final.get("browserCost"),
                   proxy_cost=final.get("proxyCost"), proxy_mb=final.get("proxyUsedMb"))
    except Exception:
        pass
    path = cloud_state_path(rec.get("lane") or "")
    if (read_json(path) or {}).get("id") == rec["id"]:
        path.unlink(missing_ok=True)
    return out


def cloud_stop_all():
    stopped = []
    for p in sorted(registry.STATE_DIR.glob(CLOUD_STATE_GLOB)):
        rec = read_json(p)
        if rec and rec.get("id"):
            out = cloud_stop(rec)
            stopped.append(f"cloud {rec['id']} {'stopped' if out.get('stopped') else out.get('stop_error')}")
        p.unlink(missing_ok=True)
    return stopped


def cdp_tab(command, endpoint, *args, timeout=150):
    r = sh([opencode_side.node_bin(), str(CDP_TAB), command, str(endpoint), *map(str, args)], timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"cdp_tab {command}: {r.stderr.strip() or r.stdout.strip()}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def open_only_tab(endpoint, url):
    return cdp_tab("open", endpoint, url)


def endpoint_of(rec):
    return rec["ws"] if rec.get("kind") == "cloud" else rec["cdp_port"]
