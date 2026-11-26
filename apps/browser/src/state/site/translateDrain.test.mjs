import assert from "node:assert/strict";
import { test } from "node:test";
const { drainPassages, packsOf, FIRST_PACK_CHARS, PACK_CHARS, PACK_SEPARATOR, FAILED_PACKS_IN_A_ROW, LONG_PASSAGE } = await import("./translateDrain.ts");

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const passage = (id, nodes = 1) => [id, Array.from({ length: nodes }, (_, i) => [id * 1000 + i, `text ${id}.${i}`])];
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakePage(batches) {
  const page = { applied: [], asked: [], packs: [], inFlight: 0, maxInFlight: 0, holding: true, release: deferred() };
  page.port = {
    inFlight: 2,
    holds: () => page.holding,
    released: page.release.promise,
    next: async (maxChars) => {
      page.asked.push(maxChars);
      return batches.shift() ?? { passages: [], more: false, gone: false, done: 0, total: 0 };
    },
    translate: async (pack) => {
      page.packs.push(pack.map(([id]) => id));
      page.inFlight++;
      page.maxInFlight = Math.max(page.maxInFlight, page.inFlight);
      await tick();
      page.inFlight--;
      return pack.flatMap(([, pieces]) => pieces.map(([id, text]) => [id, text.toUpperCase()]));
    },
    apply: async (results) => void page.applied.push(...results),
  };
  return page;
}

