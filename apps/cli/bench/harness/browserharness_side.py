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
import tunnel
from procs import front_pid, http, kill_group, proc_info, read_json, read_jsonl, sh, spawn_agent, terminate, write_json

ROOT = Path(os.environ.get("BENCH_BROWSERHARNESS_HOME", Path.home() / "ardia-scratch/browser-harness"))
DEFAULTS = {
    "browser": "chrome",
    "agent": "codex",
    "model": "gpt-6.1-terra",
    "effort": "medium",
    "venv": str(ROOT / "venv"),
    "repo": str(ROOT / "repo"),
    "chrome": None,
    "app": browsers.ARDIA_APP,
    "cdp_port": 9771,
    "cloud_country": "us",
}
STRIPPED_ENV_PREFIXES = ("BU_", "BH_", "BROWSER_USE_", "BROWSER_HARNESS_", "OPENCODE_", "OPENAI_")
COPIED_FROM_REPO = ("SKILL.md", "AGENTS.md", "README.md", "install.md", "agent-workspace", "interaction-skills", "skills",
                    "docs", "src")
SYSTEM_PROMPT = """You are evaluating a benchmark task by driving a real browser through the browser-harness in the current working directory.

Hard rules:
- Use the harness. Read `SKILL.md` and `src/browser_harness/helpers.py` first. Drive the browser via `browser-harness <<'PY' ... PY` heredocs -- do not install other browser tools, do not use Playwright directly, do not open a different repo.
- The `browser-harness` CLI is on the shell's `PATH`.
- A browser daemon is already running under the `BU_NAME` in the environment and is attached to a live browser. Do not start, stop, or restart daemons. Do not call `start_remote_daemon` or `stop_remote_daemon`. Do not run `pkill`.
- Save every screenshot to `{shots}/step_<N>.png` where N is a zero-padded 3-digit integer starting at 001 and incrementing on each shot (e.g. `screenshot("{shots}/step_001.png")`). Never overwrite a previous screenshot path.
- Do not ask the user clarifying questions. If the task is ambiguous, pick the most reasonable interpretation and proceed.
- Do not edit files outside the current working directory, except for the required screenshots under {shots}.
- Work fully autonomously. Do not stop early to summarize partial progress -- keep driving the browser until the task is genuinely complete (or you have hit a dead end). When you reach an answer, deliver it in the format below and exit.
- When the task is complete, end your final assistant message with exactly one line in this format and nothing after it:

FINAL ANSWER: <your concise answer to the task, on a single line>

If the task has no textual answer (e.g. "book a flight"), write `FINAL ANSWER: done` and describe what you did in the preceding text.

---

Task:
{task}
"""


def log(msg):
    ardia_side.log(f"browserharness: {msg}")


def options(overrides=None):
    opts = dict(DEFAULTS)
    opts.update({k: v for k, v in (overrides or {}).items() if v is not None})
    opts["cdp_port"] = int(opts["cdp_port"]) + int(opts.get("lane_index") or 0)
    opts["lane"] = opts.get("lane") or "lane0"
    if opts["browser"] not in ("chrome", "cloud", "ardia"):
        raise SystemExit(f"browser must be chrome, cloud or ardia, not {opts['browser']}")
    return opts


def lane_dir(opts):
    return ROOT / "lanes" / opts["lane"]


def state_path(opts):
    return registry.STATE_DIR / f"browserharness-{opts['lane']}.json"


def bin_dir(opts):
    path = ROOT / "bin"
    path.mkdir(parents=True, exist_ok=True)
    link = path / "browser-harness"
    target = Path(opts["venv"]) / "bin/browser-harness"
    if not target.exists():
        raise SystemExit(f"no browser-harness at {target}; run: uv venv -p 3.12 {opts['venv']} && "
                         f"VIRTUAL_ENV={opts['venv']} uv pip install {opts['repo']}")
    if not link.is_symlink() or link.resolve() != target.resolve():
        link.unlink(missing_ok=True)
        link.symlink_to(target)
    return path


def harness_env(opts, home, browser, workdir):
    env = {"BU_NAME": opts["lane"], "BH_HOME": str(home / "bh"), "BH_TELEMETRY": "0", "BH_UPDATE_CHECK": "0",
           "BH_AGENT_WORKSPACE": str(workdir / "agent-workspace"), "ANONYMIZED_TELEMETRY": "false"}
    if browser["kind"] == "cloud":
        env["BU_CDP_WS"] = browser["ws"]
    else:
        env["BU_CDP_URL"] = f"http://127.0.0.1:{browser['cdp_port']}"
    return env


