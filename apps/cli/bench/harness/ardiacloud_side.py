import datetime
import shutil
import subprocess
import time
from pathlib import Path

import ardia_side
import browsers
import grading
import registry
import servers
import tunnel
from procs import http, kill_group, read_json, read_jsonl, sh, spawn_agent, write_json

DEFAULTS = {"cli": "dev", "model": "gpt-6.1-terra", "effort": "medium", "cloud_country": "us",
            "reach_line": "The `ardia` command already reaches the browser for this task; don't pass `--port` or `--ws`."}


def log(msg):
    ardia_side.log(f"ardiacloud: {msg}")


def options(overrides=None):
    opts = dict(DEFAULTS)
    opts.update({k: v for k, v in (overrides or {}).items() if v is not None})
    opts["lane"] = opts.get("lane") or "lane0"
    return opts


def lane_home(opts):
    return registry.HOME / f"ardiacloud-{opts['lane']}"


def state_path(opts):
    return registry.STATE_DIR / f"ardiacloud-{opts['lane']}.json"


def stop_lane(opts):
    state = read_json(state_path(opts)) or {}
    stopped = []
    rec = state.get("browser")
    if rec:
        out = browsers.cloud_stop(rec)
        stopped.append(f"cloud {rec['id']} {'stopped' if out.get('stopped') else out.get('stop_error')}")
    stopped += [f"browse daemon {p}" for p in ardia_side.stop_browse_daemons(lane_home(opts) / "data")]
    state_path(opts).unlink(missing_ok=True)
    return stopped


def stop_all():
    stopped = []
    for p in sorted(registry.STATE_DIR.glob("ardiacloud-*.json")):
        stopped += stop_lane({"lane": p.stem.removeprefix("ardiacloud-")})
    return stopped


def run(task_id, agent, run_id, results_dir, overrides=None, contender=None, on_agent_start=None):
    opts = options(overrides)
    agent = agent or "codex"
    if agent not in ardia_side.MODELS:
        raise SystemExit("agent must be claude or codex")
    local_task = registry.task(task_id, int(opts.get("port_offset") or 0))
    model, effort = opts["model"], opts["effort"]
    deadline = int(opts.get("deadline_s") or local_task["deadline_s"])
    results_dir = Path(results_dir)
    runs_dir = results_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    out_json = runs_dir / f"{run_id}.json"
    events = runs_dir / f"{run_id}.events.jsonl"
    stderr = runs_dir / f"{run_id}.stderr.log"
    cli = ardia_side.cli_info(opts)
    home = lane_home(opts)
    data = home / "data"
    servers.start(local_task)
    stale = stop_lane(opts)
    if stale:
        log(f"{opts['lane']}: stopped leftovers {stale}")
    exposure = None
    browser = None
    cloud = {}
    try:
        baseline = ardia_side.reset_task(local_task)
        if home.exists():
            shutil.rmtree(home)
        data.mkdir(parents=True)
        t0 = time.monotonic()
        exposure = tunnel.Exposure(local_task, opts['lane'], home).start()
        task = exposure.public_task()
        browser = browsers.cloud_start(f"ac-{opts['lane']}", deadline // 60 + 10, opts["cloud_country"])
        write_json(state_path(opts), {"browser": browser})
        tab = browsers.open_only_tab(browser["ws"], task["start_url"])
        workdir = ardia_side.WORK / run_id
        if workdir.exists():
            shutil.rmtree(workdir)
        workdir.mkdir(parents=True)
        target = "claude-code" if agent == "claude" else "codex"
        sh([ardia_side.ardia_bin(opts), "skills", "install", "--target", target, "--project"], cwd=workdir,
           env=ardia_side.agent_env(opts)).check_returncode()
        setup_s = round(time.monotonic() - t0, 2)
        prompt = f"{task['prompt']}\n\n{opts['reach_line']}"
        extra = {"ARDIA_DATA_DIR": str(data), "ARDIA_WS": browser["ws"], "AGENT_BROWSER_SHOW_TAB": "1"}
        if agent == "codex":
            codex_home = home / "codex-home"
            codex_home.mkdir(parents=True, exist_ok=True)
            extra.update({"HOME": str(codex_home), "CODEX_HOME": str(Path.home() / ".codex")})
            cmd = ardia_side.codex_command(model, effort, workdir, prompt)
        else:
            cmd = ardia_side.claude_command(model, effort, prompt)
        env = ardia_side.agent_env(opts, extra)
        started_at = datetime.datetime.now().astimezone()
        log(f"{run_id}: {agent} on {task_id} ({opts['lane']}, cloud {browser['id']}, setup {setup_s} s)")
        with open(events, "wb") as fo, open(stderr, "wb") as fe:
            if on_agent_start:
                on_agent_start()
            start_epoch = time.time()
            t1 = time.monotonic()
            proc = spawn_agent(cmd, cwd=workdir, env=env, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe)
            timed_out = False
            try:
                code = proc.wait(timeout=deadline)
            except subprocess.TimeoutExpired:
                timed_out = True
                kill_group(proc)
                code = proc.returncode
            wall = time.monotonic() - t1
        kill_group(proc, grace=2)
        daemons = ardia_side.stop_browse_daemons(data)
        try:
            check = http(local_task["check"]["method"], local_task["check"]["url"])
        except Exception as e:
            check = {"pass": False, "error": str(e)}
    finally:
        if browser:
            cloud = browsers.cloud_stop(browser)
            state_path(opts).unlink(missing_ok=True)
        stopped = stop_lane(opts)
        tunnel_summary = exposure.summary() if exposure else None
        if exposure:
            exposure.stop()
    passed, reset_by_agent = grading.grade(check, timed_out, baseline_reset_at_ms=baseline.get("reset_at_ms"))
    completed = check.get("completed_at_ms")
    parsed = (ardia_side.parse_claude if agent == "claude" else ardia_side.parse_codex)(read_jsonl(events))
    record = {
        "run_id": run_id, "side": "ardiacloud", "contender": contender or f"ardiacloud-{agent}", "agent": agent,
        "task": task_id, "started_at": started_at.isoformat(timespec="milliseconds"),
        "model": model, "effort": effort, "cli": cli, "notes_after": ardia_side.notes_snapshot(data),
        "lane": opts["lane"], "port_offset": local_task["port_offset"],
        "wall_s": round(wall, 3), "timed_out": timed_out, "deadline_s": deadline, "exit_code": code,
        "pass": passed, "reset_by_agent": reset_by_agent,
        "time_to_correct_s": round(completed / 1000 - start_epoch, 3) if passed and completed else None,
        "commands": sum(1 for t in parsed["tools"] if t["name"] in ardia_side.SHELL_TOOLS),
        "matched": check.get("matched"), "total": check.get("total"), "extra": check.get("extra"),
        "method": check.get("method"), "invariants": check.get("invariants"),
        "check": check, "check_details": check.get("details"), **parsed,
        "prompt": prompt, "command": cmd[:-1], "workdir": str(workdir),
        "instance": {"browser": {k: browser.get(k) for k in ("kind", "id", "browser", "user_agent", "launch_s")},
                     "setup_s": setup_s, "tab": tab, "tunnel": tunnel_summary, "cloud": cloud or None},
        "frontmost_during_run": 0,
        "browse_daemons_stopped": daemons, "stopped_after": stopped, "events_file": str(events),
        "stderr_file": str(stderr),
    }
    write_json(out_json, record)
    log(f"{run_id}: pass={passed} wall={record['wall_s']} s tokens={(record['tokens'] or {}).get('total')} "
        f"commands={record['commands']} -> {out_json}")
    return record
