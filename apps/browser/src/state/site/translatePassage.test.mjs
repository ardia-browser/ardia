import assert from "node:assert/strict";
import { test } from "node:test";
const { translatePack } = await import("./translate.ts");

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
const progress = () => ({ unlinked: 0, failed: 0 });

test("a whole pack goes to the model in one call, each passage keeping its own parts", async () => {
  const calls = [];
  const model = {
    translateBlocks: async (_s, _t, blocks, owner) => {
      calls.push({ blocks, owner });
      return blocks.map((pieces) => pieces.map((p) => p.toUpperCase()));
    },
  };
  const out = await translatePack(model, "de", "en", [[1, [[10, "Hauptseite"]]], [2, [[20, "Lies die "], [21, "Hinweise"]]]], "tok", progress(), () => true);
  assert.deepEqual(out, [
    [10, "HAUPTSEITE"],
    [20, "LIES DIE "],
    [21, "HINWEISE"],
  ]);
  assert.deepEqual(calls, [{ blocks: [["Hauptseite"], ["Lies die ", "Hinweise"]], owner: "tok" }]);
});

test("before macOS 26.4 a styled passage is translated one piece per request, each node its own text", async () => {
  const model = beforeAttributedText();
  const counts = progress();
  const out = await translatePack(model, "en", "fr", [[1, [[10, "Read the "], [11, "notes"]]]], "tok", counts, () => true);
  assert.deepEqual(out, [
    [10, "READ THE "],
    [11, "NOTES"],
  ]);
  assert.equal(counts.unlinked, 1);
  assert.deepEqual(model.calls.map((c) => c.blocks), [[["Read the ", "notes"]], [["Read the "], ["notes"]]]);
  assert.ok(model.calls.every((c) => c.owner === "tok"));
});

test("the styled passages of a pack that don't map back go piece by piece together in one more call", async () => {
  const model = beforeAttributedText();
  const out = await translatePack(model, "en", "fr", [[1, [[10, "Home"]]], [2, [[20, "a "], [21, "b"]]], [3, [[30, "c "], [31, "d"]]]], "tok", progress(), () => true);
  assert.equal(out.length, 5);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(model.calls[1].blocks, [["a "], ["b"], ["c "], ["d"]]);
});

test("a released translation doesn't fall back to more requests", async () => {
  const model = beforeAttributedText();
  const out = await translatePack(model, "en", "fr", [[1, [[10, "Read the "], [11, "notes"]]]], "tok", progress(), () => false);
  assert.deepEqual(out, [
    [10, null],
    [11, null],
  ]);
  assert.equal(model.calls.length, 1);
});

test("a passage the model can't answer stays as it was while the rest of its pack is translated, and counts as failed only on its last try", async () => {
  const model = { translateBlocks: async (_s, _t, blocks) => blocks.map((pieces) => (pieces[0] === "bad" ? null : pieces.map((p) => p.toUpperCase()))) };
  const counts = progress();
  const out = await translatePack(model, "en", "fr", [[1, [[10, "good"]]], [2, [[20, "bad"]]]], "tok", counts, () => true);
  assert.deepEqual(out, [
    [10, "GOOD"],
    [20, null],
  ]);
  assert.equal(counts.failed, 0);
  await translatePack(model, "en", "fr", [[1, [[10, "good"]]], [3, [[30, "bad"]], 2]], "tok", counts, () => true);
  assert.equal(counts.failed, 1);
});

test("a model that answers nothing in a pack fails that pack with an error", async () => {
  const model = { translateBlocks: async (_s, _t, blocks) => blocks.map(() => null) };
  await assert.rejects(translatePack(model, "en", "fr", [[1, [[10, "Hello"]]], [2, [[20, "World"]]]], "tok", progress(), () => true), /didn't answer/);
});

test("a model call that rejects counts the passages on their last try as failed, once", async () => {
  const model = { translateBlocks: async () => Promise.reject(new Error("the model went away")) };
  const counts = progress();
  await assert.rejects(translatePack(model, "en", "fr", [[1, [[10, "a"]]], [2, [[20, "b"]], 2]], "tok", counts, () => true), /went away/);
  assert.equal(counts.failed, 1);
});

test("a piece-by-piece follow-up that rejects keeps the passages the pack already translated", async () => {
  let calls = 0;
  const model = {
    translateBlocks: async (_s, _t, blocks) => {
      if (calls++) throw new Error("the model went away");
      return blocks.map((pieces) => (pieces.length === 1 ? [pieces[0].toUpperCase()] : null));
    },
  };
  const out = await translatePack(model, "en", "fr", [[1, [[10, "Home"]]], [2, [[20, "Read the "], [21, "notes"]]]], "tok", progress(), () => true);
  assert.deepEqual(out, [
    [10, "HOME"],
    [20, null],
    [21, null],
  ]);
});

test("a piece-by-piece follow-up that rejects with nothing else translated fails the pack", async () => {
  let calls = 0;
  const model = {
    translateBlocks: async (_s, _t, blocks) => {
      if (calls++) throw new Error("the model went away");
      return blocks.map(() => null);
    },
  };
  await assert.rejects(translatePack(model, "en", "fr", [[2, [[20, "Read the "], [21, "notes"]]]], "tok", progress(), () => true), /went away/);
});

test("a passage on its last try whose piece-by-piece follow-up rejects counts as failed once", async () => {
  let calls = 0;
  const model = {
    translateBlocks: async (_s, _t, blocks) => {
      if (calls++) throw new Error("the model went away");
      return blocks.map(() => null);
    },
  };
  const counts = progress();
  await assert.rejects(translatePack(model, "en", "fr", [[2, [[20, "Read the "], [21, "notes"]], 2]], "tok", counts, () => true), /went away/);
  assert.equal(counts.failed, 1);
});
