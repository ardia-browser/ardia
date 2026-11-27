import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const copy = await import("./copy.ts");
const { copyWords: macWords } = await import("./copyWords.ts");
const { PHRASES_ONLY_WITH, platformWording, rewordInPlace } = await import("./platformWording.ts");
const { PLATFORM_TERMS: windowsTerms } = await import("../../lib/platformTerms.windows.ts");
const { PLATFORM_FEATURES: windowsFeatures } = await import("../../lib/platformFeatures.win.ts");
const { PLATFORM_TERMS: macTerms } = await import("../../lib/platformTerms.ts");
const { PLATFORM_FEATURES: macFeatures } = await import("../../lib/platformFeatures.ts");
const { windowsKeyText } = await import("../commands/windowsKeyText.ts");

const windowsWords = platformWording(windowsTerms, windowsFeatures, windowsKeyText);
const pairs = JSON.parse(readFileSync(new URL("./fixtures/whats-sent-windows-2026-11-14.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("./copy.ts", import.meta.url), "utf8");
const EXPORTS = ["SHARING_COPY", "WHATS_SENT", "IDENTITY_COPY", "LOCAL_COPY", "WATCH_COPY"];

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const field of Object.values(value)) strings(field, out);
  return out;
}

const live = strings(EXPORTS.map((name) => copy[name]));

test("the Mac's words are its source, byte for byte", () => {
  for (const [mac] of pairs) assert.equal(macWords(mac), mac);
  for (const text of live) assert.ok(source.includes(JSON.stringify(text)), `not a literal in copy.ts: ${text.slice(0, 80)}`);
});

test("the Mac's terms and features through the Windows rules change nothing", () => {
  const macThroughRules = platformWording(macTerms, macFeatures, (key) => key);
  for (const text of live) assert.equal(macThroughRules(text), text);
});

test("no Mac name, Mac-only phrase or key glyph is left in Windows's copy except those kept on purpose", () => {
  const windows = live.map(windowsWords);
  for (const text of windows) {
    assert.doesNotMatch(text, /\b(?:this|the) Mac\b|\bmacOS version\b|\bfrom the Dock\b|\bin Finder\b|[⌃⌥⇧⌘]/u, text);
    for (const phrase of Object.values(PHRASES_ONLY_WITH).flat()) assert.ok(!text.includes(phrase));
  }
  assert.ok(windows.some((text) => text.includes("whether macOS and Ardia agree")));
  assert.ok(windows.some((text) => text.includes("Dock icon clicks")));
});

test("each phrase a feature removes is still in the copy, so a reworded sentence fails here instead of leaking", () => {
  for (const phrase of Object.values(PHRASES_ONLY_WITH).flat()) assert.ok(live.some((text) => text.includes(phrase)), phrase);
});

const FREEZE_WORDING = [
  "stopped responding for a quarter of a second",
  "freeing its memory",
  "freezes for 0.4 seconds or more",
  "program addresses",
  "shared system code with that system code's build ID",
  "the last 20 times Ardia froze",
  "Copy Last Freeze",
];

test("Windows, which has no freeze watch, says nothing about freezes; the Mac says all of it", () => {
  const mac = live.join("\n");
  for (const said of FREEZE_WORDING) assert.ok(mac.includes(said), `the Mac says ${said}`);
  const windows = live.map(windowsWords).join("\n");
  for (const said of FREEZE_WORDING) assert.ok(!windows.includes(said), `Windows says ${said}`);
  assert.ok(windows.includes("with the largest slip in points"), "Windows keeps the sentence around the freeze phrase");
  assert.equal(windowsFeatures.freezeWatch, false);
});

test("Windows, whose crash reader sends none of the Mac's crash report details, doesn't say it does; the Mac does", () => {
  const [details] = [PHRASES_ONLY_WITH.crashReportDetails].flat();
  assert.match(details, /near address zero/);
  assert.ok(live.some((text) => text.includes(details)), "the Mac's What's Sent lists the crash report details");
  const windows = live.map(windowsWords).join("\n");
  for (const said of ["near address zero", "which kind of thread crashed", "whether it was the main queue"]) assert.ok(!windows.includes(said), `Windows says ${said}`);
  assert.ok(windows.includes("how the system ended it (its termination reason, like a signal or a code-signing kill)"), "Windows keeps the sentence around the details");
  assert.equal(windowsFeatures.crashReportDetails, false);
  assert.equal(macFeatures.crashReportDetails, true);
});

test("a feature phrase is removed even when a shorter feature phrase sits inside it or it spans quotes", () => {
  const words = platformWording(windowsTerms, windowsFeatures, windowsKeyText);
  const phrase = [PHRASES_ONLY_WITH.freezeWatch].flat()[0];
  assert.ok(phrase.includes("“system”") && phrase.includes(", the Mac's memory pressure"));
  assert.equal(words(`Memory use${phrase}. Never which page`), "Memory use. Never which page");
});

test("the rules touch only whole words outside quotes", () => {
  const cases = [
    ["Sent from this Macintosh and this MacBook", "Sent from this Macintosh and this MacBook"],
    ["the Mac's memory and the Mac", "the PC's memory and the PC"],
    ["“this Mac” stays quoted, this Mac does not", "“this Mac” stays quoted, this PC does not"],
    ['a site called "⌘ Shop" and ⌘W', 'a site called "⌘ Shop" and Ctrl+W'],
    ["iMac users and macOS's prompt", "iMac users and macOS's prompt"],
    ["⇧-clicks, ⌘Keys and ⌘K", "Shift-clicks, ⌘Keys and Ctrl+K"],
  ];
  for (const [mac, windows] of cases) assert.equal(windowsWords(mac), windows);
});

test("the branch's own sentences come last in Usage, after main's", () => {
  const usage = copy.WHATS_SENT.find((group) => group.title === "Usage");
  assert.ok(usage);
  assert.ok(usage.items.at(-1).startsWith("On Linux and Windows, when Ardia opens after a session where its window interface stopped"));
  assert.ok(usage.items.at(-2).startsWith("On Windows, how many times a page process for tabs in the background was put into efficiency mode"));
  assert.ok(usage.items.at(-3).startsWith("On Windows, how many times Ardia asked before quitting right after you confirmed closing a window's tabs"));
  assert.ok(usage.items.at(-4).startsWith("On Windows, how many times Ardia held the keys you typed"));
  assert.ok(usage.items.at(-5).startsWith("How many times suggestions that came in late waited"));
  assert.ok(usage.items.at(-6).startsWith("How many times a window's interface was started a second time"));
  assert.ok(usage.items.at(-7).startsWith("On Windows, how many times the command bar put back a letter"));
  assert.ok(usage.items.at(-8).startsWith("On Windows, how many times a tab you switched to had no page yet"));
  assert.ok(usage.items.at(-9).startsWith("On Windows, how many sync files waited"));
  assert.ok(usage.items.at(-24).startsWith("How many times the first-launch intro was shown"));
});

test("WATCH_COPY, which the platform pass skips, has nothing the rules would change", () => {
  const watch = strings(copy.WATCH_COPY);
  for (const text of watch) assert.equal(windowsWords(text), text);
});

test("rewording in place reaches nested objects and leaves functions alone", () => {
  const appear = (name) => `You appear as ${name} on this Mac`;
  const sample = { a: "this Mac", nested: { list: ["the Mac", "x"] }, appear };
  rewordInPlace(sample, windowsWords);
  assert.deepEqual(sample, { a: "this PC", nested: { list: ["the PC", "x"] }, appear });
});