def agent_env(opts, home, browser, workdir, extra=None):
    env = ardia_side.agent_env({"cli": "installed"}, extra)
    env = {k: v for k, v in env.items() if not k.startswith(STRIPPED_ENV_PREFIXES)}
    keep = [p for p in env["PATH"].split(":") if p and Path(p) not in (ardia_side.DEV_BIN, ardia_side.INSTALLED_ARDIA.parent)]
    env["PATH"] = ":".join([str(bin_dir(opts))] + keep)
    env.update(harness_env(opts, home, browser, workdir))
    return env


def daemon_record(home, lane):
    try:
        pid = int((home / "bh/runtime" / f"bu-{lane}.pid").read_text().strip())
    except (OSError, ValueError):
        return None
    info = proc_info(pid)
    if not info or "browser_harness" not in info["command"]:
        return None
    return dict(info, pid=pid)


def stop_lane(opts):
    state = read_json(state_path(opts)) or {}
    stopped = []
    daemon = daemon_record(lane_dir(opts), opts["lane"])
    if daemon and terminate(daemon, grace=5):
        stopped.append(f"daemon {daemon['pid']}")
    rec = state.get("browser")
    if rec and rec.get("kind") == "cloud":
        out = browsers.cloud_stop(rec)
        stopped.append(f"cloud {rec['id']} {'stopped' if out.get('stopped') else out.get('stop_error')}")
    elif rec and browsers.stop_browser(rec):
        stopped.append(f"{rec.get('kind')} {rec['pid']}")
    state_path(opts).unlink(missing_ok=True)
    return stopped


def stop_all():
    stopped = []
    for p in sorted(registry.STATE_DIR.glob("browserharness-*.json")):
        stopped += stop_lane({"lane": p.stem.removeprefix("browserharness-")})
    return stopped


