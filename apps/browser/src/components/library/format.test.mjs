import assert from "node:assert/strict";
import { test } from "node:test";

const { firstThatFits, fitName, previewLine, previewLineChoices, shortAgo, splitName } = await import("./format.ts");

const MINUTE = 60_000;
const download = (extra = {}) => ({
  id: "d", url: "https://dl.example/d", filename: "d.bin", path: "/d.bin", state: "finished", paused: false, received: 2_100_000, total: 2_100_000, speed: 0, mimeType: "", startTime: 1, ...extra,
});

test("a name that shares no long prefix stays whole, to be cut in the middle", () => {
  assert.deepEqual(splitName("quarterly-report-2026-Q3-final.pdf", ["installer.exe"]), { head: "quarterly-report-2026-Q3-final.pdf", kept: "" });
  assert.deepEqual(splitName("alvan-nee-ZCHj_2lJP00-unsplash.jpg", ["alvan-nee-brFsZ7qszSY-unsplash.jpg"]), { head: "alvan-nee-ZCHj_2lJP00-unsplash.jpg", kept: "" });
});

test("names that differ only near their end keep the word that tells them apart", () => {
  const names = ["Screenshot 2026-11-16 at 10.42.17.png", "Screenshot 2026-11-16 at 10.42.58.png"];
  assert.deepEqual(splitName(names[0], names), { head: "Screenshot 2026-11-16 at", kept: " 10.42.17.png" });
  assert.deepEqual(splitName(names[1], names), { head: "Screenshot 2026-11-16 at", kept: " 10.42.58.png" });
  const builds = ["ardia-nightly-2026-11-16-x86_64.dmg", "ardia-nightly-2026-11-16-arm64.dmg"];
  assert.deepEqual(splitName(builds[0], builds), { head: "ardia-nightly-2026-11-16", kept: "-x86_64.dmg" });
});

test("versions apart only in a dotted number keep that number, so a narrow sidebar still tells them apart", () => {
  const names = ["Ardia-0.43.0-nightly.14-arm64.dmg", "Ardia-0.43.0-nightly.12-arm64.dmg", "Ardia-0.41.0-arm64.dmg"];
  assert.deepEqual(splitName(names[0], names), { head: "Ardia-0.43.0-nightly.", kept: "14-arm64.dmg" });
  assert.deepEqual(splitName(names[2], names), { head: "Ardia-0.", kept: "41.0-arm64.dmg" });
});

test("a differing tail too long to keep falls back to the whole name", () => {
  const names = ["project-proposal-final-version-for-review.pdf", "project-proposal-draft-version-for-review.pdf"];
  assert.deepEqual(splitName(names[0], names), { head: names[0], kept: "" });
});

test("the meta line pairs size or progress with a short time", () => {
  const now = 30 * MINUTE + 1;
  assert.equal(previewLine(download(), true, now).text, "2.1 MB · 30 min ago");
  assert.equal(previewLine(download(), false, now).text, "Deleted · 30 min ago");
  assert.equal(previewLine(download({ state: "downloading", received: 25, total: 100, speed: 25 }), true, now).text, "25% · 3 sec left");
  assert.equal(previewLine(download({ state: "downloading", paused: true, received: 25, total: 100 }), true, now).text, "Paused");
  assert.equal(previewLine(download({ state: "downloading", dangerous: true, url: "http://x/y" }), true, now).tone, "destructive");
});

test("short times read like the sidebar's", () => {
  const at = Date.UTC(2026, 10, 1, 12);
  assert.equal(shortAgo(at, at + 30_000), "Just now");
  assert.equal(shortAgo(at, at + 3 * 60 * MINUTE), "3 hr ago");
});

test("Yesterday and days ago count calendar days, not elapsed hours", () => {
  const local = (day, hour) => new Date(2026, 10, day, hour).getTime();
  assert.equal(shortAgo(local(10, 9), local(11, 20)), "Yesterday", "35 hours across one midnight is yesterday");
  assert.equal(shortAgo(local(10, 22), local(12, 8)), "2 days ago", "34 hours across two midnights is not yesterday");
  assert.equal(shortAgo(local(10, 22), local(12, 8), true), "2d");
  assert.equal(shortAgo(local(6, 12), local(10, 12)), "4 days ago");
  assert.equal(shortAgo(local(10, 23), local(11, 1)), "2 hr ago", "under a day still reads in hours");
});

const SIDEBAR_TO_NAME_ROOM = 88;
const nameRoom = (sidebar) => sidebar - SIDEBAR_TO_NAME_ROOM;
const bodyWidth = (text) => text.length * 7;
const smallWidth = (text) => text.length * 6.2;
const HEAD_MIN = 32;

test("similar names stay apart at 160, 190 and 240 pt sidebars", () => {
  const names = ["Ardia-0.43.0-nightly.14-arm64.dmg", "Ardia-0.43.0-nightly.12-arm64.dmg", "sunset-timelapse.mov"];
  const fit = (sidebar, i) => fitName(names[i], names, nameRoom(sidebar), bodyWidth, HEAD_MIN);
  assert.deepEqual(fit(240, 0), { head: "Ardia-0.43.0-nightly.", kept: "14-arm64.dmg" });
  assert.deepEqual(fit(190, 0), { head: "", kept: "\u202614-arm64.dmg" });
  assert.deepEqual(fit(190, 1), { head: "", kept: "\u202612-arm64.dmg" });
  assert.deepEqual(fit(160, 0), { head: "", kept: "\u202614\u2026.dmg" });
  assert.deepEqual(fit(160, 1), { head: "", kept: "\u202612\u2026.dmg" });
  for (const sidebar of [160, 190, 240]) {
    assert.notDeepEqual(fit(sidebar, 0), fit(sidebar, 1));
    assert.ok(bodyWidth(fit(sidebar, 0).kept) <= nameRoom(sidebar));
    assert.deepEqual(fit(sidebar, 2), { head: "sunset-timelapse.mov", kept: "" });
  }
  assert.deepEqual(fitName("IMG_5013.jpg", names, nameRoom(160), bodyWidth, HEAD_MIN), { head: "IMG_5013.jpg", kept: "" });
});

test("the meta line shortens its time, then drops the size, so it never truncates", () => {
  const now = 2 * 24 * 60 * MINUTE + 1;
  const choices = previewLineChoices(download({ received: 439_000, total: 439_000 }), true, now).texts;
  assert.deepEqual(choices, ["439 KB · 2 days ago", "439 KB · 2d", "2d"]);
  assert.equal(firstThatFits(choices, nameRoom(240), smallWidth), "439 KB · 2 days ago");
  assert.equal(firstThatFits(choices, nameRoom(190), smallWidth), "439 KB · 2d");
  assert.equal(firstThatFits(choices, nameRoom(160), smallWidth), "439 KB · 2d");
  for (const sidebar of [160, 190, 240]) assert.ok(smallWidth(firstThatFits(choices, nameRoom(sidebar), smallWidth)) <= nameRoom(sidebar));
  assert.deepEqual(previewLineChoices(download({ state: "downloading", received: 25, total: 100, speed: 25 }), true, now).texts, ["25% · 3 sec left", "25% · 3s left", "25%"]);
  assert.deepEqual(previewLineChoices(download({ state: "failed" }), true, now).texts, ["Failed"]);
  assert.equal(shortAgo(1, 1 + 5 * 60 * MINUTE, true), "5h");
});
