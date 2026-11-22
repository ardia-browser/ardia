import assert from "node:assert/strict";
import test from "node:test";
import { copy, selectCopy } from "./platformCopy.ts";
import { shownSharingFootnote, shownWhatsSent } from "./shownWhatsSent.ts";

const texts = (os: string, offersSync: boolean) => shownWhatsSent(os, offersSync).flatMap((section) => section.items.map((item) => item.text));

test("where sync isn't offered, What's Sent names no Mac, no Match My Mac and no syncing, and Android never mentions iPhone", () => {
  for (const text of texts("android", false)) {
    assert.doesNotMatch(text, /Mac/);
    assert.doesNotMatch(text, /iPhone/);
  }
  assert.ok(texts("android", false).some((text) => text === "With each launch, the Appearance you chose: Glass or Classic, and Light, Dark or System"));
  assert.doesNotMatch(shownSharingFootnote(false), /sync/);
  assert.match(shownSharingFootnote(true), /This setting doesn’t sync\./);
});

test("where sync is offered, What's Sent keeps its Mac lines, and only iPhone lists the backdrop timing", () => {
  assert.ok(texts("ios", true).some((text) => /pinned to your Mac/.test(text)));
  assert.ok(texts("ios", true).some((text) => /first backdrop/.test(text)));
  assert.ok(!texts("android", true).some((text) => /first backdrop/.test(text)));
  assert.ok(texts("ios", false).some((text) => /Browse for Me/.test(text)));
  assert.ok(!texts("android", true).some((text) => /Browse for Me/.test(text)));
  const fields = shownWhatsSent("android", false).flatMap((section) => section.items.flatMap((item) => item.fields));
  assert.ok(fields.includes("interface_style"));
  assert.ok(fields.includes("pins_to_mac"));
  assert.ok(fields.includes("start_logo_taps"));
  assert.ok(!shownWhatsSent("ios", true).some((section) => section.items.some((item) => item.fields.includes("start_logo_taps"))));
});

test("where sync isn't offered, Clear Browsing Data, About and the licences drop the Mac and the sync folder", () => {
  selectCopy("android", false);
  assert.equal(copy().historyClears, "History clears from this phone.");
  assert.equal(copy().privacy, "No accounts. Your data stays on this phone.");
  assert.equal(copy().ardiaCredit, "This app.");
  selectCopy("android", true);
  assert.match(copy().historyClears, /Mac/);
  assert.match(copy().ardiaCredit, /Mac browser/);
});

test("each phone lists only its own page summary counts: ChatGPT and Gemini Nano on Android, Apple Intelligence on iPhone", () => {
  assert.ok(texts("android", false).some((text) => /on Android: how often you summarized a page/.test(text)));
  assert.ok(!texts("android", false).some((text) => /Apple Intelligence wrote on the phone/.test(text)));
  assert.ok(texts("ios", true).some((text) => /on iPhone: how often you summarized a page/.test(text)));
  assert.ok(!texts("ios", true).some((text) => /on Android: how often you summarized a page/.test(text)));
});

test("only Android lists why Gemini Nano wasn't used", () => {
  const listed = (os: string) => shownWhatsSent(os, false).some((section) => section.items.some((item) => item.fields.includes("gemini_nano_not_offered")));
  assert.ok(listed("android"));
  assert.ok(!listed("ios"));
});
