import json
import os

import segments as seg_lib

IN_SETTINGS = {"s8keys"}


def clip(seg, side, clip, video_id):
    events = [e for e in clip["events"] if "mark" not in e or e["mark"].startswith("⌘")]
    if seg["scene"] in IN_SETTINGS:
        with open(os.path.join(seg_lib.SCRATCH, "footage", side, f"{seg['scene']}.json")) as f:
            ox, oy = json.load(f)["offset"]
        events = [{**e, "x": round(e["x"] + ox, 1), "y": round(e["y"] + oy, 1)} if "x" in e and "y" in e else e for e in events]
    clip["events"] = [{k: v for k, v in e.items() if k != "answer"} for e in events]
