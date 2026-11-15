import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { qrCode } from "./qr.ts";

const FIXTURES = join(fileURLToPath(import.meta.url), "../../../../../sync/tests/fixtures/windows-interop");

test("the recovery QR code matches the Mac's", async () => {
  const mac = JSON.parse(await readFile(join(FIXTURES, "mac.json"), "utf8")) as { words: string[] };
  const expected = (await readFile(join(FIXTURES, "qr.txt"), "utf8")).trimEnd().split("\n");
  const code = qrCode(mac.words.join(" "));
  const rows: string[] = [];
  for (let y = -1; y <= code.size; y++) {
    let row = "";
    for (let x = -1; x <= code.size; x++) row += x >= 0 && y >= 0 && x < code.size && y < code.size && code.dark(x, y) ? "1" : "0";
    rows.push(row);
  }
  assert.deepEqual(rows, expected);
});
