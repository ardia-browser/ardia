import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { turboModules } from "../test-native/reactNative.ts";

turboModules.ArdiaEngineHost = { available: () => true, hostCall: async () => JSON.stringify({ ok: true }), engineCall: async () => "{}" };

const repo = new URL("../../../../", import.meta.url);
const { meadowPageConfig, meadowPageUrl, base64InThrees, meadowScriptsCode } = await import("../../../../packages/expo-windows/src/meadow/pageUrl.ts");
const { startMeadowSession, MEADOW_READY_LIMIT_MS, MEADOW_POLL_MS } = await import("../../../../packages/expo-windows/src/meadow/session.ts");
const { MEADOW_PAGE_BODY, MEADOW_PAGE_HEAD, MEADOW_PAGE_SCRIPT, MEADOW_POSTERS } = await import("../../../../packages/shaders/windows/meadow/page.ts");
const { MEADOW_PAGE_CONFIG_ID } = await import("../../../../packages/shaders/src/meadowPage/config.ts");
const { meadowIntroFor } = await import("../components/onboarding/introPage.ts");
const { INTRO_COPY, INTRO_LOOK } = await import("../components/onboarding/introCopy.ts");
const { INTRO_CUES, WORDMARK, LETTER, TAGLINE, EXIT } = await import("../components/onboarding/introCues.ts");

const colors = { background: "#FFFFFF", noThanksBorder: "rgba(0,0,0,0.1)", noThanksText: "rgba(0,0,0,0.5)", outlinedHover: "rgba(0,0,0,0.03)" };
const intro = meadowIntroFor({ colors, muted: false, startedAt: 1_000_000 });
const decode = (base64) => Buffer.from(base64, "base64").toString("utf8");
const pageOf = (url) => {
  const [start, hash] = url.split("#");
  assert.ok(start.startsWith("data:text/html;base64,"));
  return { html: decode(start.slice("data:text/html;base64,".length)), hash };
};
const configIn = (html) => JSON.parse(html.match(new RegExp(`<script type="application/json" id="${MEADOW_PAGE_CONFIG_ID}">(.*?)</script>`))[1]);

test("the page is the bundled meadow with the app's own intro values in its head", () => {
  const { html, hash } = pageOf(meadowPageUrl(intro, false, 16 / 10));
  assert.equal(hash, "day");
  assert.ok(html.startsWith(decode(MEADOW_PAGE_HEAD)), "the bundled head comes first");
  assert.ok(html.endsWith(decode(MEADOW_PAGE_BODY)), "the bundled body comes last");
  assert.deepEqual(configIn(html), JSON.parse(JSON.stringify(meadowPageConfig(intro, false))));
  assert.equal(configIn(html).intro.tagline, INTRO_COPY.tagline);
  assert.equal(configIn(html).intro.wordmark, WORDMARK);
  assert.match(configIn(html).muteIcons.playing, /^<svg /);
  assert.match(configIn(html).muteIcons.muted, /^<svg /);
  const poster = MEADOW_POSTERS.find((p) => p.file === "dawn-laptop-1917.webp");
  assert.ok(html.includes(`url(${poster.uri}) 50% ${poster.horizon * 100}% / cover no-repeat`), "the dawn poster nearest 16:10 is the first paint");
  assert.ok(html.includes(`html{background:${colors.background}}`), "the page's background is the intro's, never black or white of its own");
});

test("at night the page opens on #night with no poster", () => {
  const { html, hash } = pageOf(meadowPageUrl(intro, true, 16 / 9));
  assert.equal(hash, "night");
  assert.ok(!html.includes("data:image/webp"));
  assert.equal(configIn(html).night, true);
});

test("the config can't close its script tag", () => {
  const { html } = pageOf(meadowPageUrl({ ...intro, tagline: "</script><b>" }, false, 1));
  assert.equal(configIn(html).intro.tagline, "</script><b>");
  assert.ok(!html.includes("</script><b>"));
});

test("base64InThrees pads UTF-8 to whole groups, so the halves join without encoding the page again", () => {
  for (const text of ["", "a", "ab", "abc", "é", "✓ done"]) {
    const encoded = base64InThrees(text);
    assert.ok(!encoded.includes("="));
    assert.equal(decode(encoded).trimEnd(), text.trimEnd());
  }
  assert.equal(Buffer.from(MEADOW_PAGE_HEAD, "base64").length % 3, 0);
  assert.equal(Buffer.from(MEADOW_PAGE_BODY, "base64").length % 3, 0);
});

