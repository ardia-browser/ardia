import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const STATE_ROOT = new URL(".", import.meta.url).pathname;

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const IMPORTS_COMPONENTS = /from\s+["'](?:\.\.\/)+components\//;

test("nothing under state imports from components; shared tables such as the icon roles live in lib", () => {
  const offenders = sourcesUnder(STATE_ROOT).filter((path) => IMPORTS_COMPONENTS.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders.map((path) => path.slice(STATE_ROOT.length)), []);
});
