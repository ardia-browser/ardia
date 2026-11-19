import assert from "node:assert/strict";
import { test } from "node:test";
const { translatePassage, TranslateFailure } = await import("./translate.ts");

const beforeAttributedText = () => {
  const calls = [];
  return {
    calls,
    translateBlocks: async (_source, _target, blocks, owner) => {
      calls.push({ blocks, owner });
      return blocks.map((pieces) => (pieces.length === 1 ? [pieces[0].toUpperCase()] : null));
    },
  };
};

test("before macOS 26.4 a styled passage is translated one piece per request, each node its own text", async () => {
  const model = beforeAttributedText();
  const progress = { unlinked: 0 };
  const out = await translatePassage(model, "en", "fr", [1, [[10, "Read the "], [11, "notes"]]], "tok", progress, () => true);
  assert.deepEqual(out, [
    [10, "READ THE "],
    [11, "NOTES"],
  ]);
  assert.equal(progress.unlinked, 1);
  assert.deepEqual(model.calls.map((c) => c.blocks), [[["Read the ", "notes"]], [["Read the "], ["notes"]]]);
  assert.ok(model.calls.every((c) => c.owner === "tok"));
});

test("a released translation doesn't fall back to more requests", async () => {
  const model = beforeAttributedText();
  const out = await translatePassage(model, "en", "fr", [1, [[10, "Read the "], [11, "notes"]]], "tok", { unlinked: 0 }, () => false);
  assert.deepEqual(out, [
    [10, null],
    [11, null],
  ]);
  assert.equal(model.calls.length, 1);
});

test("a model that answers nothing ends the translation with an error", async () => {
  const model = { translateBlocks: async (_s, _t, blocks) => blocks.map(() => null) };
  await assert.rejects(translatePassage(model, "en", "fr", [1, [[10, "Hello"]]], "tok", { unlinked: 0 }, () => true), /didn't answer/);
});

test("that error carries the reason model_no_answer, so the finished event needn't read its text", async () => {
  const model = { translateBlocks: async (_s, _t, blocks) => blocks.map(() => null) };
  await assert.rejects(translatePassage(model, "en", "fr", [1, [[10, "Hello"]]], "tok", { unlinked: 0 }, () => true), (error) => {
    assert.ok(error instanceof TranslateFailure);
    assert.equal(error.reason, "model_no_answer");
    return true;
  });
});

test("a model that reports why it answered nothing has its kinds of error noted, unknown ones as other, never their text", async () => {
  const model = {
    translateBlocks: async (_s, _t, blocks) => ({ parts: blocks.map(() => null), errors: ["not_installed", "unsupported_language_pairing", "Couldn't translate \"Hello\"", "not_installed"] }),
  };
  const progress = { unlinked: 0, modelErrors: new Set() };
  await assert.rejects(translatePassage(model, "en", "fr", [1, [[10, "Hello"]]], "tok", progress, () => true), /didn't answer/);
  assert.deepEqual([...progress.modelErrors].sort(), ["not_installed", "other", "unsupported_language_pairing"]);
});

test("the answer with the parts and the kinds of error translates as the parts alone did", async () => {
  const model = { translateBlocks: async (_s, _t, blocks) => ({ parts: blocks.map((pieces) => pieces.map((text) => text.toUpperCase())), errors: [] }) };
  const progress = { unlinked: 0, modelErrors: new Set() };
  const out = await translatePassage(model, "en", "fr", [1, [[10, "Read the "], [11, "notes"]]], "tok", progress, () => true);
  assert.deepEqual(out, [
    [10, "READ THE "],
    [11, "NOTES"],
  ]);
  assert.equal(progress.modelErrors.size, 0);
});

test("an error the model raised on a request that the linked retry then answered is still noted", async () => {
  let calls = 0;
  const model = {
    translateBlocks: async (_s, _t, blocks) =>
      ++calls === 1 ? { parts: [null], errors: ["internal_error"] } : { parts: blocks.map((pieces) => [pieces[0].toUpperCase()]), errors: [] },
  };
  const progress = { unlinked: 0, modelErrors: new Set() };
  const out = await translatePassage(model, "en", "fr", [1, [[10, "Read the "], [11, "notes"]]], "tok", progress, () => true);
  assert.deepEqual(out, [
    [10, "READ THE "],
    [11, "NOTES"],
  ]);
  assert.deepEqual([...progress.modelErrors], ["internal_error"]);
  assert.equal(progress.unlinked, 1);
});
