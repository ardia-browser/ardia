import { applySettings } from "./_47n3.mjs";

export default {
  session: "session-0247n3-hidden.json",
  setup: `return dw("fakeActiveClicks").then(() => sleep(2500)).then(() => done({ hidden: st().settings.autoHideTabs }));`,
  prepare: (instance, side) => applySettings(instance, "u3edgeoff", side),
  act: `return at(360, 300).then(() => sleep(700))
  .then(() => { mark("go"); return move(2, 300, 700); }).then(() => { mark("brush"); return sleep(2000); })
  .then(() => move(560, 330, 600)).then(() => sleep(1500))
  .then(() => key("⌘S", CMD, "s", 1)).then(() => sleep(2600))
  .then(() => done({ hidden: st().settings.autoHideTabs, window: st().windows[W].autoHideTabs ?? null }));`,
  tail: 500,
};
