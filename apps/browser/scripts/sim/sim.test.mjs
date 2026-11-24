import assert from "node:assert/strict";
import { test } from "node:test";
import { boot } from "./boot.mjs";
import { exploreSeed, replay } from "./explore.mjs";
import { seededRandom, shrinkSequence } from "./rng.mjs";
import { generateSteps } from "./world.mjs";

const world = await boot();
const S = world.S;
const proto = Object.getPrototypeOf(S());

function planted(action, wrap) {
  const original = proto[action];
  proto[action] = wrap(original);
  return () => {
    proto[action] = original;
  };
}

async function firstFailure(rules = () => true, seeds = 40) {
  for (let seed = 1; seed <= seeds; seed++) {
    const result = await exploreSeed(world, seed, { steps: 80, shrinkBudget: 200, rules });
    if (!result.ok) return result;
  }
  return null;
}

test("a seed always draws the same steps and the store answers them the same way", async () => {
  assert.deepEqual(generateSteps(seededRandom(7), 30), generateSteps(seededRandom(7), 30));
  assert.notDeepEqual(generateSteps(seededRandom(7), 30), generateSteps(seededRandom(8), 30));
  const trace = async () => (await replay(world, generateSteps(seededRandom(11), 60))).trace.map((t) => t.detail.replace(/-[a-z0-9]+-[a-z0-9]+/g, "-id"));
  assert.deepEqual(await trace(), await trace());
});

test("the shrinker keeps only the steps a failure needs", async () => {
  const sequence = generateSteps(seededRandom(3), 50).map((s, i) => ({ ...s, kind: i === 9 ? "a" : i === 37 ? "b" : "x" }));
  const fails = async (c) => {
    const a = c.findIndex((s) => s.kind === "a");
    return a !== -1 && c.slice(a).some((s) => s.kind === "b");
  };
  const { steps: shrunk } = await shrinkSequence(sequence, fails);
  assert.deepEqual(
    shrunk.map((s) => s.kind),
    ["a", "b"],
  );
});

test("#2175 holds, and #3244, #3245 and #3246 still fail the way their issues describe until they are fixed", async () => {
  const { checkKnown } = await import("./known.mjs");
  const results = await checkKnown(world);
  assert.deepEqual(
    results.map((r) => r.issue).sort(),
    [2175, 3244, 3245, 3246],
  );
  for (const r of results) assert.ok(r.ok, r.line);
});

test("the pin rule catches a window close that drops parked pins", async () => {
  const undo = planted("closeWindow", (original) =>
    function (...args) {
      original.apply(this, args);
      world.useBrowser.setState({ parkedPins: {} });
    },
  );
  try {
    const failure = await firstFailure();
    assert.equal(failure?.rule, "pins");
    assert.ok(failure.steps.length <= 6, `shrunk to ${failure.steps.length}`);
  } finally {
    undo();
  }
});

test("the structure rule catches a tab left listed after it closes", async () => {
  const undo = planted("closeTab", (original) =>
    function (id) {
      const windowId = S().tabs[id]?.windowId;
      original.call(this, id);
      const w = windowId && S().windows[windowId];
      if (w && !w.tabIds.includes(id)) world.useBrowser.setState({ windows: { ...S().windows, [windowId]: { ...w, tabIds: [...w.tabIds, id] } } });
    },
  );
  try {
    assert.equal((await firstFailure())?.rule, "structure");
  } finally {
    undo();
  }
});

test("the session rule catches a reload that loses a tab", async () => {
  const undo = planted("hydrate", (original) =>
    function (data) {
      const ids = Object.keys(data?.tabs ?? {});
      if (ids.length > 2) {
        const { [ids.at(-1)]: _, ...tabs } = data.tabs;
        return original.call(this, { ...data, tabs });
      }
      return original.call(this, data);
    },
  );
  try {
    assert.match((await firstFailure((rule) => rule === "session" || rule === "relaunch"))?.rule ?? "", /^(session|relaunch)$/);
  } finally {
    undo();
  }
});

test("the reopen rule catches an entry taken off the list without coming back", async () => {
  const undo = planted("restoreClosed", () => function (entryId) {
    world.useBrowser.setState({ closedTabs: S().closedTabs.filter((c) => c.id !== entryId), closedWindows: S().closedWindows.filter((c) => c.id !== entryId) });
  });
  try {
    assert.equal((await firstFailure())?.rule, "reopen");
  } finally {
    undo();
  }
});

test("the CI seed set reaches every action and every state the rules depend on", async () => {
  const { reachOf, REQUIRED_REACH } = await import("./reach.mjs");
  const { ACTION_WEIGHTS } = await import("./world.mjs");
  const reach = {};
  for (let seed = 1; seed <= 40; seed++) {
    const result = await exploreSeed(world, seed, { steps: 120, onStep: (step, outcome) => reachOf(world, step, outcome).forEach((k) => (reach[k] = (reach[k] ?? 0) + 1)) });
    assert.ok(result.ok, `seed ${seed} fails on this store: ${result.rule}`);
  }
  for (const k of [...REQUIRED_REACH, ...Object.keys(ACTION_WEIGHTS)]) assert.ok(reach[k] > 0, `never reached: ${k}`);
});
