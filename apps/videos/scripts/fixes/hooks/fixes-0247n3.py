import importlib.util
import json
import os
import subprocess

import segments as seg_lib

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_ONLY = ("afterSettings",)
SIDEBAR_PROBE = (60, 300)
EDGE_ROW = 500
EDGE_STRIP = 8
DARK = 150
FPS = 60
CALLOUT_HOLD = 3.4

_spec = importlib.util.spec_from_file_location("hooks_fixes_0244n3", os.path.join(HERE, "fixes-0244n3.py"))
_menus = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_menus)


def footage(scene, side):
    return os.path.join(seg_lib.SCRATCH, "footage", side, f"{scene}.mov")


def scale_of(scene, side):
    with open(os.path.join(seg_lib.SCRATCH, "footage", side, f"{scene}.json")) as f:
        return json.load(f).get("scale", 1)


def sidebar_shown(scene, side):
    s = scale_of(scene, side)
    x, y = (round(v * s) for v in SIDEBAR_PROBE)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", footage(scene, side), "-vf", f"fps={FPS},format=gray,crop=1:1:{x}:{y}", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return [(i / FPS, b < DARK) for i, b in enumerate(raw)]


def panel_edge(scene, side, t):
    s = scale_of(scene, side)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", footage(scene, side), "-frames:v", "1", "-vf", f"format=gray,crop=iw:1:0:{round(EDGE_ROW * s)}", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    start = round(20 * s)
    edge = next((i for i in range(start, len(raw)) if raw[i] > 200), None)
    return None if edge is None else edge / s


def shown_at(series, t):
    return next((v for (u, v) in series if u >= t), series[-1][1])


def change_after(series, t, to, until=None):
    return next((u for (u, v) in series if u >= t and v == to and (until is None or u <= until)), None)


def pointer_x(events, t):
    x = None
    for e in events:
        if e["t"] > t:
            break
        if "x" in e:
            x = e["x"]
    return x


def mark_t(events, name):
    return next((e["t"] for e in events if e.get("mark") == name), None)


def edge_glow(events, h):
    spans = []
    start = None
    for e in events:
        if "x" not in e:
            continue
        inside = e["x"] < EDGE_STRIP
        if inside and start is None:
            start = e["t"]
        if not inside and start is not None:
            spans.append((start, e["t"]))
            start = None
    if start is not None:
        spans.append((start, events[-1]["t"]))
    return [{"t": a, "until": b, "x": 0, "y": 0, "w": 6, "h": h} for a, b in spans if b - a > 0.08]


def finish(callouts):
    callouts.sort(key=lambda c: c["t"])
    for a, b in zip(callouts, callouts[1:]):
        a.setdefault("until", min(b["t"], a["t"] + CALLOUT_HOLD))
    if callouts:
        callouts[-1].setdefault("until", callouts[-1]["t"] + CALLOUT_HOLD)
    return callouts


def edgezones(side, clip):
    ev = clip["events"]
    series = sidebar_shown("u3edgezones", side)
    go, drift, away = mark_t(ev, "go"), mark_t(ev, "drift"), mark_t(ev, "away")
    out = []
    opened = change_after(series, go, True)
    edge = None
    if opened is not None:
        out.append({"t": opened, "text": f"Opens {max(0, round(pointer_x(ev, opened)))} pt from the edge", "tone": "plain"})
        edge = panel_edge("u3edgezones", side, opened + 0.8)
    closed = change_after(series, opened or go, False, drift + 1.2)
    if edge is not None and closed is not None:
        out.append({"t": closed, "text": f"Shut when the pointer slipped {round(pointer_x(ev, closed) - edge)} pt past it", "tone": "bad"})
    elif edge is not None:
        out.append({"t": drift + 0.4, "text": f"Still open {round(pointer_x(ev, drift) - edge)} pt past the panel", "tone": "good"})
        back = mark_t(ev, "back")
        left = next((e["t"] for e in ev if e["t"] >= back and "x" in e and e["x"] > edge + 40), away)
        late = change_after(series, left, False)
        if late is not None:
            out.append({"t": late, "text": f"Closes {round((late - left) * 1000 / 50) * 50} ms after you leave", "tone": "good"})
    return out


def recorded(scene, side, key):
    with open(os.path.join(seg_lib.SCRATCH, "footage", side, f"{scene}.json")) as f:
        return json.load(f).get(key)


def floatdrag(side, clip):
    ev = clip["events"]
    series = sidebar_shown("u3floatdrag", side)
    out = []
    for down, up in (("body", "bodyUp"), ("edge", "edgeUp")):
        a, b = mark_t(ev, down), mark_t(ev, up)
        lost = change_after(series, a, False, b)
        if lost is not None:
            out.append({"t": lost, "text": "Dropped mid-drag", "tone": "bad"})
        elif down == "body":
            out.append({"t": a + 0.5, "text": "Held while dragging", "tone": "good"})
        else:
            out.append({"t": a + 0.5, "text": "Held while dragging", "tone": "good"})
            width = recorded("u3floatdrag", side, "width")
            if width:
                out.append({"t": b + 0.1, "text": f"Resized to {width} pt", "tone": "good"})
    return out


def edgeoff(side, clip):
    ev = clip["events"]
    series = sidebar_shown("u3edgeoff", side)
    brush, key = mark_t(ev, "brush"), mark_t(ev, "⌘S")
    out = []
    popped = change_after(series, brush - 0.3, True, brush + 1.2)
    if popped is not None:
        out.append({"t": popped, "text": "Edge brushed: tabs pop open", "tone": "bad"})
    else:
        out.append({"t": brush + 0.5, "text": "Edge brushed: stays hidden", "tone": "good"})
    shut = change_after(series, popped or brush, False, key) if popped is not None else None
    if shut is not None:
        out.append({"t": shut, "text": "Pointer leaves: tabs slide away", "tone": "plain"})
    shown = change_after(series, key, True)
    if shown is not None:
        out.append({"t": shown, "text": "⌘S: tabs open", "tone": "good"})
    return out


def scripted(clip):
    return [{"t": e["t"], **e["callout"]} for e in clip["events"] if "callout" in e]


def clip(seg, side, clip, video_id):
    scene = seg["scene"]
    if "inS" in clip and "lead" in seg:
        clip["events"] = sorted([*clip["events"], {"t": round(clip["inS"] + seg["lead"], 3), "mark": "go"}], key=lambda e: e["t"])
    if scene == "u3resetmenu":
        found = _menus.menus(scene, side, clip["events"], video_id)
        if found:
            clip["menus"] = found
    callouts = scripted(clip)
    if scene == "u3edgezones":
        callouts += edgezones(side, clip)
    if scene == "u3edgeoff":
        callouts += edgeoff(side, clip)
    if scene == "u3floatdrag":
        callouts += [{**c, "place": "top"} for c in floatdrag(side, clip)]
    if scene in ("u3edgezones", "u3edgeoff", "u3floatdrag"):
        clip["highlights"] = edge_glow(clip["events"], 720)
    if callouts:
        clip["callouts"] = finish(callouts)
    clip["events"] = [e for e in clip["events"] if "callout" not in e and ("mark" not in e or str(e["mark"])[:1] in ("⌘", "⌃"))]
