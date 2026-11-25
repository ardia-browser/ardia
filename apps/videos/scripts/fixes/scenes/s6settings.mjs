import { DRAW, windowBounds } from "./_47n6.mjs";

const PANE_X = 96;
const ROWS = { before: { first: 105, last: 555, tabs: 225, appearance: 255 }, after: { first: 105, last: 343, tabs: 173, appearance: 207 } };

export default {
  session: "session-0247n6-settings.json",
  setup: `st().updateSettings({ showAdvancedSettings: true }); return sleep(2000).then(() => { ac.openSettings("general"); return sleep(2500); }).then(() => done());`,
  async prepare(instance, side) {
    const all = windowBounds(instance.pid);
    const main = all.filter((w) => w.name !== "Settings").sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const settings = all.find((w) => w.name === "Settings");
    if (!main || !settings) throw new Error(`s6settings ${side}: windows were ${JSON.stringify(all)}`);
    return { ox: settings.x - main.x, oy: settings.y - main.y, rows: ROWS[side], settings, main };
  },
  act: `${DRAW}
const X = P.ox + ${PANE_X};
const Y = (name) => P.oy + P.rows[name];
const open = (pane) => drawClick().then(() => { ac.openSettings(pane); });
return drawOnly(P.ox + 560, P.oy + 520, 16).then(() => sleep(900))
  .then(() => drawOnly(X, Y("first"), 700)).then(() => sleep(300))
  .then(() => { mark("go"); return drawOnly(X, Y("last"), 2200); }).then(() => sleep(900))
  .then(() => drawOnly(X, Y("tabs"), 700)).then(() => sleep(250)).then(() => open("tabs")).then(() => sleep(2600))
  .then(() => drawOnly(X, Y("appearance"), 500)).then(() => sleep(250)).then(() => open("appearance")).then(() => sleep(2600))
  .then(() => done({ offset: [P.ox, P.oy] }));`,
  tail: 500,
};