test("one source: the page and its shim carry none of the intro's words, cues or look of their own", () => {
  const shim = readFileSync(new URL("packages/shaders/src/meadowPage/shim.ts", repo), "utf8");
  const markup = decode(MEADOW_PAGE_HEAD) + decode(MEADOW_PAGE_BODY);
  const bundled = markup + MEADOW_PAGE_SCRIPT;
  assert.ok(!markup.includes("<script"), "the page opens with no scripts; the app adds them");
  for (const words of [WORDMARK, ...Object.values(INTRO_COPY)]) {
    assert.ok(!shim.includes(words), `the shim has its own "${words}"`);
    assert.ok(!bundled.includes(words), `the bundled page has its own "${words}"`);
  }
  const seconds = [INTRO_CUES.icon, INTRO_CUES.letters, INTRO_CUES.letterStep, LETTER, TAGLINE, EXIT];
  const milliseconds = [...seconds, INTRO_CUES.tagline, INTRO_CUES.exit, INTRO_CUES.end].map((s) => Math.round(s * 1000));
  const look = Object.values(INTRO_LOOK);
  for (const number of new Set([...seconds, ...milliseconds, ...look])) {
    assert.ok(!new RegExp(`(?<![\\w.])${String(number).replace(".", "\\.")}(?![\\w.])`).test(shim), `the shim has its own ${number}`);
  }
  assert.ok(!/class="hero-title">[^<]/.test(markup), "the bundled title is empty: the shim fills it from the app's config");
});

test("the page's icon is the app's icon file that the intro shows", () => {
  const icon = readFileSync(new URL("apps/browser/assets/app-icon.png", repo)).toString("base64");
  assert.ok(MEADOW_PAGE_SCRIPT.includes(`data:image/png;base64,${icon}`));
  assert.match(readFileSync(new URL("apps/browser/src/components/onboarding/Intro.tsx", repo), "utf8"), /const ICON = require\("\.\.\/\.\.\/\.\.\/assets\/app-icon\.png"\);/);
});

function fakePage() {
  let now = 0;
  const timers = [];
  const reports = [];
  const page = {
    told: [],
    tones: [],
    ran: [],
    logs: [],
    closed: 0,
    shown: 0,
    injected: 0,
    boot: [],
    report(states, frames = 0, ms = 0) {
      reports.push(JSON.stringify({ states, frames, ms }));
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.live && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every;
        else due.live = false;
        due.run();
        await new Promise((done) => setImmediate(done));
      }
      now = until;
      await new Promise((done) => setImmediate(done));
    },
  };
  const deps = {
    now: () => now,
    later(ms, run) {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => (timer.live = false);
    },
    every(ms, run) {
      const timer = { at: now + ms, run, live: true, every: ms };
      timers.push(timer);
      return () => (timer.live = false);
    },
    evaluate: async (code) => {
      if (code === meadowScriptsCode()) return (page.injected += 1), "true";
      if (page.boot.length) return JSON.stringify({ booted: page.boot.shift() });
      return reports.shift() ?? JSON.stringify({ states: [], frames: 0, ms: 0 });
    },
    show: () => void (page.shown += 1),
    run: (code) => page.ran.push(code),
    close: async () => void (page.closed += 1),
    tell: (event) => page.told.push(event),
    tone: (tone) => page.tones.push(tone),
    log: (line) => page.logs.push(line),
  };
  return { page, deps };
}

const URL_OF_PAGE = "data:text/html;base64,AAAA#day";
const startedNow = { ...intro, startedAt: 0 };

test("ready makes the scene live, tones reach the app, and the page closes when the exit has faded it out", async () => {
  const { page, deps } = fakePage();
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  page.report([{ state: "ready", at: 1 }, { state: "tone", tone: "dark", halo: 0.4 }]);
  await page.advance(MEADOW_POLL_MS);
  assert.equal(session.phase(), "live");
  assert.deepEqual(page.told, [{ kind: "live", firstFrameMs: MEADOW_POLL_MS }]);
  assert.deepEqual(page.tones, [{ tone: "dark", halo: 0.4 }]);
  page.report([], 200, 3000);
  const closesAt = intro.motion.exit.delay + intro.motion.holds.exit;
  await page.advance(closesAt - MEADOW_POLL_MS - 1);
  assert.equal(page.closed, 0, "the page stays until the exit reaches the point where the intro starts to fade");
  await page.advance(2);
  await page.advance(1);
  assert.equal(page.closed, 1);
  assert.equal(session.phase(), "closed");
  assert.ok(page.logs.includes("[ardia windows] meadow page created"));
  assert.ok(page.logs.some((line) => /^\[ardia windows\] meadow \d+ frames in \d+ ms$/.test(line)));
  assert.ok(page.logs.some((line) => line.startsWith("[ardia windows] meadow page closed after") && line.endsWith("(finished)")));
});

test("the exit's hold is where the RN intro's opacity starts to fall", () => {
  assert.ok(intro.motion.holds.exit > 0 && intro.motion.holds.exit < intro.motion.exit.duration);
  assert.ok(intro.motion.holds.skip > 0 && intro.motion.holds.skip < intro.motion.skip.duration);
});

test("no first frame within the limit falls back to the poster and closes the page", async () => {
  const { page, deps } = fakePage();
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  await page.advance(MEADOW_READY_LIMIT_MS - 1);
  assert.equal(session.phase(), "opening");
  assert.equal(page.shown, 1);
  await page.advance(1);
  assert.equal(session.phase(), "fallen");
  assert.deepEqual(page.told, [{ kind: "fallback", reason: "no first frame" }]);
  assert.equal(page.closed, 1);
  page.report([{ state: "ready", at: 1 }]);
  await page.advance(MEADOW_POLL_MS * 3);
  assert.equal(page.told.length, 1, "a late ready changes nothing");
});

