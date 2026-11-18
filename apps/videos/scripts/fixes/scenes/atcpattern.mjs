import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { play, Script } from "../input.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADD_RULE = [740, 155];
const LINKS = [362, 310];
const FIELD = [440, 325];
const OPEN_IN = [362, 359];
const ADD = [587, 431];
const TRY_FIELD = [517, 452];

const pick = (instance, id) => writeFileSync(join(instance.data, "menu.json.pick"), id);

function from([x, y]) {
  const s = new Script("Settings");
  return s.move(x, y);
}

async function drive(instance, side) {
  const events = [];
  const run = async (script) => events.push(...(await play(instance, script)));
  await run(new Script("Settings").move(560, 540).wait(500).move(...ADD_RULE, 800).wait(250).mark("go").click().wait(900).move(...LINKS, 600).wait(250));
  pick(instance, "pattern");
  await run(from(LINKS).click().wait(800).move(...FIELD, 450).wait(150).click().wait(300).text("*git*", 170).wait(500));
  await sleep(900);
  pick(instance, "work");
  await run(from(FIELD).move(...OPEN_IN, 500).wait(200).click().wait(800).move(...ADD, 650).wait(300).click().wait(1800));
  if (side === "after") {
    await run(from(ADD).move(...TRY_FIELD, 900).wait(200).click().wait(300).text("github.com/ardia", 90).wait(400));
    await sleep(3000);
  } else await sleep(4400);
  return events;
}

export default {
  session: "session-atc-pattern.json",
  minWidth: 800,
  env: { ARDIA_TEST: "appMenu" },
  setup: `ac.openSettings("airTraffic"); return sleep(2500).then(() => done());`,
  external: drive,
  act: `return sleep(1000).then(() => done());`,
  tail: 300,
};
