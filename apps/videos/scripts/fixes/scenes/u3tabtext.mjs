import { applySettings } from "./_47n3.mjs";

export default {
  session: "session-0247n3-tabs.json",
  setup: `return sleep(2500).then(() => done());`,
  prepare: (instance, side) => applySettings(instance, "u3tabtext", side),
  act: `return at(700, 520).then(() => sleep(600))
  .then(() => { mark("go"); return sleep(3500); })
  .then(() => done({ settings: st().settings }));`,
  tail: 500,
};