for (const [name, act, reason] of [
  ["a failed scene", (page) => page.report([{ state: "failed" }]), "the scene failed"],
  ["a crash", (_page, session) => session.pageEvent("crashed", {}), "the page crashed"],
  ["a load error", (_page, session) => session.pageEvent("loadError", { code: -2 }), "the page did not load"],
  ["a navigation away", (_page, session) => session.pageEvent("navigation", { url: "https://example.com/" }), "the page navigated away"],
]) {
  test(`${name} after the scene went live falls back and closes the page`, async () => {
    const { page, deps } = fakePage();
    const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
    page.report([{ state: "ready", at: 1 }]);
    await page.advance(MEADOW_POLL_MS);
    act(page, session);
    await page.advance(MEADOW_POLL_MS);
    assert.deepEqual(page.told.at(-1), { kind: "fallback", reason });
    assert.equal(session.phase(), "fallen");
    assert.equal(page.closed, 1);
  });
}

test("navigations within the page's own document are not away", async () => {
  const { page, deps } = fakePage();
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  for (const url of ["", "about:blank", URL_OF_PAGE, "data:text/html;base64,AAAA#night"]) session.pageEvent("navigation", { url });
  session.pageEvent("favicon", {});
  await page.advance(MEADOW_POLL_MS);
  assert.equal(session.phase(), "opening");
  assert.equal(page.closed, 0);
});

test("the page stays hidden until its scripts are in and have drawn the title, then shows once", async () => {
  const { page, deps } = fakePage();
  page.boot.push(false, true, true);
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  await page.advance(MEADOW_POLL_MS);
  assert.deepEqual([page.injected, page.shown, session.phase()], [0, 0, "booting"], "nothing to add scripts to before the page committed");
  await page.advance(MEADOW_POLL_MS);
  assert.deepEqual([page.injected, page.shown], [1, 0]);
  await page.advance(MEADOW_POLL_MS);
  assert.deepEqual([page.injected, page.shown], [1, 0], "the scripts go in once");
  await page.advance(MEADOW_POLL_MS * 3);
  assert.deepEqual([page.injected, page.shown, session.phase()], [1, 1, "opening"]);
});

test("scripts that do not run fall back at once", async () => {
  const { page, deps } = fakePage();
  page.boot.push(true);
  const evaluate = deps.evaluate;
  deps.evaluate = async (code) => (code === meadowScriptsCode() ? "false" : evaluate(code));
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  await page.advance(MEADOW_POLL_MS);
  assert.equal(session.phase(), "fallen");
  assert.deepEqual(page.told, [{ kind: "fallback", reason: "the scene's scripts did not run" }]);
  assert.equal(page.shown, 0, "a page that never drew is never shown");
});

test("the scripts are added as one inline script, so they run in the page's own scope like the Mac's", () => {
  const code = meadowScriptsCode();
  assert.ok(code.startsWith("if (!window.ardiaIntro) { const script = document.createElement(\"script\"); script.textContent = "));
  assert.ok(code.includes(JSON.stringify(MEADOW_PAGE_SCRIPT)));
  assert.ok(code.endsWith(`post("result", JSON.stringify(!!window.ardiaIntro));`));
});

test("Skip in the page skips the intro and closes the page once the skip has faded it", async () => {
  const { page, deps } = fakePage();
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  page.report([{ state: "ready", at: 1 }]);
  await page.advance(MEADOW_POLL_MS);
  page.report([{ state: "skip" }]);
  await page.advance(MEADOW_POLL_MS);
  assert.deepEqual(page.told.at(-1), { kind: "skip" });
  await page.advance(intro.motion.holds.skip - 1);
  assert.equal(page.closed, 0);
  await page.advance(2);
  await page.advance(1);
  assert.equal(page.closed, 1);
  assert.ok(page.logs.at(-1).endsWith("(skipped)"));
});

test("Mute in the page reaches the app, and the app's mute and night reach the page", async () => {
  const { page, deps } = fakePage();
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  session.setNight(true);
  assert.deepEqual(page.ran, [], "night waits for the first frame");
  page.report([{ state: "ready", at: 1 }, { state: "mute", muted: true }]);
  await page.advance(MEADOW_POLL_MS);
  assert.deepEqual(page.told.at(-1), { kind: "mute", muted: true });
  assert.deepEqual(page.ran, ["meadowNight(true)"]);
  session.setNight(true);
  assert.equal(page.ran.length, 1);
  session.setMuted(false);
  assert.equal(page.ran.at(-1), "window.ardiaIntro && window.ardiaIntro.muted(false)");
});

test("an intro that ends first stops the session without closing twice", async () => {
  const { page, deps } = fakePage();
  const session = startMeadowSession(startedNow, false, URL_OF_PAGE, deps);
  session.end();
  await page.advance(MEADOW_READY_LIMIT_MS * 2);
  assert.equal(session.phase(), "closed");
  assert.deepEqual(page.told, []);
  assert.equal(page.closed, 0, "unmounting the page view closes it");
});
