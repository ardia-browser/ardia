import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { meadowIntroFor } from "./introPage.ts";
import { EXIT, INTRO_CUES, LETTER, TAGLINE, WORDMARK } from "./introCues.ts";
import { INTRO_COPY } from "./introCopy.ts";
import { cssSpring, timeToReach } from "../ui/cssMotion.ts";

const colors = { background: "#000000", noThanksBorder: "a", noThanksText: "b", outlinedHover: "c" };
const ms = (s) => Math.round(s * 1000);

test("the page's timeline is the intro's own cues", () => {
  const intro = meadowIntroFor({ colors, muted: true, startedAt: 42 });
  assert.equal(intro.startedAt, 42);
  assert.equal(intro.muted, true);
  assert.equal(intro.motion.icon.delay, ms(INTRO_CUES.icon));
  assert.deepEqual(
    intro.motion.letters.map((m) => [m.delay, m.duration]),
    [...WORDMARK].map((_, i) => [ms(INTRO_CUES.letters + i * INTRO_CUES.letterStep), ms(LETTER)]),
  );
  assert.deepEqual([intro.motion.tagline.delay, intro.motion.tagline.duration], [ms(INTRO_CUES.tagline), ms(TAGLINE)]);
  assert.deepEqual([intro.motion.exit.delay, intro.motion.exit.duration], [ms(INTRO_CUES.exit), ms(EXIT)]);
  for (const m of [intro.motion.icon, intro.motion.tagline, intro.motion.exit, intro.motion.skip, ...intro.motion.letters]) assert.match(m.easing, /^linear\(0, .*, 1\)$/);
});

test("Intro.tsx holds no copy of the words the page shows", () => {
  const source = readFileSync(new URL("./Intro.tsx", import.meta.url), "utf8");
  for (const words of Object.values(INTRO_COPY)) assert.ok(!source.includes(`"${words}"`) && !source.includes(`>${words}<`), words);
});

test("a spring's CSS curve settles at 1 and its length is where the spring comes to rest", () => {
  const { duration, easing } = cssSpring({ stiffness: 246.74, damping: 26.7, mass: 1 });
  assert.ok(duration > 200 && duration < 2000, String(duration));
  const points = easing.slice("linear(".length, -1).split(", ").map(Number);
  assert.equal(points[0], 0);
  assert.equal(points.at(-1), 1);
  assert.ok(Math.max(...points) > 1, "a damping below 1 overshoots");
  assert.equal(timeToReach((t) => t, 0.6).toFixed(3), "0.600");
});

test("the page's text comes from the active theme: the default look hands over the old sizes and no face, a themed look its own", async () => {
  const { setActiveLook } = await import("../../lib/activeLook.ts");
  const { DEFAULT_LOOK } = await import("../../lib/themeLook.ts");
  const plain = meadowIntroFor({ colors, muted: false, startedAt: 0 }).type;
  assert.deepEqual(plain.wordmark, { fontSize: 64, fontWeight: "200", letterSpacing: -1.5 });
  assert.deepEqual(plain.tagline, { fontSize: 17, fontWeight: "300", letterSpacing: undefined });
  assert.equal(plain.button.fontFamily, undefined);
  const sizes = Object.fromEntries(Object.entries(DEFAULT_LOOK.sizes).map(([name, size]) => [name, size + 2]));
  setActiveLook({ ...DEFAULT_LOOK, family: "Mona Sans", sizes });
  try {
    const themed = meadowIntroFor({ colors, muted: false, startedAt: 0 }).type;
    assert.equal(themed.tagline.fontSize, 19);
    assert.equal(themed.tagline.fontFamily, "Mona Sans");
    assert.equal(themed.button.fontFamily, "Mona Sans");
    assert.equal(themed.button.fontSize, DEFAULT_LOOK.sizes.body + 2);
  } finally {
    setActiveLook(DEFAULT_LOOK);
  }
});
