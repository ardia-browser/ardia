import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isTilingDesktop } from "./tilingDesktop.ts";

const ENGINE_CORNERS = new URL("../../../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_window_corners.h", import.meta.url);
const quoted = (text) => [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

test("the shell and the engine name the same tiling desktops, in the same order", () => {
  const core = readFileSync(ENGINE_CORNERS, "utf8");
  const start = core.indexOf("kTilingDesktops[] = {");
  const engine = quoted(core.slice(start, core.indexOf("};", start)));
  const shell = readFileSync(new URL("./tilingDesktop.ts", import.meta.url), "utf8");
  const declaration = shell.slice(shell.indexOf("const TILING_DESKTOPS"));
  const opened = declaration.indexOf("= [") + 3;
  const array = declaration.slice(opened, declaration.indexOf("]", opened));
  assert.ok(engine.length > 0);
  assert.deepEqual(quoted(array), engine);
  for (const desktop of engine) assert.equal(isTilingDesktop(desktop.toUpperCase()), true, desktop);
  assert.equal(isTilingDesktop("GNOME"), false);
});
