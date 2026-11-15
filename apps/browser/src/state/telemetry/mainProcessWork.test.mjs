import assert from "node:assert/strict";
import { test } from "node:test";
const { forgetMainProcessWork, mainProcessWork } = await import("./mainProcessWork.ts");

const HOUR = 3_600_000;

test("the main process's work is what it used since the sample before: nothing from the first sample, a build without the counters or a restart", () => {
  forgetMainProcessWork();
  assert.deepEqual(mainProcessWork({ cpuMs: 4000, wakeups: 900, dragRegionRebuilds: 10, dragRegionStalePresses: 0 }, 0), {});
  assert.deepEqual(mainProcessWork({ cpuMs: 4000 + 36_000, wakeups: 900 + 18_000, dragRegionRebuilds: 70, dragRegionStalePresses: 1 }, HOUR), {
    browser_cpu_pct: 1,
    browser_wakeups_per_s: 5,
    drag_region_rebuilds: 60,
    drag_region_stale_presses: 1,
  });
  assert.deepEqual(mainProcessWork({ footprintMB: 200 }, 2 * HOUR), {});
  assert.deepEqual(mainProcessWork({ cpuMs: 90_000, wakeups: 30_000 }, 3 * HOUR), {}, "the sample before had no counters");
  assert.deepEqual(mainProcessWork({ cpuMs: 90_500, wakeups: 30_010 }, 3 * HOUR + 5000), {}, "5 seconds is too short to mean anything");
  assert.deepEqual(mainProcessWork({ cpuMs: 100, wakeups: 5 }, 5 * HOUR), {}, "the counters went back");
});
