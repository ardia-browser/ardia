import { extensionOrderScene } from "./_extorder.mjs";
import { dumpAppMenu, MENU_GEOMETRY, pickAppMenu } from "./_menu.mjs";

const PUZZLE = [193, 63];
const REST = [70, 250];
const PICK = "Red Notes";

const clickPuzzle = `const N0 = () => ac.engine.call("windows.list").then((ws) => ws.filter((w) => w.hasRoot)[0].window);
return N0().then((n) => ac.engine.call("windows.dev", { window: n, action: "mouse:down:${PUZZLE[0]},${PUZZLE[1]}" }).then(() => ac.engine.call("windows.dev", { window: n, action: "mouse:up:${PUZZLE[0]},${PUZZLE[1]}" }))).then(() => "ok");`;

const base = extensionOrderScene({ slot: { x: 0, y: 0, pitch: 0 }, rest: REST, settings: { addressBar: "sidebar", sidebarWidth: 220 } });

export default {
  session: base.session,
  env: { ARDIA_TEST: "appMenu" },
  setup: base.setup,
  async prepare(instance) {
    const menu = await dumpAppMenu(instance, clickPuzzle);
    await instance.eval(`return new Promise((r) => setTimeout(r, 600)).then(() => "ok");`);
    const frontIndex = menu.findIndex((i) => i.id === "front");
    const children = frontIndex >= 0 ? menu[frontIndex].children ?? [] : [];
    const pickIndex = children.findIndex((c) => c.title === PICK);
    if (pickIndex >= 0) pickAppMenu(instance, children[pickIndex].id);
    return { menu, frontIndex, pickIndex, x: PUZZLE[0], y: PUZZLE[1] };
  },
  act: `${MENU_GEOMETRY}
const REST = ${JSON.stringify(REST)};
const menu = P.menu || [];
const g = geometry(menu, P.x, P.y, P.frontIndex);
const profile = ac.extensions.extensionProfile(st(), W);
const order = () => (ac.extensions.useExtensions.getState().lists[profile] || []).filter((x) => x.pinned)
  .map((x, i) => ({ name: x.name, at: x.pinnedIndex === undefined ? i : x.pinnedIndex }))
  .sort((a, b) => a.at - b.at).map((x) => x.name.split(" ")[0]);
const watched = { order: order().join(",") };
events.push({ t: Date.now(), order: watched.order });
const stop = ac.extensions.useExtensions.subscribe(() => {
  const now = order().join(",");
  if (now !== watched.order) {
    watched.order = now;
    events.push({ t: Date.now(), order: now });
  }
});
const drawOnly = (x, y, ms) => { const x0 = px, y0 = py, steps = Math.max(1, Math.round(ms / 16)); const step = (i) => { if (i > steps) return Promise.resolve(); const k = ease(i / steps); px = Math.round((x0 + (x - x0) * k) * 10) / 10; py = Math.round((y0 + (y - y0) * k) * 10) / 10; events.push({ t: Date.now(), x: px, y: py }); return sleep(16).then(() => step(i + 1)); }; return step(1); };
const drawClick = () => { events.push({ t: Date.now(), down: 1 }); return sleep(90).then(() => { events.push({ t: Date.now(), up: 1 }); }); };
const realClick = () => dw("mouse:down:" + P.x + "," + P.y).then(() => dw("mouse:up:" + P.x + "," + P.y));
const frontRow = P.frontIndex >= 0 ? rowCentre(menu, P.frontIndex, g.y) : null;
const children = P.frontIndex >= 0 ? (menu[P.frontIndex].children || []) : [];
const listEnd = Math.max(0, menu.findIndex((i) => i.separator || i.type === 4) - 1);
const choose = P.pickIndex >= 0
  ? () => drawOnly(g.x + 60, frontRow, 700).then(() => sleep(250))
      .then(() => { events.push({ t: Date.now(), submenu: "open" }); return sleep(450); })
      .then(() => drawOnly(g.subX + 24, frontRow, 300))
      .then(() => drawOnly(g.subX + 50, rowCentre(children, P.pickIndex, g.subY), 450)).then(() => sleep(350))
      .then(() => { mark("pick"); return drawClick(); })
      .then(() => realClick())
      .then(() => { events.push({ t: Date.now(), menu: "close" }); return sleep(1600); })
  : () => drawOnly(g.x + 60, rowCentre(menu, listEnd, g.y), 1100).then(() => sleep(1000))
      .then(() => drawOnly(g.x + g.width + 50, rowCentre(menu, listEnd, g.y), 700)).then(() => sleep(400))
      .then(() => realClick())
      .then(() => { mark("pick"); events.push({ t: Date.now(), menu: "close" }); return sleep(1600); });
return at(...REST).then(() => sleep(500))
  .then(() => move(P.x, P.y, 800)).then(() => sleep(300))
  .then(() => { mark("go"); return drawClick(); })
  .then(() => { events.push({ t: Date.now(), menu: "open", geometry: g, open: -1 }); return sleep(700); })
  .then(() => choose())
  .then(() => move(...REST, 800)).then(() => sleep(1200))
  .then(() => { stop(); return done({ order: order(), front: P.frontIndex >= 0, items: menu.map((i) => i.title ?? (i.separator ? "—" : "?")) }); });`,
  tail: 700,
};
