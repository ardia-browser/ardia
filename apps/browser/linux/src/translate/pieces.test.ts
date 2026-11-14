import assert from "node:assert/strict";
import { test } from "node:test";
import { alignedParts, decodeHtml, piecesHtml, taggedRuns } from "./pieces.ts";

test("pieces go out as tagged spans with their text escaped", () => {
  assert.equal(piecesHtml(["a < b & c", " d"]), '<span data-p="0">a &lt; b &amp; c</span><span data-p="1"> d</span>');
});

test("entities decode, unknown ones stay", () => {
  assert.equal(decodeHtml("a &amp; b &lt;c&gt; &#233;t&#xE9; &nbsp;&bogus;"), "a & b <c> été  &bogus;");
});

test("runs carry the piece of the span around them", () => {
  assert.deepEqual(taggedRuns('x <span data-p="1">y</span> z'), [
    { piece: null, text: "x " },
    { piece: 1, text: "y" },
    { piece: null, text: " z" },
  ]);
});

test("pieces in order map back one to one", () => {
  const html = '<span data-p="0">I went </span><span data-p="1">to the market</span><span data-p="2"> with my sister.</span>';
  assert.deepEqual(alignedParts(html, ["Je suis allé ", "au marché", " avec ma sœur."]), ["I went ", "to the market", " with my sister."]);
});

test("a piece the model split around another stays in page order", () => {
  const html = '<span data-p="0">I went</span> <span data-p="1">to</span> <span data-p="2">the</span> <span data-p="1">market</span> <span data-p="2">with my sister yesterday.</span>';
  const parts = alignedParts(html, ["Je suis allé ", "au marché", " avec ma sœur hier."])!;
  assert.equal(parts.join(""), "I went to the market with my sister yesterday.");
  assert.equal(parts[0], "I went ");
  assert.ok(parts[1]!.startsWith("to"));
  assert.ok(parts[2]!.trim().endsWith("yesterday."));
});

test("a piece the model dropped gives no alignment", () => {
  assert.equal(alignedParts('<span data-p="0">Hello world</span>', ["Bonjour", " le monde"]), null);
  assert.equal(alignedParts("", ["Bonjour"]), null);
});

test("untagged words still land in a piece", () => {
  assert.deepEqual(alignedParts('Well, <span data-p="0">hello</span> <span data-p="1">there</span> friend', ["Eh bien, salut ", "toi l'ami"]), ["Well, hello ", "there friend"]);
});

test("the space between two pieces goes where the page had it", () => {
  const html = '<span data-p="0">Every Sunday I go</span> <span data-p="1">to the market</span> <span data-p="2">with my sister.</span>';
  assert.deepEqual(alignedParts(html, ["Chaque dimanche je vais ", "au marché", " avec ma sœur."]), ["Every Sunday I go ", "to the market", " with my sister."]);
});
