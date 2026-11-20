import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { onFullScreenLeft } = await import("./layout.ts");

const S = () => useBrowser.getState();

test("leaving full screen runs the window's re-measure once, and entering it or another window's change does not", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "a.com" });
  const b = S().createWindow({ url: "b.com" });
  let runs = 0;
  const stop = onFullScreenLeft(a, () => runs++);
  S().setWindowFullScreen(a, true);
  assert.equal(runs, 0, "entering full screen is not leaving it");
  S().setWindowFullScreen(b, true);
  S().setWindowFullScreen(b, false);
  assert.equal(runs, 0, "another window leaving full screen is not this one");
  S().setWindowFullScreen(a, false);
  assert.equal(runs, 1);
  S().setWindowFullScreen(a, false);
  assert.equal(runs, 1, "staying out of full screen runs nothing");
  stop();
  S().setWindowFullScreen(a, true);
  S().setWindowFullScreen(a, false);
  assert.equal(runs, 1, "nothing runs after the watch stops");
});

test("the full-screen re-measure rides the store's window watch, not a native window-event listener of its own", () => {
  const layout = readFileSync(new URL("./layout.ts", import.meta.url), "utf8");
  const body = layout.slice(layout.indexOf("export function onFullScreenLeft"), layout.indexOf("export function useTabLayout"));
  assert.doesNotMatch(body, /onWindowEvent/);
  assert.match(body, /watchWindowRecord\(windowId,/);
});
