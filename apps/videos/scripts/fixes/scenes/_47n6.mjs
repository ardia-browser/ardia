import { execFileSync } from "node:child_process";

export const rowCentre = async (instance, tabId, x = 120) => {
  const row = JSON.parse(await instance.eval(`return ac.sidebarRows.measureRow(ac.store.getState().windowOrder[0], ${JSON.stringify(tabId)}).then((r) => JSON.stringify(r));`));
  return { x, y: Math.round(row.y + row.height / 2) };
};

export function windowBounds(pid) {
  const script = `ObjC.import("CoreGraphics"); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))).filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowBounds.Width > 300).map((w) => ({ name: w.kCGWindowName || "", x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height })))`;
  return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 20000 }).toString());
}

export const DRAW = `const drawOnly = (x, y, ms) => {
  const x0 = px === null ? x : px, y0 = py === null ? y : py, steps = Math.max(1, Math.round(ms / 16));
  const step = (i) => {
    if (i > steps) return Promise.resolve();
    const k = ease(i / steps);
    px = Math.round((x0 + (x - x0) * k) * 10) / 10;
    py = Math.round((y0 + (y - y0) * k) * 10) / 10;
    events.push({ t: Date.now(), x: px, y: py });
    return sleep(16).then(() => step(i + 1));
  };
  return step(1);
};
const drawClick = () => { events.push({ t: Date.now(), down: 1 }); return sleep(90).then(() => { events.push({ t: Date.now(), up: 1 }); }); };
const say = (text, tone) => events.push({ t: Date.now(), callout: { text, tone: tone || "plain" } });`;
