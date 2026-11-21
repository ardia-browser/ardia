import { CTRL, ctrlClick, dumpAppMenu, MENU_GEOMETRY, pickAppMenu } from "./_menu.mjs";
import { DRAW, rowCentre } from "./_47n6.mjs";

export default {
  session: "session-0247n6-sleep.json",
  env: { ARDIA_TEST: "appMenu" },
  setup: `st().activate("t3"); return sleep(3000).then(() => { st().activate("t1"); return sleep(2000); }).then(() => done());`,
  async prepare(instance) {
    const at = await rowCentre(instance, "t3");
    const menu = await dumpAppMenu(instance, ctrlClick(at.x, at.y));
    await instance.eval(`return new Promise((r) => setTimeout(r, 600)).then(() => "ok");`);
    const index = menu.findIndex((i) => i.id === "sleep");
    if (index >= 0) pickAppMenu(instance, "sleep");
    return { menu, index, ...at };
  },
  act: `${MENU_GEOMETRY}
${DRAW}
const menu = P.menu || [];
const g = geometry(menu, P.x, P.y, -1);
const target = P.index >= 0 ? rowCentre(menu, P.index, P.y) : P.y + 120;
const pick = () => dw("mouse:down:" + P.x + "," + P.y + ",1,${CTRL}").then(() => dw("mouse:up:" + P.x + "," + P.y + ",1,${CTRL}"));
return drawOnly(640, 520, 16).then(() => sleep(600))
  .then(() => drawOnly(P.x, P.y, 800)).then(() => sleep(250))
  .then(() => { mark("go"); mark("⌃-click"); events.push({ t: Date.now(), down: 1 }); return sleep(90); })
  .then(() => { events.push({ t: Date.now(), up: 1 }); events.push({ t: Date.now(), menu: "open", geometry: g, open: -1 }); return sleep(1500); })
  .then(() => drawOnly(P.x + 70, target, 700)).then(() => sleep(1100))
  .then(() => P.index >= 0 ? drawClick() : null)
  .then(() => { events.push({ t: Date.now(), menu: "close" }); return P.index >= 0 ? pick() : null; })
  .then(() => sleep(700))
  .then(() => { say(P.index >= 0 ? "Sleep Tab: the tab is asleep" : "No Sleep Tab in the menu", P.index >= 0 ? "good" : "bad"); return sleep(2800); })
  .then(() => done({ items: menu.map((i) => i.title ?? i.label ?? (i.separator ? "—" : "?")) }));`,
  tail: 500,
};
