import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const PLAIN_BROWSER_LISTENERS = 40;

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

test("services hear the browser store by the keys they read, so a store update calls only the listeners it concerns", () => {
  const plain = sources(SRC).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/useBrowser\.subscribe\(/g)].map(() => path.slice(SRC.length));
  });
  assert.ok(
    plain.length <= PLAIN_BROWSER_LISTENERS,
    `${plain.length} listeners hear every browser-store update (at most ${PLAIN_BROWSER_LISTENERS}); use useBrowser.subscribeTo([keys], listener) for a new one:\n${plain.join("\n")}`,
  );
});