def start_browser(opts, task, home, deadline):
    if opts["browser"] == "cloud":
        return browsers.cloud_start(f"bh-{opts['lane']}", deadline // 60 + 10, opts["cloud_country"])
    with open(home / "browser.log", "ab") as logs:
        if opts["browser"] == "ardia":
            return browsers.launch_ardia(opts["app"], home / "ardia-data", opts["cdp_port"])
        return browsers.launch_chrome(opts.get("chrome"), home, opts["cdp_port"], logs)


def make_workdir(opts, run_id):
    workdir = ardia_side.WORK / run_id
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    repo = Path(opts["repo"])
    for name in COPIED_FROM_REPO:
        src = repo / name
        if src.is_dir():
            shutil.copytree(src, workdir / name, ignore=shutil.ignore_patterns("__pycache__", "*.egg-info"))
        elif src.exists():
            shutil.copy2(src, workdir / name)
    (workdir / "shots").mkdir()
    return workdir


def warm_daemon(env, workdir):
    r = sh([str(Path(env["PATH"].split(":")[0]) / "browser-harness")], timeout=90, cwd=workdir, env=env,
           input="print(page_info())\n")
    if r.returncode != 0:
        raise RuntimeError(f"browser-harness warm-up failed: {(r.stderr or r.stdout).strip()[-800:]}")
    return r.stdout.strip()[-600:]


def harness_calls(shell):
    bh = [c for c in shell if c and "browser-harness" in c]
    return bh, [c for c in shell if not (c and "browser-harness" in c)]


def run(task_id, agent, run_id, results_dir, overrides=None, contender=None, on_agent_start=None):
    opts = options(overrides)
    agent = agent or opts["agent"]
    if agent != "codex":
        raise SystemExit("the browser-harness side runs Codex only")
    local_task = registry.task(task_id, int(opts.get("port_offset") or 0))
    model, effort = opts["model"], opts["effort"]
    deadline = int(opts.get("deadline_s") or local_task["deadline_s"])
    results_dir = Path(results_dir)
    runs_dir = results_dir / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    out_json = runs_dir / f"{run_id}.json"
    events = runs_dir / f"{run_id}.events.jsonl"
    stderr = runs_dir / f"{run_id}.stderr.log"
    home = lane_dir(opts)
    servers.start(local_task)
    exposure = None
    browser = None
    daemon = None
    cloud = {}
    stale = stop_lane(opts)
    if stale:
        log(f"{opts['lane']}: stopped leftovers {stale}")
    try:
        baseline = ardia_side.reset_task(local_task)
        if home.exists():
            shutil.rmtree(home)
        (home / "bh").mkdir(parents=True)
        t0 = time.monotonic()
        state = {}
        task = local_task
        if opts["browser"] == "cloud":
            exposure = tunnel.Exposure(local_task, opts['lane'], home).start()
            task = exposure.public_task()
        busy = [] if opts["browser"] == "cloud" else opencode_side.listener_pids(opts["cdp_port"])
        if busy:
            raise SystemExit(f"port {opts['cdp_port']} is used by pid {busy}, not by this harness")
        browser = start_browser(opts, task, home, deadline)
        state["browser"] = browser
        write_json(state_path(opts), state)
        tab = browsers.open_only_tab(browsers.endpoint_of(browser), task["start_url"])
        workdir = make_workdir(opts, run_id)
        codex_home = home / "codex-home"
        codex_home.mkdir(parents=True, exist_ok=True)
        env = agent_env(opts, home, browser, workdir, {"HOME": str(codex_home), "CODEX_HOME": str(Path.home() / ".codex")})
        warm = warm_daemon(env, workdir)
        setup_s = round(time.monotonic() - t0, 2)
        prompt = SYSTEM_PROMPT.format(shots=workdir / "shots", task=task["prompt"])
        cmd = ardia_side.codex_command(model, effort, workdir, prompt)
        cmd = [shutil.which("codex", path=ardia_side.agent_env({"cli": "installed"})["PATH"]) or "codex"] + cmd[1:]
        front_before = front_pid()
        started_at = datetime.datetime.now().astimezone()
        log(f"{run_id}: codex on {task_id} ({opts['lane']}, {opts['browser']}, setup {setup_s} s)")
        with open(events, "wb") as fo, open(stderr, "wb") as fe, opencode_side.FrontSampler(browser.get("pid") or -1) as front:
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
        front_after = front_pid()
        kill_group(proc, grace=2)
        try:
            check = http(local_task["check"]["method"], local_task["check"]["url"])
        except Exception as e:
            check = {"pass": False, "error": str(e)}
        daemon = daemon_record(home, opts["lane"])
    finally:
        if browser and browser.get("kind") == "cloud":
            cloud = browsers.cloud_stop(browser)
            left = read_json(state_path(opts)) or {}
            left.pop("browser", None)
            write_json(state_path(opts), left)
        stopped = stop_lane(opts)
        if exposure:
            tunnel_summary = exposure.summary()
            exposure.stop()
    passed, reset_by_agent = grading.grade(check, timed_out, baseline_reset_at_ms=baseline.get("reset_at_ms"))
    completed = check.get("completed_at_ms")
    lines = read_jsonl(events)
    parsed = ardia_side.parse_codex(lines)
    _, shell, other = opencode_side.browse_calls_codex(lines)
    bh_calls, other_shell = harness_calls(shell)
    record = {
        "run_id": run_id, "side": "browserharness", "contender": contender or f"browserharness-{opts['browser']}",
        "agent": agent, "browser": opts["browser"], "task": task_id,
        "started_at": started_at.isoformat(timespec="milliseconds"), "model": model, "effort": effort,
        "lane": opts["lane"], "port_offset": local_task["port_offset"],
        "wall_s": round(wall, 3), "timed_out": timed_out, "deadline_s": deadline, "exit_code": code,
        "pass": passed, "reset_by_agent": reset_by_agent,
        "time_to_correct_s": round(completed / 1000 - start_epoch, 3) if passed and completed else None,
        "commands": len(shell), "browser_harness_calls": len(bh_calls), "shell_commands": len(other_shell),
        "shell": shell, "other_tools": other,
        "matched": check.get("matched"), "total": check.get("total"), "extra": check.get("extra"),
        "method": check.get("method"), "invariants": check.get("invariants"),
        "check": check, "check_details": check.get("details"), **parsed,
        "prompt": prompt, "command": cmd[:-1], "workdir": str(workdir),
        "instance": {"browser": {k: browser.get(k) for k in ("kind", "pid", "id", "browser", "user_agent", "args",
                                                             "app", "cdp_port", "launch_s")},
                     "setup_s": setup_s, "home": str(home), "tab": tab, "warm_up": warm, "daemon": daemon,
                     "harness_repo": opts["repo"],
                     "tunnel": tunnel_summary if exposure else None, "cloud": cloud or None},
        "focus": {"front_pid_before": front_before, "front_pid_after": front_after,
                  "ours_in_front": browser.get("pid") in (front_before, front_after) if browser.get("pid") else False,
                  "front_samples": front.samples},
        "frontmost_during_run": front.ours,
        "stopped_after": stopped, "events_file": str(events), "stderr_file": str(stderr),
    }
    write_json(out_json, record)
    log(f"{run_id}: pass={passed} wall={record['wall_s']} s tokens={(record['tokens'] or {}).get('total')} "
        f"commands={record['commands']} (browser-harness {len(bh_calls)}) -> {out_json}")
    return record
