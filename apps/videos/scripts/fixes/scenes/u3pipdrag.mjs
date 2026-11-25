const START = [700, 420, 400, 225];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPip(instance) {
  await sleep(300);
  const page = await instance.page("tide.example");
  await page.eval(`document.getElementById("v").requestPictureInPicture().then(() => 1)`, { userGesture: true });
  page.close();
  await sleep(1500);
  const info = await instance.eval(`const st = () => ac.store.getState(); st().activate("t1"); const pip = (action) => ac.engine.call("tabs.devPictureInPictureAction", { action });
return pip("frame:{{${START[0]}, ${START[1]}}, {${START[2]}, ${START[3]}}}").then(() => pip("alpha:1")).then(() => new Promise((r) => setTimeout(r, 1800)))
  .then(() => ac.engine.call("tabs.devPictureInPicture")).then((ws) => JSON.stringify({ pip: (ws || []).find((w) => w.video && w.visible) || null, frame: st().windows[st().windowOrder[0]].frame }));`);
  return JSON.parse(info);
}

export default {
  session: "session-0247n3-pip.json",
  minWidth: 1400,
  switches: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  setup: `return sleep(3000).then(() => done());`,
  prepare: openPip,
  act: `const pip = (action) => ac.engine.call("tabs.devPictureInPictureAction", { action });
const pipFrame = () => ac.engine.call("tabs.devPictureInPicture").then((ws) => { const w = (ws || []).find((w) => w.video && w.visible); const n = (w ? w.frame : "").match(/-?[\\d.]+/g).map(Number); return { x: n[0], y: n[1], w: n[2], h: n[3], screenH: Number(((w.visibleFrame || "").match(/-?[\\d.]+/g) || [0, 0, 0, 0])[3]) }; });
let main = null;
const toLocal = (x, y) => [x - main[0], main[1] + main[3] - y];
const trace = [];
let gx = 0, gy = 0, sx = 0, sy = 0;
const drag = (dx, dy, stepPx) => {
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy) / stepPx));
  const fx = sx, fy = sy;
  const step = (i) => {
    if (i > steps) return Promise.resolve();
    sx = fx + dx * i / steps; sy = fy + dy * i / steps;
    const [lx, ly] = toLocal(sx, sy);
    const rx = Math.round(lx * 10) / 10, ry = Math.round(ly * 10) / 10;
    events.push({ t: Date.now(), x: rx, y: ry });
    return dw("mouse:dragged:" + rx + "," + ry).then(() => sleep(16)).then(() => step(i + 1));
  };
  return step(1);
};
const offBy = () => pipFrame().then((f) => { const off = Math.round(Math.hypot(f.x + gx - sx, f.y + (f.h - gy) - sy)); trace.push(off); events.push({ t: Date.now(), mark: "off:" + off }); return off; });
let start = null;
return ac.engine.call("windows.list").then((ws) => { main = ws.filter((w) => w.hasRoot)[0].frame.match(/-?[\\d.]+/g).map(Number); }).then(pipFrame).then((f) => {
  start = f;
  gx = Math.round(f.w * 0.5); gy = Math.round(f.h * 0.45);
  sx = f.x + gx; sy = f.y + f.h - gy;
  const [lx, ly] = toLocal(sx, sy);
  return at(lx - 260, ly + 220).then(() => sleep(600)).then(() => move(lx, ly, 800)).then(() => sleep(400));
})
  .then(() => { mark("go"); events.push({ t: Date.now(), down: 1 }); return pip("mouse:down:" + gx + "," + gy); }).then(() => sleep(120))
  .then(() => drag(900, 0, 5.7)).then(offBy)
  .then(() => drag(0, -220, 5.7)).then(offBy)
  .then(() => drag(-900, 0, 5.7)).then(offBy)
  .then(() => drag(0, 220, 5.7)).then(offBy).then(() => sleep(500))
  .then(() => { events.push({ t: Date.now(), up: 1 }); const [lx, ly] = toLocal(sx, sy); return dw("mouse:up:" + lx + "," + ly); })
  .then(() => sleep(1800)).then(pipFrame)
  .then((end) => done({ start, end, trace, grab: [gx, gy], main, pointer: [sx, sy] }));`,
  tail: 500,
};
