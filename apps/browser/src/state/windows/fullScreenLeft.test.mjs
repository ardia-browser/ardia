import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("../browser/store.ts");
const { createWindowSync } = await import("./windowSync.ts");
const { onFullScreenLeft } = await import("./layout.ts");

const S = () => useBrowser.getState();

function listening() {
  let listener = () => {};
  const port = {
    open: () => {},
    close: () => {},
    setTitle: () => {},
    windowIds: async () => [],
    restoreFullScreen: () => {},
    onEvent: (l) => void (listener = l),
    releaseProfile: () => {},
  };
  createWindowSync({ port, getState: S, isQuitting: () => false, lightsCenter: () => [2, 2], isUtilityWindow: () => false }).listen();
  return (e) => listener(e);
}

test("leaving full screen re-measures at macOS's will-exit report and again at its did-exit report, when the frame is final", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "a.com" });
  const b = S().createWindow({ url: "b.com" });
  const emit = listening();
  let runs = 0;
  const stop = onFullScreenLeft(a, () => runs++);
  emit({ type: "fullScreen", id: a, on: true });
  assert.equal(runs, 0, "entering full screen is not leaving it");
  emit({ type: "fullScreen", id: b, on: false });
  assert.equal(runs, 0, "another window leaving full screen is not this one");
  emit({ type: "fullScreen", id: a, on: false });
  assert.equal(runs, 1, "will exit");
  emit({ type: "fullScreen", id: a, on: false });
  assert.equal(runs, 2, "did exit: the store didn't change, but the window's geometry is final now");
  stop();
  emit({ type: "fullScreen", id: a, on: false });
  assert.equal(runs, 2, "nothing runs after the card stops listening");
});

test("the full-screen re-measure rides the app's one window-event listener, not a native listener of its own", () => {
  const layout = readFileSync(new URL("./layout.ts", import.meta.url), "utf8");
  const sync = readFileSync(new URL("./windowSync.ts", import.meta.url), "utf8");
  assert.match(layout, /export const onFullScreenLeft = onFullScreenExit;/);
  assert.doesNotMatch(layout, /onWindowEvent/);
  assert.match(sync, /if \(e\.type === "fullScreen" && !e\.on\) signalFullScreenExit\(e\.id\);/);
});
