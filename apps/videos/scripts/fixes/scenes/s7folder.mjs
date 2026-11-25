import { PRESS, measure } from "./_47n7.mjs";

export default {
  session: "session-0247n7-press.json",
  env: { FIXES_SELFREC_CROP: "0,140,262,340" },
  minWidth: 250,
  setup: `return sleep(2500).then(() => done());`,
  prepare: (instance) => measure(instance, ["gtrip", "gfood"]),
  act: `${PRESS}
const open = (id, key) => measureRow(id).then((r) => pressAt(r, 120, key)).then(() => sleep(500));
const measureRow = (id) => ac.sidebarRows.measureRow(W, id).then((r) => ({ x: Math.round(r.x + 70), y: Math.round(r.y + r.height / 2) }));
return at(640, 520).then(() => sleep(500)).then(() => move(140, P.gtrip.y - 30, 600)).then(() => sleep(300))
  .then(() => { mark("go"); return open("gtrip", "opened"); })
  .then(() => open("gtrip", "closed"))
  .then(() => open("gfood"))
  .then(() => open("gfood"))
  .then(() => move(640, 420, 600)).then(() => sleep(400))
  .then(() => done({ groups: Object.values(st().groups || {}).map((g) => [g.id, g.collapsed]) }));`,
  tail: 500,
};
