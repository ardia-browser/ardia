import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { QUIT_WARNING, askBeforeQuitting, asksBeforeQuit, quitWarningMayAsk, windowsStayingOpen } = await import("./quitWarning.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");

const asking = { quitsWithLastWindow: true, background: false, warns: true, staysOpen: [] };
const closing = new Set();
const staying = (ids, browsers = ["w1", "w2"]) => windowsStayingOpen(ids, "w1", new Set(browsers), (id) => closing.has(id));

test("a close quits only when no other window stays open", () => {
  assert.deepEqual(staying(["w1"]), []);
  assert.deepEqual(staying(["w1", "w2"]), ["w2"]);
  assert.deepEqual(staying(["w1", "settings"]), ["settings"], "an open Settings window keeps the app running");
  assert.deepEqual(staying(["w1", "import"]), ["import"]);
  assert.deepEqual(staying([]), ["w1"], "an empty list means the native side didn't answer, so it doesn't ask");
});

test("a window already closing, or gone from the UI while its native window fades, doesn't keep the app open", () => {
  closing.add("w2");
  assert.deepEqual(staying(["w1", "w2"]), [], "w2 is in its close animation");
  closing.clear();
  assert.deepEqual(staying(["w1", "w2"], ["w1"]), [], "w2 left the UI's windows but native still lists it until it's destroyed");
  closing.add("import");
  assert.deepEqual(staying(["settings", "import"].map((id) => id).concat("w1"), ["w1"]).filter((id) => id !== "settings"), [], "an Import window already closing doesn't keep the app open");
  assert.deepEqual(windowsStayingOpen(["settings", "import"], "settings", new Set(), (id) => closing.has(id)), [], "closing Settings while Import closes is the last close");
  closing.clear();
  assert.deepEqual(windowsStayingOpen(["settings", "import"], "settings", new Set(), () => false), ["import"]);
});

test("the warning asks only on Windows, with the setting on, and never on a hidden test instance", () => {
  assert.equal(asksBeforeQuit(asking), true);
  assert.equal(asksBeforeQuit({ ...asking, warns: false }), false);
  assert.equal(asksBeforeQuit({ ...asking, background: true }), false);
  assert.equal(asksBeforeQuit({ ...asking, quitsWithLastWindow: false }), false, "the Mac keeps running with no windows");
  assert.equal(asksBeforeQuit({ ...asking, staysOpen: ["w2"] }), false);
});

test("the warning uses the Mac's words and its don't-ask-again", () => {
  const mac = readFileSync(new URL("../../../../../packages/shell/ios/QuitFlow.swift", import.meta.url), "utf8");
  assert.match(mac, /Are you sure you want to quit \\\(ProcessInfo\.processInfo\.processName\)\?/);
  assert.equal(QUIT_WARNING.title, "Are you sure you want to quit Ardia?");
  assert.ok(mac.includes(`"${QUIT_WARNING.message}"`));
  assert.ok(mac.includes(`addButton(withTitle: "${QUIT_WARNING.confirmTitle}")`));
  assert.ok(mac.includes(`"${QUIT_WARNING.suppression.replace("’", "'")}"`));
});

test("on the Mac closing a window never shows the quit warning", async () => {
  let asked = 0;
  shellNativeModules.ArdiaDialogs.confirm = () => {
    asked += 1;
    return Promise.resolve({ confirmed: false, suppressed: false });
  };
  useBrowser.getState().hydrate({});
  useBrowser.getState().updateSettings({ warnBeforeQuitting: true });
  const id = useBrowser.getState().createWindow({ url: "https://a.com" });
  assert.equal(quitWarningMayAsk(), false);
  assert.equal(await askBeforeQuitting(id), "notAsked");
  const { closeLittleArdia } = await import("../littleArdia/actions.ts");
  const { isWindowClosing } = await import("./closingWindows.ts");
  const small = useBrowser.getState().createWindow({ url: "https://b.com", kind: "small" });
  closeLittleArdia(small);
  assert.equal(isWindowClosing(small) || !useBrowser.getState().windows[small], true, "Little Ardia still starts closing at once");
  assert.equal(asked, 0);
});


test("an open pop-up keeps Ardia running: closing the last browser window neither asks nor quits, and closing the last pop-up does", () => {
  assert.deepEqual(staying(["w1", "popup:a1"], ["w1"]), ["popup:a1"], "a pop-up window stays open after the last browser window closes");
  assert.equal(asksBeforeQuit({ ...asking, staysOpen: staying(["w1", "popup:a1"], ["w1"]) }), false, "so closing the last browser window asks nothing");
  const lastPopup = windowsStayingOpen(["popup:a1"], "popup:a1", new Set(), () => false);
  assert.deepEqual(lastPopup, [], "closing the last pop-up leaves nothing open");
  assert.equal(asksBeforeQuit({ ...asking, staysOpen: lastPopup }), true, "so it asks, with the setting on");
  assert.deepEqual(windowsStayingOpen(["popup:a1", "settings"], "popup:a1", new Set(), () => false), ["settings"], "Settings still keeps the app running behind a closing pop-up");
  const settingsWithPopup = windowsStayingOpen(["settings", "popup:a1"], "settings", new Set(), () => false);
  assert.deepEqual(settingsWithPopup, ["popup:a1"], "a pop-up keeps the app running behind a closing Settings");
  assert.equal(asksBeforeQuit({ ...asking, staysOpen: settingsWithPopup }), false, "so closing Settings as the last of the app's own windows, with a pop-up open, neither asks nor quits");
  assert.deepEqual(windowsStayingOpen(["import", "popup:a1"], "import", new Set(), () => false), ["popup:a1"], "and the same for Import");
  assert.equal(asksBeforeQuit({ ...asking, staysOpen: windowsStayingOpen(["settings"], "settings", new Set(), () => false) }), true, "once the pop-up has gone, closing Settings is the close that asks");
});

test("a pop-up's close request goes through the quit question, then closes its window", async () => {
  const { requestWindowClose } = await import("./windowClose.ts");
  const { windows } = await import("../../test-native/shell.ts");
  windows.open.set("popup:a2", {});
  requestWindowClose("popup:a2");
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(windows.closed.includes("popup:a2"), "a pop-up isn't one of the browser's windows, but its close is still carried out");
});
