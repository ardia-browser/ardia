import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const roots = [new URL(".", import.meta.url).pathname, new URL("../../../../../packages/sync/src", import.meta.url).pathname];
const DIRECT_WRITE = /(?:\bdelete\s+[\w.]*\.(?:records|base)\[|\b[\w.]*\.(?:records|base)\[[^\]]+\]\s*(?:\?\?=|=(?!=)))/;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

test("a sync record or base is written only through putRecord, dropRecord, putBase and dropBase, so the cycle's journal sees every change", () => {
  const found = [];
  for (const file of roots.flatMap(sources)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (DIRECT_WRITE.test(line)) found.push(`${file.split("/").slice(-2).join("/")}:${i + 1}: ${line.trim()}`);
    });
  }
  const helpers = found.filter((at) => at.startsWith("src/scopeKeys.ts:"));
  assert.equal(helpers.length, 4, `the four helpers in scopeKeys.ts:\n${helpers.join("\n")}`);
  assert.deepEqual(found.filter((at) => !helpers.includes(at)), []);
});
