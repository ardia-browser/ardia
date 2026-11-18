SCROLL_KEYS = ("j", "k")
CALLOUT_DELAY = 0.9
PAGE_KEYS = ("pageKey", "pageY", "pageFocus", "pageFound", "pageFinal", "pageMissing")


def clip(seg, side, clip, video_id):
    scene = seg["scene"]
    events = clip["events"]
    if any(e.get("pageMissing") for e in events):
        raise SystemExit(f"{scene} {side}: the test page never loaded")
    pressed = [e for e in events if e.get("mark") in SCROLL_KEYS]
    received = [e for e in events if "pageKey" in e]
    final = next(e for e in events if e.get("pageFinal"))
    if not pressed:
        raise SystemExit(f"{scene} {side}: no j or k was pressed")
    if side == "after" and (len(received) != len(pressed) or final["pageY"] <= 0 or not final["pageFocus"]):
        raise SystemExit(f"{scene} after: the page got {len(received)} of {len(pressed)} keys, scrolled to {final['pageY']}, focus {final['pageFocus']}")
    if side == "before" and (received or final["pageY"] != 0):
        raise SystemExit(f"{scene} before: the page got {len(received)} keys and scrolled to {final['pageY']}")
    got = len(received)
    text = f"All {got} keys reached the page" if got == len(pressed) else "None of the keys reached the page" if got == 0 else f"{got} of {len(pressed)} keys reached the page"
    clip["callouts"] = [{"t": round(pressed[-1]["t"] + CALLOUT_DELAY, 3), "text": text, "tone": "good" if got == len(pressed) else "bad"}]
    clip["events"] = [e for e in events if not any(k in e for k in PAGE_KEYS)]
