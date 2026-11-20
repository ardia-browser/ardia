import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launch, reporter } from "../../../scripts/lib/instance.mjs";

const HELP = `usage: node settings-reveal-test.mjs <Debug Ardia.app> [--delay MS] [--keep]

Settings search reveals a row once it mounts, however long its pane's data takes. Each check runs in a fresh hidden
instance whose default-browser query answers only after --delay ms (4000 by default, well past the pane's 250 ms
hold), searches "default browser" from another pane, and checks that:
  - the reveal waits for the row and then scrolls it into view and highlights it, instead of giving up;
  - going to another pane before the row mounts cancels the reveal, so nothing jumps or flashes later;
  - pressing Back, or opening a detail page in the same pane, while the destination still loads (Settings keeps the
    old pane up for 250 ms) cancels the reveal too, even when the row mounts on the old pane during that hold. Each of
    these leaves only while the reveal is still pending and the row hasn't flashed, retrying up to 3 times, so a slow
    run can't pass without exercising the cancellation.`;

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { delay: { type: "string" }, keep: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
if (flags.help || !positionals[0]) {
  console.log(HELP);
  process.exit(flags.help ? 0 : 2);
}
const app = resolve(positionals[0]);
const DELAY = Number(flags.delay ?? 4000);
const TARGET = "general.defaultBrowser";

const scratch = mkdtempSync(join(tmpdir(), "ac-settings-reveal-"));
const rep = reporter(join(scratch, "settings-reveal-test.log"), { name: "settings-reveal-test" });

const SEARCH = (leaveFor) => `
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const s = ac.settingsSearch;
const query = ac.settingsData.defaultBrowser;
query.fetch = () => new Promise((done) => setTimeout(() => done(false), ${DELAY}));
const seen = [];
const stop = s.useSettingsSearch.subscribe((now, before) => {
  if (now.reveal !== before.reveal) seen.push("reveal:" + (now.reveal ? now.reveal.id : ""));
  if (now.flash !== before.flash) seen.push("flash:" + (now.flash ? now.flash.id : ""));
});
ac.openSettings("advanced");
return wait(1200)
  .then(() => s.setSettingsQuery("default browser"))
  .then(() => wait(400))
  .then(() => ${leaveFor ? `{ s.setSettingsQuery(""); ac.openSettings(${JSON.stringify(leaveFor)}); }` : "null"})
  .then(() => wait(${DELAY} + 1200))
  .then(() => new Promise((done) => {
    const view = s.anchorView(${JSON.stringify(TARGET)});
    if (!view) return done(null);
    view.measureInWindow((x, y, w, h) => done([x, y, w, h]));
  }))
  .then((frame) => {
    stop();
    return { seen, frame, nav: s.useSettingsSearch.getState().reveal };
  });`;

const RACE_ATTEMPTS = 3;

const RACE = (leave) => `
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const s = ac.settingsSearch;
const nav = ac.settingsNav;
const t0 = Date.now();
const RESOLVES_AT = 1800;
ac.settingsData.defaultBrowser.fetch = () => new Promise((done) => setTimeout(() => done(false), Math.max(0, t0 + RESOLVES_AT - Date.now())));
ac.settingsData.appIconChoices.fetch = () => new Promise((done) => setTimeout(() => done({ icons: [], current: null }), 4000));
const seen = [];
let navigating = false;
const at = () => Date.now() - t0;
const stop = s.useSettingsSearch.subscribe((now, before) => {
  if (now.reveal !== before.reveal) seen.push({ at: at(), duringNav: navigating, what: "reveal:" + (now.reveal ? now.reveal.id + "#" + now.reveal.request : "") });
  if (now.flash !== before.flash) seen.push({ at: at(), duringNav: navigating, what: "flash:" + (now.flash ? now.flash.id : "") });
});
ac.openSettings("appearance");
let leftAt = 0;
return wait(900)
  .then(() => s.revealSetting({ id: ${JSON.stringify(TARGET)}, pane: "general", section: "Default browser" }, "click", 0))
  .then(() => wait(RESOLVES_AT - 900 - 150))
  .then(() => {
    const before = s.useSettingsSearch.getState().reveal;
    const flashedEarly = seen.some((e) => e.what === "flash:" + ${JSON.stringify(TARGET)});
    if (!before || before.id !== ${JSON.stringify(TARGET)} || flashedEarly) {
      stop();
      return { armed: false, seen, pending: before };
    }
    const checked = { field: "useSettingsSearch.reveal", id: before.id, request: before.request };
    const cur = nav.getState();
    const here = { pane: cur.pane, profileId: cur.profileId, detail: cur.detail };
    leftAt = at();
    navigating = true;
    ${leave === "back"
      ? `const prev = cur.back[cur.back.length - 1]; nav.setState({ ...prev, back: cur.back.slice(0, -1), forward: [here, ...cur.forward] });`
      : `nav.setState({ pane: "general", profileId: null, detail: "filterLists", back: [...cur.back, here], forward: [] });`}
    navigating = false;
    const navReturnedAt = at();
    return wait(1500).then(() => {
      stop();
      const n = nav.getState();
      return { armed: true, checked, seen, leftAt, navReturnedAt, nav: { pane: n.pane, detail: n.detail }, pending: s.useSettingsSearch.getState().reveal };
    });
  });`;

async function inFreshInstance(name, body) {
  const data = join(scratch, name);
  let instance;
  try {
    instance = await launch(app, { data, onboarded: true, ready: "return !!ac.openSettings" });
    return await instance.eval(body, { timeout: 60000 });
  } finally {
    if (!flags.keep) await instance?.quit();
  }
}

await rep.check(`a reveal waits for a row whose data takes ${DELAY} ms`, async () => {
  const out = await inFreshInstance("waits", SEARCH(null));
  if (out.seen.includes("flash:")) throw new Error(`the reveal gave up before the row mounted: ${out.seen.join(" ")}`);
  if (!out.seen.includes(`flash:${TARGET}`)) throw new Error(`the row was never highlighted: ${out.seen.join(" ")}`);
  if (!out.frame) throw new Error("the row never mounted");
  const [, y, , h] = out.frame;
  if (!(y >= 52 && y + h <= 640)) throw new Error(`row isn't in view: y ${y}, height ${h}`);
  return `${out.seen.join(" ")}, row at y ${y}`;
});

await rep.check("leaving for another pane cancels a pending reveal", async () => {
  const out = await inFreshInstance("cancels", SEARCH("tabs"));
  const late = out.seen.filter((e) => e.startsWith("flash:"));
  if (late.length) throw new Error(`a cancelled reveal still flashed: ${out.seen.join(" ")}`);
  if (out.nav) throw new Error(`a reveal is still pending: ${JSON.stringify(out.nav)}`);
  return out.seen.join(" ") || "nothing revealed";
});

for (const [leave, label] of [["back", "pressing Back"], ["detail", "opening a detail page in the same pane"]]) {
  await rep.check(`${label} while the destination loads cancels the reveal`, async () => {
    let out;
    for (let attempt = 1; attempt <= RACE_ATTEMPTS && !out?.armed; attempt++) out = await inFreshInstance(`${leave}-${attempt}`, RACE(leave));
    if (!out.armed) throw new Error(`useSettingsSearch.reveal wasn't still pending for ${TARGET} when it was time to leave, in ${RACE_ATTEMPTS} tries, so cancellation was never exercised: ${out.seen.map((e) => `${e.what}@${e.at}`).join(" ")}`);
    const late = out.seen.filter((e) => e.at >= out.leftAt && e.what === `flash:${TARGET}`);
    if (late.length) throw new Error(`the old pane's row flashed ${late[0].at - out.leftAt} ms after leaving: ${out.seen.map((e) => `${e.what}@${e.at}`).join(" ")}`);
    if (out.pending) throw new Error(`a reveal is still pending: ${JSON.stringify(out.pending)}`);
    const events = out.seen.map((e) => `${e.what}@${e.at}${e.duringNav ? " (during navigation)" : ""}`).join(" ");
    return `${out.checked.field} #${out.checked.request} pending for ${out.checked.id} when leaving at ${out.leftAt} (navigation returned at ${out.navReturnedAt}); ${events}; now on ${out.nav.pane}${out.nav.detail ? ` › ${out.nav.detail}` : ""}`;
  });
}

const passed = rep.summary();
if (passed && !flags.keep) rmSync(scratch, { recursive: true, force: true });
else rep.say(`kept ${scratch}`);
process.exit(passed ? 0 : 1);
