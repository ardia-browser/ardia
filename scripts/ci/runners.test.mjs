import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS = join(REPO, ".github/workflows");
const BLACKSMITH = /^blacksmith-(2|4|8|16|32)vcpu-ubuntu-2404(-arm)?$|^blacksmith-(6|12)vcpu-macos-(latest|27|26|15)$/;
const GITHUB_WINDOWS = new Set(["windows-latest", "windows-11-arm"]);

function workflows() {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => ({ name, text: readFileSync(join(WORKFLOWS, name), "utf8").replace(/\r\n/g, "\n") }));
}

function runnerLabels(text) {
  const labels = [];
  for (const [, value] of text.matchAll(/^\s+runs-on: (.+)$/gm)) {
    if (value === "${{ matrix.runner }}") continue;
    labels.push(value.trim());
  }
  for (const [, value] of text.matchAll(/\brunner: ([a-z0-9.-]+)/g)) labels.push(value);
  return labels;
}

test("every job runs on Blacksmith, except Windows, which stays on GitHub", () => {
  const seen = new Set();
  for (const { name, text } of workflows()) {
    for (const label of runnerLabels(text)) {
      seen.add(label);
      assert.ok(BLACKSMITH.test(label) || GITHUB_WINDOWS.has(label), `${name} runs on ${label}, which is neither a Blacksmith label nor a GitHub Windows one`);
    }
  }
  assert.ok(seen.has("blacksmith-2vcpu-ubuntu-2404") && seen.has("blacksmith-12vcpu-macos-27") && seen.has("windows-11-arm"), "the scan finds the workflows' labels");
});

test("a matrix runner names its label in the matrix", () => {
  for (const { name, text } of workflows()) {
    if (!text.includes("runs-on: ${{ matrix.runner }}")) continue;
    assert.ok(/\brunner: [a-z0-9.-]+/.test(text), `${name} picks its runner from a matrix without listing one`);
  }
});

test("no workflow routes jobs to Boat or reads its settings", () => {
  for (const { name, text } of workflows()) {
    assert.ok(!/boat/i.test(text), `${name} still mentions Boat`);
  }
});
