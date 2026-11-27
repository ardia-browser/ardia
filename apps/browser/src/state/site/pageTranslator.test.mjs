import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeElement, FakeText, fakePage } from "./fixtures/translatorPage.mjs";
const { drainPassages } = await import("./translateDrain.ts");
const { translatePack } = await import("./translate.ts");

test("the page hands over no more passages than asked for and keeps the rest of a big block queued", () => {
  const texts = Array.from({ length: 360 }, (_, i) => new FakeText(`Sentence number ${i}. `));
  const page = fakePage(new FakeElement("body", [new FakeElement("p", texts)]));
  assert.equal(page.call("start", "t1"), true);
  const seen = new Set();
  let batch = page.call("next", "t1", 2, 100000);
  assert.equal(batch.passages.length, 2);
  assert.equal(batch.more, true);
  for (;;) {
    assert.ok(batch.passages.length <= 2);
    for (const [, pieces] of batch.passages) for (const [, text] of pieces) seen.add(text);
    if (!batch.more) break;
    batch = page.call("next", "t1", 2, 100000);
  }
  assert.equal(seen.size, 360);
});

test("an answer for an earlier translation of the page is ignored", () => {
  const text = new FakeText("Hello there");
  const page = fakePage(new FakeElement("body", [new FakeElement("p", [text])]));
  page.call("start", "old");
  const [[, [[id]]]] = page.call("next", "old", 2, 2000).passages;
  page.call("revert");
  page.call("start", "new");
  assert.equal(page.call("apply", "old", [[id, "Bonjour"]]), false);
  assert.equal(text.nodeValue, "Hello there");
  const [[, [[fresh]]]] = page.call("next", "new", 2, 2000).passages;
  assert.equal(page.call("apply", "new", [[fresh, "Salut"]]), true);
  assert.equal(text.nodeValue, "Salut");
});

test("line breaks and indentation never reach the model, and the node keeps its own edges", () => {
  const first = new FakeText("\n\t\tMitmachen\n\t");
  const second = new FakeText(" und   helfen\n");
  const page = fakePage(new FakeElement("body", [new FakeElement("li", [first, new FakeElement("a", [second])])]));
  page.call("start", "t");
  const [[, pieces]] = page.call("next", "t", 24, 600).passages;
  assert.deepEqual(pieces.map(([, text]) => text), ["Mitmachen ", " und helfen"]);
  page.call("apply", "t", [
    [pieces[0][0], "Join "],
    [pieces[1][0], "and help"],
  ]);
  assert.equal(first.nodeValue, "\n\t\tJoin\n\t");
  assert.equal(second.nodeValue, " and help\n");
});

test("preformatted text keeps its line breaks inside but not at its edges", () => {
  const text = new FakeText("\nErste Zeile\nZweite Zeile\n");
  const page = fakePage(new FakeElement("body", [new FakeElement("p", [text])]), { whiteSpace: "pre-line" });
  page.call("start", "t");
  const [[, [[, sent]]]] = page.call("next", "t", 24, 600).passages;
  assert.equal(sent, "Erste Zeile\nZweite Zeile");
});

test("preformatted inline text inside a normal paragraph keeps its line breaks and indentation", () => {
  const pre = new FakeElement("span", [new FakeText("Erste Zeile\n    Zweite Zeile")]);
  pre.whiteSpace = "pre-wrap";
  const page = fakePage(new FakeElement("body", [new FakeElement("p", [new FakeText("Vorher\n  kommt "), pre])]));
  page.call("start", "t");
  const [[, pieces]] = page.call("next", "t", 24, 600).passages;
  assert.deepEqual(pieces.map(([, text]) => text), ["Vorher kommt ", "Erste Zeile\n    Zweite Zeile"]);
});

const drainPage = (page, model, progress, applied = []) =>
  drainPassages({
    inFlight: 2,
    holds: () => true,
    released: new Promise(() => {}),
    next: async (maxChars) => page.call("next", "t", 24, maxChars),
    translate: (pack) => translatePack(model, "de", "en", pack, "t", progress, () => true),
    apply: async (results) => page.call("apply", "t", results),
    onApplied: (passages) => applied.push(passages),
    onAbandoned: (passages) => void (progress.failed += passages),
  });

test("a paragraph the model always rejects is retried without ending the translation, and the one it translated stays", async () => {
  const one = new FakeText("Absatz eins ist ein ganz normaler Satz, der ohne Probleme übersetzt wird.");
  const two = new FakeText("Absatz zwei ist ein Satz, den das Modell bei jedem Versuch ablehnen wird.");
  const page = fakePage(new FakeElement("body", [new FakeElement("p", [one]), new FakeElement("p", [two])]));
  page.call("start", "t");
  const asked = [];
  const model = {
    translateBlocks: async (_s, _t, blocks) => {
      asked.push(...blocks.map((b) => b.join("")));
      return blocks.map((b) => (b.join("").includes("zwei") ? null : b.map((piece) => piece.toUpperCase())));
    },
  };
  assert.equal(await drainPage(page, model, { unlinked: 0, failed: 0 }), true);
  assert.equal(one.nodeValue, "ABSATZ EINS IST EIN GANZ NORMALER SATZ, DER OHNE PROBLEME ÜBERSETZT WIRD.");
  assert.equal(two.nodeValue, "Absatz zwei ist ein Satz, den das Modell bei jedem Versuch ablehnen wird.");
  assert.equal(asked.filter((text) => text.includes("zwei")).length, 3);
});

test("a pack that translates one passage of two counts one translated passage and one failed, once, after its retries", async () => {
  const page = fakePage(new FakeElement("body", [new FakeElement("li", [new FakeText("Hauptseite")]), new FakeElement("li", [new FakeText("Kaputt")])]));
  page.call("start", "t");
  const packs = [];
  const model = {
    translateBlocks: async (_s, _t, blocks) => {
      packs.push(blocks.length);
      return blocks.map((b) => (b[0] === "Kaputt" ? null : ["Main page"]));
    },
  };
  const progress = { unlinked: 0, failed: 0 };
  const applied = [];
  assert.equal(await drainPage(page, model, progress, applied), true);
  assert.equal(packs[0], 2);
  assert.equal(applied.reduce((a, b) => a + b, 0), 1);
  assert.equal(progress.failed, 1);
});

test("a page that turns an element preformatted between two translations gets its line breaks kept the second time", () => {
  const span = new FakeElement("span", [new FakeText("Erste Zeile\n    Zweite Zeile")]);
  const page = fakePage(new FakeElement("body", [new FakeElement("p", [span])]));
  page.call("start", "one");
  assert.equal(page.call("next", "one", 24, 600).passages[0][1][0][1], "Erste Zeile Zweite Zeile");
  page.call("revert");
  span.whiteSpace = "pre-wrap";
  page.call("start", "two");
  assert.equal(page.call("next", "two", 24, 600).passages[0][1][0][1], "Erste Zeile\n    Zweite Zeile");
});

test("paragraphs the model can't answer end the translation, and every one left untranslated counts, the one still in flight too", async () => {
  const texts = ["eins", "zwei", "drei", "vier"].map((n) => new FakeText(`Absatz ${n} ist lang genug, um ganz allein zum Modell zu gehen. `.repeat(4)));
  const page = fakePage(new FakeElement("body", texts.map((t) => new FakeElement("p", [t]))));
  page.call("start", "t");
  const progress = { unlinked: 0, failed: 0 };
  const model = { translateBlocks: async () => Promise.reject(new Error("the model went away")) };
  await assert.rejects(drainPage(page, model, progress), /went away/);
  assert.equal(progress.failed, 4);
});
