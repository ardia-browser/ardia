import { ctrlClick, dumpAppMenu, MENU_GEOMETRY } from "./_menu.mjs";

const ROW = [120, 118];

export default {
  session: "session-0247n3-tabs.json",
  env: { ARDIA_TEST: "appMenu" },
  setup: `return sleep(2500).then(() => done());`,
  async prepare(instance) {
    const menu = await dumpAppMenu(instance, ctrlClick(...ROW));
    await instance.eval(`return new Promise((r) => setTimeout(r, 600)).then(() => "ok");`);
    return { menu, x: ROW[0], y: ROW[1] };
  },
  act: `${MENU_GEOMETRY}
const menu = P.menu || [];
const g = geometry(menu, P.x, P.y, -1);
const drawOnly = (x, y, ms) => { const x0 = px, y0 = py, steps = Math.max(1, Math.round(ms / 16)); const step = (i) => { if (i > steps) return Promise.resolve(); const k = ease(i / steps); px = Math.round((x0 + (x - x0) * k) * 10) / 10; py = Math.round((y0 + (y - y0) * k) * 10) / 10; events.push({ t: Date.now(), x: px, y: py }); return sleep(16).then(() => step(i + 1)); }; return step(1); };
return at(640, 520).then(() => sleep(600))
  .then(() => drawOnly(P.x, P.y, 800)).then(() => sleep(250))
  .then(() => { mark("go"); mark("⌃-click"); events.push({ t: Date.now(), down: 1 }); return sleep(90); })
  .then(() => { events.push({ t: Date.now(), up: 1 }); events.push({ t: Date.now(), menu: "open", geometry: g, open: -1 }); return sleep(2600); })
  .then(() => { events.push({ t: Date.now(), menu: "close" }); return move(P.x + 20, P.y + 4, 300); })
  .then(() => sleep(400)).then(() => { mark("hover"); return sleep(2400); })
  .then(() => move(640, 520, 700)).then(() => sleep(700))
  .then(() => done({ items: menu.map((i) => i.title ?? i.label ?? (i.separator ? "—" : "?")) }));`,
  tail: 500,
};
