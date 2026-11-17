import datetime
import os
import shutil
import subprocess
import time
from pathlib import Path

import ardia_side
import browsers
import grading
import opencode_side
import registry
import servers
from procs import front_pid, http, kill_group, read_json, spawn_agent, write_json

ROOT = Path(os.environ.get("BENCH_BROWSERAGENT_HOME", Path.home() / "ardia-scratch/browser-use-agent"))
WORKER = Path(__file__).resolve().parent / "browseragent_worker.py"
DEFAULTS = {
    "browser": "ardia",
    "model": "gpt-6.1-terra",
    "effort": "medium",
    "venv": str(ROOT / "venv"),
    "app": browsers.ARDIA_APP,
    "chrome": None,
    "cdp_port": 9471,
    "max_steps": 200,
    "openai_base_url": "http://127.0.0.1:8318/v1",
    "openai_api_key": "local",
}
DELIVERY_MARGIN_S = 20
KEPT_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "SSL_CERT_FILE")


def log(msg):
    ardia_side.log(f"browseragent: {msg}")


def options(overrides=None):
    opts = dict(DEFAULTS)
    opts.update({k: v for k, v in (overrides or {}).items() if v is not None})
    opts["cdp_port"] = int(opts["cdp_port"]) + int(opts.get("lane_index") or 0)
    opts["lane"] = opts.get("lane") or "lane0"
    return opts


def lane_dir(opts):
    return ROOT / "lanes" / opts["lane"]


def state_path(opts):
    return registry.STATE_DIR / f"browseragent-{opts['lane']}.json"


def stop_lane(opts):
    state = read_json(state_path(opts)) or {}
    stopped = []
    rec = state.get("browser")
    if rec and browsers.stop_browser(rec):
        stopped.append(f"{rec.get('kind')} {rec['pid']}")
    state_path(opts).unlink(missing_ok=True)
    return stopped


def stop_all():
    stopped = []
    for p in sorted(registry.STATE_DIR.glob("browseragent-*.json")):
        stopped += stop_lane({"lane": p.stem.removeprefix("browseragent-")})
    return stopped


def worker_env(opts, home):
    env = {k: os.environ[k] for k in KEPT_ENV if k in os.environ}
    env.update(OPENAI_BASE_URL=opts["openai_base_url"], OPENAI_API_KEY=opts["openai_api_key"],
               ANONYMIZED_TELEMETRY="false", BROWSER_USE_NO_UPDATE_CHECK="1", BROWSER_USE_SETUP_LOGGING="true",
               BH_HOME=str(home / "bh"), BH_TELEMETRY="0", BH_UPDATE_CHECK="0", BU_NAME=opts["lane"],
               PYTHONUNBUFFERED="1")
    return env


