import { applySettings } from "./_47n3.mjs";

export default {
  session: "session-0247n3-tabs.json",
  setup: `return sleep(2500).then(() => done());`,
  prepare: (instance, side) => applySettings(instance, "u3tabpopup", side),
  act: `return at(640, 520).then(() => sleep(600))
  .then(() => move(120, 203, 800)).then(() => { mark("go"); return sleep(1600); })
  .then(() => move(120, 240, 350)).then(() => sleep(1300))
  .then(() => move(120, 277, 350)).then(() => sleep(1300))
  .then(() => move(120, 314, 350)).then(() => sleep(1300))
  .then(() => move(640, 420, 700)).then(() => sleep(900))
  .then(() => done());`,
  tail: 500,
};
