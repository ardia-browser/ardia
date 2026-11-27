import assert from "node:assert/strict";
import { test } from "node:test";

const { ENGINE_KEPT_CODES: linux } = await import("./engineKeptCodes.linux.ts");
const { ENGINE_KEPT_CODES: desktop } = await import("./engineKeptCodes.desktop.ts");
const { ENGINE_KEPT_CODES: mac } = await import("./engineKeptCodes.ts");

test("Linux names its engine's posted page, unload prompt and download keeps as the Mac does", () => {
  const byCode = (table) => Object.fromEntries(table.map((kept) => [kept.code, kept]));
  for (const code of [100, 101, 102]) assert.deepEqual(byCode(linux)[code], byCode(mac)[code], `code ${code}`);
  assert.equal(byCode(linux)[103], undefined, "Linux's engine has no command session keep");
  assert.deepEqual(desktop, [], "Windows' engine uses 100-103 for other keeps, so its table stays empty");
});
