import assert from "node:assert/strict";
import { test } from "node:test";
import { loadingThroughout, summary } from "./native-summary.mjs";

const idle = (wakeups) => ({ total: { cpu: wakeups / 10, wakeups }, kinds: { browser: { cpu: wakeups / 10, wakeups } } });
const hang = { id: "t9", url: "http://127.0.0.1:1/hang?id=load", loading: true };
const run = (wakeups, before, after) => ({ load: [1, 1], loadedBefore: { id: "t1", url: "x", loading: false }, loaded: idle(1), loadingBefore: before, loading: idle(wakeups), loadingAfter: after });
const empty = { launch: [], session: [], profiles: [], windows: [], journeys: [], frames: [] };

test("the loading rows count only runs where the same /hang tab was active and loading at both ends", () => {
  const runs = [
    run(2, hang, hang),
    run(3, hang, hang),
    run(140, hang, { ...hang, loading: false }),
    run(150, hang, { ...hang, id: "t10" }),
    run(160, { ...hang, url: "http://127.0.0.1:1/static?id=seed" }, { ...hang, url: "http://127.0.0.1:1/static?id=seed" }),
    run(170, null, hang),
    run(180, { ...hang, url: "http://127.0.0.1:1/slow?id=other" }, hang),
    run(190, { ...hang, id: undefined }, { ...hang, id: undefined }),
  ];
  assert.deepEqual(runs.map(loadingThroughout), [true, true, false, false, false, false, false, false]);
  const rows = Object.fromEntries(summary({ ...empty, loading: runs }).map((r) => [r.name, r]));
  const loading = rows["active tab loading: wakeups/s (browser process)"];
  assert.equal(loading.n, 2);
  assert.ok(loading.max <= 3);
  assert.equal(rows["seed tab loaded: wakeups/s (browser process)"].n, 8);
  assert.equal(rows["active tab loading: runs where the same tab was active and loading throughout (the rest are left out)"].median, 2);
});
