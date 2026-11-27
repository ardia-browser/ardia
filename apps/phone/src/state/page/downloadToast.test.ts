import assert from "node:assert/strict";
import test from "node:test";
import { downloadFailedToast, shownFileName } from "./pagePrompts.ts";

test("a long file name is shortened in the middle and keeps its extension, so the toast's three lines hold the reason", () => {
  const shown = shownFileName("1396795d-1df6-4a18-9075-139738c6ccf3.pdf");
  assert.equal(shown.length, 32);
  assert.match(shown, /^1396795d-1df6.*….*c6ccf3\.pdf$/);
  assert.equal(shownFileName("otter.pdf"), "otter.pdf");
  assert.equal(shownFileName("a".repeat(60)).length, 32);
});

test("shortening never splits an emoji into a lone surrogate", () => {
  for (let at = 0; at < 40; at++) {
    const shown = shownFileName(`${"r".repeat(at)}😀${"e".repeat(40)}😀report.pdf`);
    assert.equal(Array.from(shown).length, 32);
    assert.doesNotMatch(shown, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
});

test("the reason comes first, so a long name can only push itself out of view", () => {
  assert.equal(downloadFailedToast("otter.pdf", "noSpace"), "Your phone is out of space. Couldn’t Download otter.pdf.");
  assert.equal(downloadFailedToast("", "server"), "The site didn’t send the file. Couldn’t Download File.");
  assert.equal(downloadFailedToast("otter.pdf", null), "Couldn’t Download otter.pdf");
  assert.equal(downloadFailedToast("otter.pdf", "privateSessionEnded"), "Couldn’t Download otter.pdf");
});
