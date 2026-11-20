import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../../../..");
const { SYMBOL_NAMES: linux } = await import(pathToFileURL(join(repo, "apps/linux/src/shims/web/symbols/data.ts")).href);
const { SYMBOL_NAMES: webAndWindows } = await import(pathToFileURL(join(repo, "packages/demo/src/shims/web/symbols/data.ts")).href);

const SYMBOLISH = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/;
const quoted = (text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((s) => SYMBOLISH.test(s));

function sourcesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

function symbolsIn(source) {
  const found = new Set();
  for (const m of source.matchAll(/<Symbol\b[^>]*?\bname=(\{[^}]*\}|"[^"]*")/g)) quoted(m[1].startsWith("{") ? m[1] : `"${m[1].slice(1, -1)}"`).forEach((s) => found.add(s));
  for (const m of source.matchAll(/\b(?:icon|symbol)(?:=|:\s*)(\{[^}]*\}|"[^"]*")/g)) quoted(m[1]).forEach((s) => found.add(s));
  for (const m of source.matchAll(/_SYMBOL\s*=\s*("[^"]*")/g)) quoted(m[1]).forEach((s) => found.add(s));
  for (const m of source.matchAll(/^\s*"([a-z0-9.]+)":\s*\{\s*size:/gm)) found.add(m[1]);
  return found;
}

const SOURCES = [
  ...sourcesUnder(here),
  ...sourcesUnder(join(here, "../littleArdia")),
  ...readdirSync(join(here, "../../lib")).filter((f) => f.startsWith("platformChrome")).map((f) => join(here, "../../lib", f)),
];

test("every symbol Settings and Little Ardia draw exists in the Linux, web and Windows symbol catalogs", () => {
  const used = new Map();
  for (const file of SOURCES) for (const name of symbolsIn(readFileSync(file, "utf8"))) used.set(name, file.slice(repo.length + 1));
  assert.ok(used.size > 20, `found only ${used.size} symbols; the scan is broken`);
  const missing = [...used].filter(([name]) => !linux.includes(name) || !webAndWindows.includes(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, []);
});
