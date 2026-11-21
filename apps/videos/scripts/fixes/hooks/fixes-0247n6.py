import importlib.util
import json
import os
import subprocess

import segments as seg_lib

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 60
HEADER_PROBE = (272, 115)
BODY_PROBE = (900, 400)
DARK = 110
LIGHT = 200
CALLOUT_HOLD = 3.2
KEYCAPS = ("⌘", "⌃")
DROPPED = ("callout", "busy", "idle", "scroll", "menu")

_spec = importlib.util.spec_from_file_location("hooks_fixes_0244n3", os.path.join(HERE, "fixes-0244n3.py"))
_menus = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_menus)


def recording(scene, side):
    with open(os.path.join(seg_lib.SCRATCH, "footage", side, f"{scene}.json")) as f:
        return json.load(f)


def probe(scene, side, point, test):
    scale = recording(scene, side).get("scale", 1)
    x, y = (round(v * scale) for v in point)
    mov = os.path.join(seg_lib.SCRATCH, "footage", side, f"{scene}.mov")
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", mov, "-vf", f"fps={FPS},format=gray,crop=1:1:{x}:{y}", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return [(i / FPS, test(b)) for i, b in enumerate(raw)]


def first(events, key):
    return next((e for e in events if key in e), None)


def busy_press(side, clip):
    events = clip["events"]
    busy, idle = first(events, "busy"), first(events, "idle")
    press = next(e["t"] for e in events if "down" in e)
    shown = next((t for t, dark in probe("s6busy", side, HEADER_PROBE, lambda b: b < DARK) if t >= press - 0.02 and dark), None)
    if shown is None:
        raise SystemExit(f"s6busy {side}: the pressed tab's page never showed")
    waited = max(0, round((shown - press) * 1000))
    if side == "after" and shown > idle["t"]:
        raise SystemExit(f"s6busy after: the page showed {waited} ms after the press, once the stall had ended")
    if side == "before" and shown < idle["t"] - 0.05:
        raise SystemExit(f"s6busy before: the page showed {waited} ms after the press, inside the stall")
    out = [{"t": busy["t"], "text": f"Pressed · Ardia busy for {busy['busy'] / 1000:g} s", "tone": "plain"}]
    if side == "after":
        out.append({"t": shown + 0.35, "text": "Page on screen within a frame of the press", "tone": "good"})
    else:
        out.append({"t": shown, "text": f"Page on screen {round(waited / 10) * 10:,} ms after the press", "tone": "bad"})
    return out


def new_tab_field(side, clip):
    events = clip["events"]
    busy, idle = first(events, "busy"), first(events, "idle")
    series = probe("s6newtab", side, BODY_PROBE, lambda b: b > LIGHT)
    page = next((t for t, clear in series if t >= busy["t"] - 0.3 and clear), None)
    if page is None:
        raise SystemExit(f"s6newtab {side}: the page never showed")
    covered = next((t for t, clear in series if page < t < idle["t"] and not clear), None)
    out = [{"t": busy["t"], "text": f"Switched · Ardia busy for {busy['busy'] / 1000:g} s", "tone": "plain"}]
    if side == "before":
        if covered is None:
            raise SystemExit("s6newtab before: the New Tab field never came back over the page")
        out.append({"t": covered, "text": "The New Tab field is back over the page", "tone": "bad"})
    else:
        if covered is not None:
            raise SystemExit(f"s6newtab after: the page was covered at {covered}")
        out.append({"t": busy["t"] + 0.9, "text": "The page stays clear", "tone": "good"})
    return out


def finish(callouts):
    callouts.sort(key=lambda c: c["t"])
    for a, b in zip(callouts, callouts[1:]):
        a.setdefault("until", min(b["t"], a["t"] + CALLOUT_HOLD))
    if callouts:
        callouts[-1].setdefault("until", callouts[-1]["t"] + CALLOUT_HOLD)
    return callouts


def clip(seg, side, clip, video_id):
    scene = seg["scene"]
    callouts = [{"t": e["t"], **e["callout"]} for e in clip["events"] if "callout" in e]
    if scene == "s6busy":
        callouts += busy_press(side, clip)
    if scene == "s6newtab":
        callouts += new_tab_field(side, clip)
    if scene == "s6sleep":
        found = _menus.menus(scene, side, clip["events"], video_id)
        if found:
            clip["menus"] = found
    if callouts:
        clip["callouts"] = finish(callouts)
    clip["events"] = [e for e in clip["events"] if not any(k in e for k in DROPPED) and ("mark" not in e or str(e["mark"])[:1] in KEYCAPS)]
