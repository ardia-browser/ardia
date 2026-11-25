import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_ONLY = ("calloutPlace",)
START = "Amber,Blue,Green,Red"
EXPECTED = ("Blue,Green,Amber,Red", "Red,Blue,Green,Amber")
FRONT_HIDDEN = ["Green Notes", "Red Notes"]
FRONT_EXPECTED = "Red,Amber,Blue,Green"
SETTLE = 1.2

_spec = importlib.util.spec_from_file_location("hooks_fixes_0244n3", os.path.join(HERE, "fixes-0244n3.py"))
_menus = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_menus)


def order_at(orders, t, start):
    return ([e["order"] for e in orders if e["t"] <= t] or [start])[-1]


def placed(seg, callout):
    return {**callout, **({"place": seg["calloutPlace"]} if seg.get("calloutPlace") else {})}


def drags(seg, side, clip, scene, events, orders):
    downs = [e["t"] for e in events if e.get("down")]
    ups = [e["t"] for e in events if e.get("up")]
    if len(downs) != 2 or len(ups) != 2:
        raise SystemExit(f"{scene} {side}: expected two drags, saw {len(downs)} downs and {len(ups)} ups")
    callouts = []
    for i, up in enumerate(ups):
        now = order_at(orders, up + SETTLE, START)
        moved = now != order_at(orders, up - 0.001, START)
        if side == "after" and now != EXPECTED[i]:
            raise SystemExit(f"{scene} after: drop {i + 1} left {now}, not {EXPECTED[i]}")
        if side == "before" and moved:
            raise SystemExit(f"{scene} before: drop {i + 1} changed the order ({now})")
        until = downs[i + 1] - 0.25 if i + 1 < len(downs) else None
        text = "Saved · " + " · ".join(now.split(",")) if moved else "Dropped · nothing moved"
        callouts.append(placed(seg, {"t": up + 0.2, **({"until": until} if until else {}), "text": text, "tone": "good" if moved else "bad"}))
    clip["callouts"] = callouts


def front(seg, side, clip, scene, events, orders, video_id):
    found = _menus.menus(scene, side, events, video_id)
    if not found or len(found) != 1:
        raise SystemExit(f"{scene} {side}: expected one menu, saw {len(found or [])}")
    menu = found[0]
    entry = next((i for i in menu["items"] if i.get("title") == "Move to Front"), None)
    if side == "after":
        if not entry or [c.get("title") for c in entry.get("children", [])] != FRONT_HIDDEN:
            raise SystemExit(f"{scene} after: Move to Front should list {FRONT_HIDDEN}, menu was {[i.get('title') for i in menu['items']]}")
        if menu["sub"] is None:
            raise SystemExit(f"{scene} after: the submenu never opened")
    elif entry:
        raise SystemExit(f"{scene} before: 0.2.46's menu has Move to Front")
    now = order_at(orders, menu["until"] + SETTLE, START)
    moved = now != START
    if side == "after" and now != FRONT_EXPECTED:
        raise SystemExit(f"{scene} after: the pick left {now}, not {FRONT_EXPECTED}")
    if side == "before" and moved:
        raise SystemExit(f"{scene} before: the order changed ({now})")
    text = "Moved to front · " + " · ".join(now.split(",")) if moved else "No Move to Front · nothing moved"
    clip["menus"] = found
    clip["callouts"] = [placed(seg, {"t": menu["until"] + 0.2, "text": text, "tone": "good" if moved else "bad"})]


def clip(seg, side, clip, video_id):
    scene = seg["scene"]
    events = clip["events"]
    if any(e.get("popup") for e in events):
        raise SystemExit(f"{scene} {side}: a popup opened")
    orders = [e for e in events if "order" in e]
    if not orders or orders[0]["order"] != START:
        raise SystemExit(f"{scene} {side}: started as {orders[0]['order'] if orders else None}, not {START}")
    if any(e.get("menu") for e in events):
        front(seg, side, clip, scene, events, orders, video_id)
    else:
        drags(seg, side, clip, scene, events, orders)
    clip["events"] = [e for e in events if not any(k in e for k in ("mark", "order", "popup", "menu", "submenu"))]
