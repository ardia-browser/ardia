import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resize(instance, w, h, ms) {
  const done = join(instance.data, "film-frame-done.txt");
  rmSync(done, { force: true });
  writeFileSync(join(instance.data, "film-frame.txt"), `${w},${h},${ms}`);
  for (const end = Date.now() + ms + 5000; Date.now() < end; await sleep(10)) if (existsSync(done)) return readFileSync(done, "utf8");
  throw new Error("frame.dylib never answered");
}

export default {
  session: "session-0247n8-strip.json",
  dylibs: ["frame"],
  minWidth: 1100,
  setup: `return sleep(3500).then(() => done({ layout: st().windows[W].tabLayout ?? st().settings.tabLayout }));`,
  external: async (instance) => {
    await sleep(1800);
    const events = [{ t: Date.now(), mark: "go" }];
    events.push({ t: Date.now(), mark: "narrow", answer: await resize(instance, 760, 560, 2400) });
    await sleep(3500);
    return events;
  },
  act: `return sleep(9000).then(() => done({ overflow: Object.keys(st().tabs).length }));`,
  tail: 500,
};
