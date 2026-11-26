import assert from "node:assert/strict";
import { test } from "node:test";

const { launchUsageFields } = await import("./launchUsage.ts");

test("perf_launch reads page-ins, block reads and processor time at main and at engine start as whole counts", () => {
  assert.deepEqual(launchUsageFields({ main: { pageIns: 1200, blockReads: 340, cpuMs: 12.6 }, engineStarted: { pageIns: 9800, blockReads: 2100, cpuMs: 640 } }), {
    main_page_ins: 1200,
    main_block_reads: 340,
    main_cpu_ms: 13,
    engine_page_ins: 9800,
    engine_block_reads: 2100,
    engine_cpu_ms: 640,
  });
});

test("a mark the launch never reached, an older build and a nonsense value send null", () => {
  const nothing = { main_page_ins: null, main_block_reads: null, main_cpu_ms: null, engine_page_ins: null, engine_block_reads: null, engine_cpu_ms: null };
  assert.deepEqual(launchUsageFields(undefined), nothing);
  assert.deepEqual(launchUsageFields(null), nothing);
  assert.deepEqual(launchUsageFields({ main: { pageIns: 5, blockReads: -1, cpuMs: Number.NaN } }), { ...nothing, main_page_ins: 5 });
});