test("each batch the page hands over goes to the model as one pack, two packs in flight, the first one small", async () => {
  const batch = (from) => ({ passages: [passage(from), passage(from + 1), passage(from + 2)], more: true, gone: false, done: from + 2, total: 9 });
  const page = fakePage([batch(1), batch(4), { ...batch(7), more: false }]);
  assert.equal(await drainPassages(page.port), true);
  assert.deepEqual(page.packs, [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.equal(page.applied.length, 9);
  assert.equal(page.maxInFlight, 2);
  assert.equal(page.asked[0], FIRST_PACK_CHARS);
  assert.ok(page.asked.slice(1).every((chars) => chars === PACK_CHARS));
});

test("a block that comes back as many passages is translated whole", async () => {
  const nine = Array.from({ length: 9 }, (_, i) => passage(i + 1, 40));
  const page = fakePage([{ passages: nine, more: false, gone: false, done: 9, total: 9 }]);
  assert.equal(await drainPassages(page.port), true);
  assert.equal(page.applied.length, 9 * 40);
  assert.ok(page.applied.some(([id, text]) => id === 9039 && text === "TEXT 9.39"));
});

test("a request that fails after the translation was replaced never touches the page", async () => {
  const page = fakePage([{ passages: [passage(1)], more: false, gone: false, done: 1, total: 1 }]);
  const answer = deferred();
  page.port.translate = () => answer.promise;
  const drained = drainPassages(page.port);
  await tick();
  page.holding = false;
  page.release.resolve();
  answer.reject(new Error("the model went away"));
  assert.equal(await drained, false);
  await tick();
  assert.deepEqual(page.applied, []);
});

test("a late answer after the translation was replaced is dropped", async () => {
  const page = fakePage([{ passages: [passage(1)], more: false, gone: false, done: 1, total: 1 }]);
  const answer = deferred();
  page.port.translate = () => answer.promise;
  const drained = drainPassages(page.port);
  await tick();
  page.holding = false;
  page.release.resolve();
  assert.equal(await drained, false);
  answer.resolve([[1000, "late"]]);
  await tick();
  assert.deepEqual(page.applied, []);
});

test("a new document ends the drain at once, without waiting for the model", async () => {
  const page = fakePage([{ passages: [passage(1), passage(2)], more: true, gone: false, done: 2, total: 5 }]);
  page.port.translate = () => new Promise(() => {});
  const drained = drainPassages(page.port);
  await tick();
  page.holding = false;
  page.release.resolve();
  const outcome = await Promise.race([drained, new Promise((r) => setTimeout(() => r("still waiting"), 200))]);
  assert.equal(outcome, false);
});

test("a pack the model fails gives its pieces back, and with nothing translated the drain reports the error", async () => {
  const page = fakePage([{ passages: [passage(1, 2)], more: false, gone: false, done: 1, total: 1 }]);
  page.port.translate = async () => {
    throw new Error("no model");
  };
  await assert.rejects(drainPassages(page.port), /no model/);
  assert.deepEqual(page.applied, [
    [1000, null],
    [1001, null],
  ]);
});

test("one failed pack leaves its text as it was and the rest of the page still translates", async () => {
  const page = fakePage([
    { passages: [passage(1)], more: true, gone: false, done: 1, total: 3 },
    { passages: [passage(2)], more: true, gone: false, done: 2, total: 3 },
    { passages: [passage(3)], more: false, gone: false, done: 3, total: 3 },
  ]);
  const failed = [];
  const translate = page.port.translate;
  page.port.translate = async (pack) => {
    if (pack[0][0] === 2) throw new Error("the model choked on one pack");
    return translate(pack);
  };
  page.port.onFailed = (n) => failed.push(n);
  assert.equal(await drainPassages(page.port), true);
  assert.deepEqual(failed, [1]);
  assert.deepEqual(
    page.applied.sort((a, b) => a[0] - b[0]),
    [
      [1000, "TEXT 1.0"],
      [2000, null],
      [3000, "TEXT 3.0"],
    ],
  );
});

test("packs failing in a row stop the drain with the error, without asking the page for more", async () => {
  const batches = Array.from({ length: 10 }, (_, i) => ({ passages: [passage(i + 1)], more: true, gone: false, done: i + 1, total: 10 }));
  const page = fakePage(batches);
  page.port.inFlight = 1;
  page.port.translate = async () => {
    throw new Error("the model went away");
  };
  await assert.rejects(drainPassages(page.port), /went away/);
  assert.equal(page.asked.length, FAILED_PACKS_IN_A_ROW);
});

test("a failure recorded before the translation was replaced is dropped once the replacement starts", async () => {
  const page = fakePage([
    { passages: [passage(1)], more: true, gone: false, done: 1, total: 2 },
    { passages: [passage(2)], more: false, gone: false, done: 2, total: 2 },
  ]);
  const first = deferred();
  const second = deferred();
  const answers = [first, second];
  page.port.translate = () => answers.shift().promise;
  const drained = drainPassages(page.port);
  await tick();
  first.reject(new Error("the model went away"));
  await tick();
  await tick();
  page.holding = false;
  page.release.resolve();
  const outcome = await Promise.race([drained.then((v) => v, (e) => `threw ${e.message}`), new Promise((r) => setTimeout(() => r("still waiting"), 200))]);
  assert.equal(outcome, false);
  second.resolve([[2000, "late"]]);
  await tick();
  assert.deepEqual(page.applied, [[1000, null]]);
});

test("an answer whose apply finishes after the translation was released reports no progress", async () => {
  const page = fakePage([{ passages: [passage(1)], more: false, gone: false, done: 1, total: 1 }]);
  const applying = deferred();
  const progress = [];
  page.port.apply = async (results) => {
    page.applied.push(...results);
    await applying.promise;
  };
  page.port.onApplied = (total) => progress.push(total);
  const drained = drainPassages(page.port);
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(page.applied.length, 1);
  page.holding = false;
  page.release.resolve();
  applying.resolve();
  assert.equal(await drained, false);
  await tick();
  assert.deepEqual(progress, []);
});

test("a long passage goes to the model alone so paragraphs still show one by one, short ones around it stay packed", () => {
  const long = (id) => [id, [[id * 1000, "x".repeat(LONG_PASSAGE)]]];
  const packs = packsOf([passage(1), passage(2), long(3), passage(4), long(5), long(6), passage(7)]);
  assert.deepEqual(packs.map((pack) => pack.map(([id]) => id)), [[1, 2], [3], [4], [5], [6], [7]]);
});

test("a pack of retries that fails again never ends the drain, however many in a row", async () => {
  const retry = (id) => [id, [[id * 1000, `text ${id}`]], 1];
  const batches = Array.from({ length: 6 }, (_, i) => ({ passages: [retry(i + 1)], more: i < 5, gone: false, done: i + 1, total: 6 }));
  const page = fakePage([{ passages: [passage(100)], more: true, gone: false, done: 1, total: 7 }, ...batches]);
  page.port.inFlight = 1;
  const translate = page.port.translate;
  page.port.translate = async (pack) => {
    if (pack[0][2]) throw new Error("rejected again");
    return translate(pack);
  };
  assert.equal(await drainPassages(page.port), true);
  assert.ok(page.asked.length >= 7);
  assert.equal(page.applied.filter(([, text]) => text === null).length, 6);
});

test("only passages that got an answer count as applied", async () => {
  const page = fakePage([{ passages: [passage(1), passage(2)], more: false, gone: false, done: 2, total: 2 }]);
  page.port.translate = async () => [
    [1000, "ONE"],
    [2000, null],
  ];
  const applied = [];
  page.port.onApplied = (n) => applied.push(n);
  assert.equal(await drainPassages(page.port), true);
  assert.deepEqual(applied, [1]);
});

test("short passages are packed only up to the pack's characters, whatever one block hands over", () => {
  const short = (id) => [id, [[id * 1000, "x".repeat(LONG_PASSAGE - 1)]]];
  const packs = packsOf([1, 2, 3, 4, 5, 6].map(short));
  assert.ok(packs.every((pack) => pack.map(([, pieces]) => pieces[0][1]).join(PACK_SEPARATOR).length <= PACK_CHARS));
  assert.deepEqual(packs.map((pack) => pack.map(([id]) => id)), [[1, 2], [3, 4], [5, 6]]);
});

test("a pack's characters count the separators between its passages", () => {
  const packs = packsOf([1, 2, 3, 4].map((id) => [id, [[id * 1000, "x".repeat(150)]]]));
  assert.deepEqual(packs.map((pack) => pack.map(([id]) => id)), [[1, 2, 3], [4]]);
  for (const pack of packs) assert.ok(pack.map(([, pieces]) => pieces[0][1]).join(PACK_SEPARATOR).length <= PACK_CHARS);
});

test("a model outage that ends the drain reports every fresh passage it left untranslated", async () => {
  const batches = [1, 2, 3, 4].map((id) => ({ passages: [passage(id)], more: true, gone: false, done: id, total: 4 }));
  const page = fakePage(batches);
  page.port.inFlight = 1;
  page.port.translate = async () => {
    throw new Error("the model went away");
  };
  const abandoned = [];
  page.port.onAbandoned = (n) => abandoned.push(n);
  await assert.rejects(drainPassages(page.port), /went away/);
  assert.deepEqual(abandoned, [3]);
});

test("an outage counts the packs still in flight when it ends the drain", async () => {
  const batches = [1, 2, 3, 4].map((id) => ({ passages: [passage(id)], more: id < 4, gone: false, done: id, total: 4 }));
  const page = fakePage(batches);
  const answers = new Map();
  page.port.translate = (pack) => {
    const answer = deferred();
    answers.set(pack[0][0], answer);
    return answer.promise;
  };
  const abandoned = [];
  page.port.onAbandoned = (n) => abandoned.push(n);
  const drained = drainPassages(page.port).then(() => "done", (e) => e.message);
  const fail = async (id) => {
    for (let i = 0; i < 20 && !answers.has(id); i++) await tick();
    answers.get(id).reject(new Error("the model went away"));
    for (let i = 0; i < 5; i++) await tick();
  };
  await fail(1);
  await fail(2);
  await fail(3);
  await fail(4);
  assert.equal(await drained, "the model went away");
  assert.deepEqual(abandoned, [4]);
});

function scriptedPage(batches) {
  const page = fakePage(batches);
  page.answers = new Map();
  page.port.translate = (pack) => {
    const answer = deferred();
    page.answers.set(pack[0][0], { answer, pack });
    return answer.promise;
  };
  page.settle = async (id, ok) => {
    for (let i = 0; i < 50 && !page.answers.has(id); i++) await tick();
    const { answer, pack } = page.answers.get(id);
    if (ok) answer.resolve(pack.flatMap(([, pieces]) => pieces.map(([pid, text]) => [pid, text.toUpperCase()])));
    else answer.reject(new Error("the model went away"));
    for (let i = 0; i < 5; i++) await tick();
  };
  return page;
}

test("an outage counts a passage whose retry it cut short, once", async () => {
  const fresh = (id) => ({ passages: [passage(id)], more: true, gone: false, done: id, total: 6 });
  const page = scriptedPage([fresh(1), fresh(2), { passages: [[11, [[11000, "text 1 again"]], 1]], more: true, gone: false, done: 3, total: 6 }, fresh(3), fresh(4), { ...fresh(5), more: false }]);
  const abandoned = [];
  page.port.onAbandoned = (n) => abandoned.push(n);
  const drained = drainPassages(page.port).then(() => "done", (e) => e.message);
  await page.settle(1, false);
  await page.settle(2, true);
  await page.settle(3, false);
  await page.settle(4, false);
  await page.settle(5, false);
  await page.settle(11, false);
  assert.equal(await drained, "the model went away");
  assert.deepEqual(abandoned, [4]);
});

test("a pack that lands after an outage ended the drain doesn't change the stage it failed at", async () => {
  const page = scriptedPage([1, 2, 3, 4].map((id) => ({ passages: [passage(id)], more: id < 4, gone: false, done: id, total: 4 })));
  const stages = [];
  page.port.onStage = (name) => stages.push(name);
  const drained = drainPassages(page.port).then(() => "done", (e) => e.message);
  await page.settle(1, false);
  await page.settle(2, false);
  await page.settle(3, false);
  await page.settle(4, true);
  assert.equal(await drained, "the model went away");
  assert.equal(stages.at(-1), "model");
  assert.ok(page.applied.some(([id, text]) => id === 4000 && text === "TEXT 4.0"));
});

test("a passage answered only in part waits for its retry, so the outage still counts every passage it left", async () => {
  const fresh = (id, pieces = 1) => ({ passages: [passage(id, pieces)], more: true, gone: false, done: id, total: 8 });
  const retryOf = (id, piece) => ({ passages: [[id * 10, [[piece, `text ${id} again`]], 1]], more: true, gone: false, done: id, total: 8 });
  const page = scriptedPage([fresh(1), fresh(2, 2), retryOf(1, 1000), retryOf(2, 2001), fresh(3), fresh(4), { ...fresh(5), more: false }]);
  const translate = page.port.translate;
  page.port.translate = (pack) => {
    if (pack[0][0] === 2) return Promise.resolve([[2000, "TEXT 2.0"], [2001, null]]);
    return translate(pack);
  };
  const abandoned = [];
  page.port.onAbandoned = (n) => abandoned.push(n);
  const drained = drainPassages(page.port).then(() => "done", (e) => e.message);
  await page.settle(1, false);
  await page.settle(20, true);
  await page.settle(3, false);
  await page.settle(4, false);
  await page.settle(5, false);
  await page.settle(10, false);
  assert.equal(await drained, "the model went away");
  assert.deepEqual(abandoned, [4]);
});

test("an outage is reported the moment it's recorded, before the failed pack's apply or any pack in flight settles", async () => {
  const page = scriptedPage([1, 2, 3, 4].map((id) => ({ passages: [passage(id)], more: id < 4, gone: false, done: id, total: 4 })));
  const events = [];
  const applying = deferred();
  page.port.apply = async (results) => {
    events.push(`apply ${results[0][0]}`);
    if (results[0][0] === 3000) await applying.promise;
  };
  page.port.onStage = (name) => events.push(`stage ${name}`);
  page.port.onOutage = () => events.push("outage");
  const drained = drainPassages(page.port).then(() => "done", (e) => e.message);
  await page.settle(1, false);
  await page.settle(2, false);
  await page.settle(3, false);
  assert.deepEqual(events.slice(-3), ["stage model", "outage", "apply 3000"]);
  await page.settle(4, true);
  applying.resolve();
  assert.equal(await drained, "the model went away");
  assert.equal(events.filter((e) => e === "outage").length, 1);
});
