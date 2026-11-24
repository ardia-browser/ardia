import { rowCentre } from "./_47n6.mjs";

const BUSY = 1500;

export default {
  session: "session-0247n6-tabs.json",
  setup: `st().activate("t2"); return sleep(2500).then(() => { st().activate("t1"); return sleep(1200); }).then(() => key("⌘T", CMD, "t", 17)).then(() => sleep(1800)).then(() => done());`,
  prepare: (instance) => rowCentre(instance, "t2"),
  act: `return at(640, 560).then(() => sleep(700)).then(() => move(P.x, P.y, 800)).then(() => sleep(400))
  .then(() => { mark("go"); return click(); }).then(() => sleep(120)).then(() => {
    const t0 = Date.now();
    events.push({ t: t0, busy: ${BUSY} });
    while (Date.now() < t0 + ${BUSY});
    events.push({ t: Date.now(), idle: 1 });
    return sleep(1800);
  }).then(() => done({ active: st().windows[W].activeTabIds.default }));`,
  tail: 500,
};
