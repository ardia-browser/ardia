import { play, Script } from "../input.mjs";

const ADVANCED = [732, 278];
const FIELD = [380, 211];
const ADD = [591, 211];
const LIST = "https://small.oisd.nl";

export default {
  session: "session-customlists.json",
  minWidth: 800,
  setup: `ac.openSettings("privacy", null); return sleep(3000).then(() => done());`,
  external: async (instance, side) => {
    const s = new Script("Settings");
    s.move(520, 430).wait(900).move(...ADVANCED, 700).wait(250).mark("open").click().wait(1500);
    if (side === "after") {
      s.move(...FIELD, 600).wait(250).click().wait(450);
      s.text(LIST, 70).wait(500);
      s.move(...ADD, 500).wait(250).mark("go").click().wait(9000);
    } else {
      s.move(...FIELD, 600).wait(700).move(420, 330, 900).wait(800).move(420, 470, 900).wait(600).mark("go").wait(9000);
    }
    return play(instance, s);
  },
  act: `return sleep(17000).then(() => done());`,
  tail: 400,
};
