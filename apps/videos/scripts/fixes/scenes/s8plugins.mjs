import { windowBounds } from "./_47n6.mjs";

export default {
  session: "session-0247n8-settings.json",
  setup: `ac.openSettings("plugins"); return sleep(4000).then(() => done());`,
  async prepare(instance, side) {
    const all = windowBounds(instance.pid);
    const main = all.filter((w) => w.name !== "Settings").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const settings = all.find((w) => w.name === "Settings");
    if (!main || !settings) throw new Error(`s8plugins ${side}: windows were ${JSON.stringify(all)}`);
    return { ox: settings.x - main.x, oy: settings.y - main.y, settings, main };
  },
  act: `return sleep(300).then(() => { mark("go"); return sleep(4500); }).then(() => done({ offset: [P.ox, P.oy] }));`,
  tail: 500,
};
