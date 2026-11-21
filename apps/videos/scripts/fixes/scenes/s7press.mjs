import { PRESS, measure } from "./_47n7.mjs";

export default {
  session: "session-0247n7-press.json",
  env: { FIXES_SELFREC_CROP: "0,0,262,420" },
  minWidth: 250,
  setup: `return sleep(2500).then(() => done());`,
  prepare: (instance) => measure(instance, ["t3", "t2", "p2", "p3"]),
  act: `${PRESS}
return at(640, 520).then(() => sleep(500)).then(() => move(130, P.t3.y + 40, 600)).then(() => sleep(300))
  .then(() => { mark("go"); return pressAt(P.t3, 240, "row"); })
  .then(() => pressAt(P.t2, 240))
  .then(() => pressAt(P.p2, 240, "tile"))
  .then(() => pressAt(P.p3, 240))
  .then(() => move(640, 420, 600)).then(() => sleep(400))
  .then(() => done({ active: st().windows[W].activeTabIds.default }));`,
  tail: 500,
};
