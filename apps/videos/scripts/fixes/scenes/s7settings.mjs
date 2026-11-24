import { windowBounds } from "./_47n6.mjs";

export default {
  session: "session-0247n7-settings.json",
  setup: `st().updateSettings({ showAdvancedSettings: true }); return sleep(2000).then(() => { ac.openSettings("plugins"); return sleep(3500); }).then(() => done());`,
  async prepare(instance, side) {
    const all = windowBounds(instance.pid);
    const main = all.filter((w) => w.name !== "Settings").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const settings = all.find((w) => w.name === "Settings");
    if (!main || !settings) throw new Error(`s7settings ${side}: windows were ${JSON.stringify(all)}`);
    return { ox: settings.x - main.x, oy: settings.y - main.y, settings, main };
  },
  act: `return sleep(300).then(() => { mark("go"); return sleep(4500); })
  .then(() => { ac.openSettings("advanced"); mark("advanced"); return sleep(1200); })
  .then(() => { ac.settingsSearch.revealSetting({ id: "advanced.ardiaCommand", pane: "advanced", section: "Command line and automation" }, "click", 0); return sleep(4500); })
  .then(() => done({ offset: [P.ox, P.oy] }));`,
  tail: 500,
};
