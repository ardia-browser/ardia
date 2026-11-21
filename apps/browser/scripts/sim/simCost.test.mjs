import assert from "node:assert/strict";
import { test } from "node:test";
import { boot } from "./boot.mjs";
import { readBaseline, rowProbe } from "./cost.mjs";
import { leakCheck } from "./leak.mjs";
import { instrumentStore } from "./probe.mjs";

const world = await boot();
const probe = instrumentStore(world);
const { useBrowser } = world.modules.store;
const { useTab } = await world.modules.at("state/browser/hooks.ts");
const quiet = () => {};

test("a per-row hook on the whole store is flagged, a keyed one is not, and nothing outside the baseline wakes other rows", async () => {
  const wholeStore = (tabId) => useBrowser((s) => s.tabs[tabId]?.title);
  const keyed = (tabId) => useTab(tabId, (t) => t?.title);
  const extraHooks = [
    { module: "sim", name: "useWholeStoreTitle", usedBy: ["sim"], fn: wholeStore, params: ["tabId"] },
    { module: "sim", name: "useKeyedTitle", usedBy: ["sim"], fn: keyed, params: ["tabId"] },
  ];
  const result = await rowProbe(world, probe, { extraHooks });
  const flagged = result.flagged.filter((f) => f.hot).map((f) => f.hook);
  assert.ok(flagged.includes("sim#useWholeStoreTitle"));
  assert.ok(!flagged.includes("sim#useKeyedTitle"));
  assert.ok(result.wholeBrowserStore.includes("sim#useWholeStoreTitle"));
  const known = new Set(readBaseline().wholeStoreRowHooks);
  assert.deepEqual(
    flagged.filter((h) => !h.startsWith("sim#") && !known.has(h)),
    [],
  );
  assert.equal(result.leftOverListeners, 0, "unmounting every row removes every listener it added");
  assert.ok(result.hooks.filter((h) => !h.hook.startsWith("sim#")).length >= 20, "found the per-row hooks");
});

test("the leak rule passes on this store and catches a listener left behind each cycle", async () => {
  assert.equal(await leakCheck(world, { out: quiet, warmup: 15, cycles: 20 }), true);
  const offs = [];
  const leaking = await leakCheck(world, { out: quiet, warmup: 15, cycles: 20, eachCycle: () => offs.push(useBrowser.subscribe(() => {})) });
  offs.forEach((off) => off());
  assert.equal(leaking, false);
});
