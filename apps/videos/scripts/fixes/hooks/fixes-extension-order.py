def clip(seg, side, clip, video_id):
    events = clip["events"]
    if any(e.get("popup") for e in events):
        raise SystemExit(f"extorder {side}: a popup opened during the drags")
    downs = [e["t"] for e in events if e.get("down")]
    ups = [e["t"] for e in events if e.get("up")]
    if len(downs) != 2 or len(ups) != 2:
        raise SystemExit(f"extorder {side}: expected two drags, saw {len(downs)} downs and {len(ups)} ups")
    orders = [e for e in events if "order" in e]
    start = orders[0]["order"]
    callouts = []
    for i, up in enumerate(ups):
        settled = [e["order"] for e in orders if e["t"] <= up + 1.2] or [start]
        now = settled[-1]
        moved = now != ([e["order"] for e in orders if e["t"] < up] or [start])[-1]
        if side == "after" and not moved:
            raise SystemExit(f"extorder after: drop {i + 1} didn't change the order ({now})")
        if side == "before" and moved:
            raise SystemExit(f"extorder before: drop {i + 1} changed the order ({now})")
        until = downs[i + 1] - 0.25 if i + 1 < len(downs) else None
        text = "Saved · " + " · ".join(now.split(",")) if moved else "Dropped · nothing moved"
        callouts.append({"t": up + 0.2, **({"until": until} if until else {}), "text": text, "tone": "good" if moved else "bad"})
    clip["callouts"] = callouts
    clip["events"] = [e for e in events if "mark" not in e and "order" not in e and "popup" not in e]
