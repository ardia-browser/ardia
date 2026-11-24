import { rowCentre } from "./_47n6.mjs";

const BUSY = 2000;

export default {
  session: "session-0247n6-tabs.json",
  setup: `st().activate("t2"); return sleep(2500).then(() => { st().activate("t1"); return sleep(1500); }).then(() => done());`,
  prepare: (instance) => rowCentre(instance, "t2"),
  act: `return mainWindow().then((n) => at(640, 520).then(() => sleep(600)).then(() => move(P.x, P.y, 800)).then(() => sleep(500)).then(() => {
  const t0 = Date.now();
  events.push({ t: t0, mark: "go" }, { t: t0, busy: ${BUSY} }, { t: t0 + 20, down: 1 }, { t: t0 + 110, up: 1 });
  ac.engine.call("windows.dev", { window: n, action: "mouse:down:" + P.x + "," + P.y });
  ac.engine.call("windows.dev", { window: n, action: "mouse:up:" + P.x + "," + P.y });
  while (Date.now() < t0 + ${BUSY});
  events.push({ t: Date.now(), idle: 1 });
  return sleep(1800);
})).then(() => done({ active: st().windows[W].activeTabIds.default }));`,
  tail: 500,
};
