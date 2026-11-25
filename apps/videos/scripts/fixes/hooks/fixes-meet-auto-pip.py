NOTE = {"before": "Asked to pop out while visible · ignored", "after": "Asked once hidden · pops out"}
NOTE_AT = (150, 830)


def clip(seg, side, clip, video_id):
    go = clip["inS"] + seg["lead"]
    back = next(e["t"] for e in clip["events"] if e.get("mark") == "back")
    asked = next(e for e in clip["events"] if "call" in e and e["call"]["asked"] >= 1 and e["t"] >= go - 0.1)
    if asked["call"]["lastAsked"] != ("visible" if side == "before" else "hidden"):
        raise SystemExit(f"meetpip {side}: the page was asked while {asked['call']['lastAsked']}")
    clip["notes"] = [{"t": asked["t"], "until": back, "x": NOTE_AT[0], "y": NOTE_AT[1], "text": NOTE[side]}]
    clip["events"] = [e for e in clip["events"] if "mark" not in e and "call" not in e]
