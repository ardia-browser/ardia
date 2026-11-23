import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseTextFragment, withTextFragment } from "./textFragment.ts";

const GUIDE = "https://docs.example/guide";
const LONE = "\ud800";

const directive = (link: string) => {
  const at = link.indexOf("text=");
  assert.ok(at > 0, link);
  return decodeURIComponent(link.slice(at + "text=".length));
};

test("a quote link encodes text holding an unpaired surrogate instead of throwing, as a search does", () => {
  const pageText = `Intro paragraph.\nsecond line with a broken ${LONE} glyph in it\n\nOutro.`;
  const fragment = chooseTextFragment({
    selected: `broken ${LONE} glyph`,
    before: "second line with a ",
    after: " in it\n\nOutro.",
    pageText,
  });
  assert.deepEqual(fragment, { start: `broken ${LONE} glyph` });
  const link = withTextFragment(GUIDE, fragment!);
  assert.equal(link, `${GUIDE}#:~:text=broken%20%EF%BF%BD%20glyph`);
  assert.equal(directive(link), "broken \uFFFD glyph");
});

test("a quote link replaces every unpaired half in the prefix, start, end and suffix", () => {
  const fragment = { prefix: `a${LONE}`, start: `b${LONE}b`, end: `${LONE}c`, suffix: `d${LONE}` };
  const link = withTextFragment(GUIDE, fragment);
  assert.equal(link, `${GUIDE}#:~:text=a%EF%BF%BD-,b%EF%BF%BDb,%EF%BF%BDc,-d%EF%BF%BD`);
  assert.equal(directive(link), "a\uFFFD-,b\uFFFDb,\uFFFDc,-d\uFFFD");
});

test("a quote link keeps a surrogate pair, an emoji and a hyphen whole", () => {
  const fragment = { prefix: "a 😀 b", start: "😀 smile", end: "𝄞 clef", suffix: "x-y" };
  const link = withTextFragment(GUIDE, fragment);
  assert.equal(link, `${GUIDE}#:~:text=a%20%F0%9F%98%80%20b-,%F0%9F%98%80%20smile,%F0%9D%84%9E%20clef,-x%2Dy`);
  assert.equal(directive(link), "a 😀 b-,😀 smile,𝄞 clef,-x-y");
  assert.ok(!link.includes("%EF%BF%BD"), link);
});

test("a quote link keeps the page's own fragment and replaces an older text directive", () => {
  assert.equal(withTextFragment("https://docs.example/a#part-2", { start: "two words" }), "https://docs.example/a#part-2:~:text=two%20words");
  assert.equal(withTextFragment("https://docs.example/a#part-2:~:text=old", { start: "new" }), "https://docs.example/a#part-2:~:text=new");
  assert.equal(withTextFragment("https://docs.example/a#", { start: "x" }), "https://docs.example/a#:~:text=x");
});
