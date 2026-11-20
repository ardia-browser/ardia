import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POINT = [130, 460];
const PILL = [131, 70];

export default {
  session: "session-0247n6-many.json",
  dylibs: ["scroll"],
  boot: 8000,
  setup: `return sleep(2500).then(() => done({ tabs: st().windows[W].tabIds.length }));`,
  async external(instance) {
    const outbox = join(instance.data, "film-scroll-done.json");
    rmSync(outbox, { force: true });
    await sleep(2600);
    writeFileSync(join(instance.data, "film-scroll.json"), JSON.stringify({ id: 1, gesture: "pan", x: POINT[0], y: POINT[1], rate: 120 }));
    for (const end = Date.now() + 15000; Date.now() < end && !existsSync(outbox); await sleep(30));
    const done = existsSync(outbox) ? JSON.parse(readFileSync(outbox, "utf8")) : {};
    return [{ t: done.startMs ?? Date.now(), scroll: "start" }, { t: done.endMs ?? Date.now(), scroll: "end" }];
  },
  act: `return at(640, 520).then(() => sleep(500))
  .then(() => move(${POINT[0]}, ${POINT[1]}, 700)).then(() => { mark("go"); return sleep(4600); })
  .then(() => move(${PILL[0]}, ${PILL[1]}, 700)).then(() => sleep(500))
  .then(() => SIDE === "after" ? click() : null).then(() => sleep(2600))
  .then(() => done({ active: st().windows[W].activeTabIds.default }));`,
  tail: 500,
};
