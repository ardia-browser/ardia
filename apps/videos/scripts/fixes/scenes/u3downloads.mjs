export default {
  session: "session-0247n3-downloads.json",
  switches: ["--unsafely-treat-insecure-origin-as-secure=http://files.example"],
  setup: `return dw("fakeActiveClicks").then(() => sleep(2500)).then(() => done());`,
  act: `const row = (i) => [410, 141 + i * 68];
const count = () => (st().downloads || []).length;
const panel = () => !!st().windowUi?.[W]?.downloadsOpen;
const results = [];
const say = (text, tone, at) => events.push({ t: at, callout: { text, tone } });
const get = (i) => {
  const before = count(), wasOpen = panel();
  return move(...row(i), 700).then(() => sleep(300)).then(() => { const at = Date.now(); return click().then(() => sleep(900)).then(() => {
    const now = count(), open = panel();
    const started = now > before;
    results.push({ started, open, wasOpen });
    if (!started) say(wasOpen ? "Click swallowed: it only closed the panel" : "Click missed", "bad", at + 250);
    else if (open) say("File " + now + " started · panel popped open", "bad", at + 250);
    else say("File " + now + " started", "good", at + 250);
  }); });
};
return at(560, 440).then(() => sleep(600))
  .then(() => { mark("go"); return get(0); }).then(() => sleep(1500))
  .then(() => get(1)).then(() => sleep(1500))
  .then(() => get(2)).then(() => sleep(1400))
  .then(() => { const n = count(); say(n + " of 3 downloading", n === 3 ? "good" : "bad", Date.now()); return move(560, 440, 700); }).then(() => sleep(2200))
  .then(() => done({ results, downloads: count() }));`,
  tail: 500,
};
