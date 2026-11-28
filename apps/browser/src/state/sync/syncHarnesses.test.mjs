import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const SWITCHES_TO_DEVICE = "useBrowser.setState(this.browser, true);";
const SHARES_THE_CLOCK = "useEditClock(this.clock);";
const LOOKBACK = 3;

const testFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : testFiles(path);
    return entry.name.endsWith(".test.mjs") ? [path] : [];
  });

function deviceSwitchesWithoutTheClock(source) {
  if (!source.includes("this.clock = new Clock(")) return [];
  const lines = source.split("\n");
  return lines.flatMap((line, i) =>
    line.trim() === SWITCHES_TO_DEVICE && !lines.slice(Math.max(0, i - LOOKBACK), i).some((before) => before.trim() === SHARES_THE_CLOCK) ? [i + 1] : [],
  );
}

test("a test Mac that switches the store to its own browser also stamps edits with its own sync clock, as the app does", () => {
  const missing = testFiles(SRC).flatMap((file) => deviceSwitchesWithoutTheClock(readFileSync(file, "utf8")).map((line) => `${relative(SRC, file)}:${line}`));
  assert.deepEqual(missing, [], `call ${SHARES_THE_CLOCK} right before ${SWITCHES_TO_DEVICE} so pin choices and synced records share one HLC`);
});

test("the harness check catches a device that switches the store without sharing its clock", () => {
  const harness = ["class Device {", "  constructor() { this.clock = new Clock(\"d\"); }", "  with(fn) {", `    ${SWITCHES_TO_DEVICE}`, "  }", "}"].join("\n");
  assert.deepEqual(deviceSwitchesWithoutTheClock(harness), [4]);
  assert.deepEqual(deviceSwitchesWithoutTheClock(harness.replace(`    ${SWITCHES_TO_DEVICE}`, `    ${SHARES_THE_CLOCK}\n    ${SWITCHES_TO_DEVICE}`)), []);
});