def run(task_id, agent, run_id, results_dir, overrides=None, contender=None, on_agent_start=None):
    opts = options(overrides)
    task = registry.task(task_id, int(opts.get("port_offset") or 0))
    deadline = int(opts.get("deadline_s") or task["deadline_s"])
    results_dir = Path(results_dir)
    runs_dir = results_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    out_json = runs_dir / f"{run_id}.json"
    out_dir = runs_dir / f"{run_id}.browseragent"
    stderr = runs_dir / f"{run_id}.stderr.log"
    home = lane_dir(opts)
    servers.start(task)
    stale = stop_lane(opts)
    if stale:
        log(f"{opts['lane']}: stopped leftovers {stale}")
    try:
        baseline = ardia_side.reset_task(task)
        if home.exists():
            shutil.rmtree(home)
        (home / "bh").mkdir(parents=True)
        if out_dir.exists():
            shutil.rmtree(out_dir)
        t0 = time.monotonic()
        busy = opencode_side.listener_pids(opts["cdp_port"])
        if busy:
            raise SystemExit(f"port {opts['cdp_port']} is used by pid {busy}, not by this harness")
        if opts["browser"] == "ardia":
            browser = browsers.launch_ardia(opts["app"], home / "ardia-data", opts["cdp_port"])
        else:
            with open(home / "browser.log", "ab") as logs:
                browser = browsers.launch_chrome(opts.get("chrome"), home, opts["cdp_port"], logs)
        write_json(state_path(opts), {"browser": browser})
        tab = browsers.open_only_tab(opts["cdp_port"], task["start_url"])
        setup_s = round(time.monotonic() - t0, 2)
        prompt_file = home / "prompt.txt"
        prompt_file.write_text(task["prompt"])
        cmd = [str(Path(opts["venv"]) / "bin/python"), "-I", str(WORKER), str(prompt_file),
               f"http://127.0.0.1:{opts['cdp_port']}", opts["model"], opts["effort"], str(deadline - DELIVERY_MARGIN_S),
               str(opts["max_steps"]), str(out_dir)]
        front_before = front_pid()
        started_at = datetime.datetime.now().astimezone()
        log(f"{run_id}: browser-use agent on {task_id} ({opts['lane']}, {opts['browser']} CDP {opts['cdp_port']})")
        with open(stderr, "wb") as fe, opencode_side.FrontSampler(browser["pid"]) as front:
            if on_agent_start:
                on_agent_start()
            start_epoch = time.time()
            t1 = time.monotonic()
            proc = spawn_agent(cmd, cwd=home, env=worker_env(opts, home), stdin=subprocess.DEVNULL, stdout=fe,
                               stderr=subprocess.STDOUT)
            timed_out = False
            try:
                code = proc.wait(timeout=deadline)
            except subprocess.TimeoutExpired:
                timed_out = True
                kill_group(proc)
                code = proc.returncode
            wall = time.monotonic() - t1
        front_after = front_pid()
        kill_group(proc, grace=2)
        try:
            check = http(task["check"]["method"], task["check"]["url"])
        except Exception as e:
            check = {"pass": False, "error": str(e)}
    finally:
        stopped = stop_lane(opts)
    metrics = read_json(out_dir / "metrics.json") or {}
    shutil.rmtree(out_dir / "workspace", ignore_errors=True)
    passed, reset_by_agent = grading.grade(check, timed_out, baseline_reset_at_ms=baseline.get("reset_at_ms"))
    completed = check.get("completed_at_ms")
    usage = metrics.get("usage") or {}
    tokens_in, tokens_out = usage.get("input", 0), usage.get("output", 0)
    record = {
        "run_id": run_id, "side": "browseragent", "contender": contender or f"browseragent-{opts['browser']}",
        "agent": "browser-use", "browser": opts["browser"], "task": task_id,
        "started_at": started_at.isoformat(timespec="milliseconds"), "model": opts["model"], "effort": opts["effort"],
        "lane": opts["lane"], "port_offset": task["port_offset"],
        "wall_s": round(wall, 3), "timed_out": timed_out, "deadline_s": deadline, "exit_code": code,
        "agent_status": metrics.get("status"), "agent_success": metrics.get("success"),
        "pass": passed, "reset_by_agent": reset_by_agent,
        "time_to_correct_s": round(completed / 1000 - start_epoch, 3) if passed and completed else None,
        "commands": metrics.get("python_cells"), "tool_calls": metrics.get("tool_calls"),
        "turns": metrics.get("model_requests"),
        "tokens": {"input": tokens_in, "cached_input": usage.get("cache_read", 0), "output": tokens_out,
                   "total": tokens_in + tokens_out, "raw_usage": usage} if usage else None,
        "cost_usd": metrics.get("cost_usd"), "final_message": metrics.get("final_message"),
        "errors": [metrics["error"]] if metrics.get("error") else [],
        "matched": check.get("matched"), "total": check.get("total"), "extra": check.get("extra"),
        "method": check.get("method"), "invariants": check.get("invariants"),
        "check": check, "check_details": check.get("details"),
        "prompt": task["prompt"], "command": cmd[:3] + cmd[4:],
        "instance": {"browser": {k: browser.get(k) for k in ("kind", "pid", "browser", "user_agent", "app",
                                                             "cdp_port", "launch_s")},
                     "setup_s": setup_s, "home": str(home), "tab": tab, "browser_use": metrics.get("browser_use"),
                     "llm_class": metrics.get("llm_class"), "reasoning_applied": metrics.get("reasoning_applied")},
        "focus": {"front_pid_before": front_before, "front_pid_after": front_after,
                  "ours_in_front": browser["pid"] in (front_before, front_after), "front_samples": front.samples},
        "frontmost_during_run": front.ours,
        "stopped_after": stopped, "steps_file": str(out_dir / "steps.jsonl"), "stderr_file": str(stderr),
    }
    write_json(out_json, record)
    log(f"{run_id}: pass={passed} wall={record['wall_s']} s tokens={(record['tokens'] or {}).get('total')} "
        f"cells={record['commands']} status={metrics.get('status')} -> {out_json}")
    return record
