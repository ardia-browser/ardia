import { play, Script } from "../input.mjs";
import { windowBounds } from "./_47n6.mjs";

const SEARCH = [107, 66];

export default {
  session: "session-0247n8-settings.json",
  setup: `ac.openSettings("general", null); return sleep(3500).then(() => done());`,
  async prepare(instance, side) {
    const all = windowBounds(instance.pid);
    const main = all.filter((w) => w.name !== "Settings").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const settings = all.find((w) => w.name === "Settings");
    if (!main || !settings) throw new Error(`s8keys ${side}: windows were ${JSON.stringify(all)}`);
    return { ox: settings.x - main.x, oy: settings.y - main.y, settings, main };
  },
  external: async (instance) => {
    const s = new Script("Settings");
    s.move(420, 330).wait(700).move(...SEARCH, 800).wait(250).mark("go").click().wait(500);
    s.text("cmd opt n", 170).wait(3600);
    return play(instance, s);
  },
  act: `return sleep(8200).then(() => done({ offset: [P.ox, P.oy] }));`,
  tail: 400,
};
