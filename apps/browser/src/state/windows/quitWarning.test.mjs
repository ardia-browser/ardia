import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

test("only Windows quits when its last window closes", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(source("../../lib/platformFeatures.windows.ts"), /quitsWithLastWindow: true\b/);
  assert.match(source("../../lib/platformFeatures.ts"), /quitsWithLastWindow: false\b/);
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

const ON_WINDOWS = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  return resolved.url.endsWith("/lib/platformFeatures.ts") ? { ...resolved, url: resolved.url.replace(/platformFeatures\\.ts$/, "platformFeatures.windows.ts") } : resolved;
} });`;

const LAST_POPUP_CLOSED_BY_THE_USER = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { requestWindowClose } = await import("./src/state/windows/windowClose.ts");
const { shellNativeModules, windows } = await import("./src/test-native/shell.ts");
const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
useBrowser.getState().hydrate({});
useBrowser.getState().updateSettings({ warnBeforeQuitting: true });
let asked = 0;
let answer = false;
shellNativeModules.ArdiaDialogs.confirm = () => { asked += 1; return Promise.resolve({ confirmed: answer, suppressed: false }); };
windows.open.set("popup:last", {});
requestWindowClose("popup:last");
await settle();
const cancelled = { asked, closed: windows.closed.includes("popup:last") };
answer = true;
requestWindowClose("popup:last");
await settle();
console.log(JSON.stringify({ cancelled, quit: { asked, closed: windows.closed.includes("popup:last") } }));
`;

test("on Windows, the user closing the last pop-up asks with the setting on: Cancel keeps it, Quit closes it", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--import", `data:text/javascript,${encodeURIComponent(ON_WINDOWS)}`, "--input-type=module", "-e", LAST_POPUP_CLOSED_BY_THE_USER], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.deepEqual(seen.cancelled, { asked: 1, closed: false }, "Cancel keeps the pop-up open");
  assert.deepEqual(seen.quit, { asked: 2, closed: true }, "Quit closes it, and the app quits with its last window");
});

const LAST_SETTINGS_OR_IMPORT = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { requestWindowClose } = await import("./src/state/windows/windowClose.ts");
const { cancelImport, importSignal } = await import("./src/state/import/flow.ts");
const { shellNativeModules, windows } = await import("./src/test-native/shell.ts");
const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
useBrowser.getState().hydrate({});
useBrowser.getState().updateSettings({ warnBeforeQuitting: true });
let asked = 0;
let answer = false;
shellNativeModules.ArdiaDialogs.confirm = () => { asked += 1; return Promise.resolve({ confirmed: answer, suppressed: false }); };
const closeLast = async (id, close = () => requestWindowClose(id)) => {
  windows.open.clear();
  windows.open.set(id, { kind: id });
  const before = asked;
  answer = false;
  close();
  await settle();
  const cancel = { asked: asked - before, open: windows.open.has(id) };
  answer = true;
  close();
  await settle();
  return { cancel, quit: { asked: asked - before, open: windows.open.has(id) } };
};
const settings = await closeLast("settings");
const importWindow = await closeLast("import");
const job = { before: importSignal().aborted };
let presses = 0;
const cancelled = await closeLast("import", () => {
  if (presses++ === 1) job.afterCancel = importSignal().aborted;
  cancelImport();
});
job.afterQuit = importSignal().aborted;
windows.open.clear();
const browser = useBrowser.getState().createWindow({ url: "https://a.com" });
windows.open.set(browser, {});
windows.open.set("settings", { kind: "settings" });
const before = asked;
requestWindowClose("settings");
await settle();
const besideBrowser = { asked: asked - before, open: windows.open.has("settings"), browserOpen: windows.open.has(browser) };
console.log(JSON.stringify({ settings, importWindow, cancelled, job, besideBrowser }));
`;

test("on Windows, Settings or Import as the last window asks before closing: Cancel keeps it and its import running, Quit closes it, and an open browser window means no question", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--import", `data:text/javascript,${encodeURIComponent(ON_WINDOWS)}`, "--input-type=module", "-e", LAST_SETTINGS_OR_IMPORT], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
  const askedThenClosed = { cancel: { asked: 1, open: true }, quit: { asked: 2, open: false } };
  assert.deepEqual(seen.settings, askedThenClosed, "Settings: Cancel keeps it open, Quit closes it");
  assert.deepEqual(seen.importWindow, askedThenClosed, "Import: the same");
  assert.deepEqual(seen.cancelled, askedThenClosed, "Import's Cancel button during an import asks the same question");
  assert.deepEqual(seen.job, { before: false, afterCancel: false, afterQuit: true }, "the import keeps running after the question is cancelled, and stops once the user agrees to quit");
  assert.deepEqual(seen.besideBrowser, { asked: 0, open: false, browserOpen: true }, "with a browser window open, Settings closes without asking");
});

const BROWSER_WINDOW_CLOSES = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { requestWindowClose } = await import("./src/state/windows/windowClose.ts");
const { closeTab } = await import("./src/state/browser/actions.ts");
const { shellNativeModules, windows } = await import("./src/test-native/shell.ts");
const S = () => useBrowser.getState();
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const asked = [];
let answer = { confirmed: false, suppressed: false };
shellNativeModules.ArdiaDialogs.confirm = (options) => { asked.push(options.title); return Promise.resolve(answer); };
const fresh = (settings) => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().updateSettings({ warnBeforeQuitting: true, warnBeforeClosingWindow: true, warnBeforeClosingLastTab: true, ...settings });
  windows.open.clear();
  asked.length = 0;
};
const seen = {};

fresh();
const other = S().createWindow({ url: "https://other.example/" });
const lone = S().createWindow({ url: "https://a.example/" });
S().newTab(lone, { url: "https://b.example/" });
windows.open.set(lone, {});
answer = { confirmed: false, suppressed: false };
requestWindowClose(lone);
await settle();
seen.windowCancelled = { asked: [...asked], open: !!S().windows[lone] };
answer = { confirmed: true, suppressed: true };
requestWindowClose(lone);
await settle();
seen.windowQuit = { asked: [...asked], open: !!S().windows[lone], otherOpen: !!S().windows[other], warnBeforeQuitting: S().settings.warnBeforeQuitting, warnBeforeClosingWindow: S().settings.warnBeforeClosingWindow };

fresh();
const single = S().createWindow({ url: "https://a.example/" });
windows.open.set(single, {});
answer = { confirmed: true, suppressed: false };
await closeTab(S().windows[single].tabIds[0]);
await settle();
seen.lastTabAsksTabs = { asked: [...asked], open: !!S().windows[single] };

fresh({ warnBeforeClosingLastTab: false });
const plain = S().createWindow({ url: "https://a.example/" });
windows.open.set(plain, {});
answer = { confirmed: false, suppressed: false };
await closeTab(S().windows[plain].tabIds[0]);
await settle();
seen.lastTabQuitCancelled = { asked: [...asked], open: !!S().windows[plain] };
answer = { confirmed: true, suppressed: false };
await closeTab(S().windows[plain].tabIds[0]);
await settle();
seen.lastTabQuit = { asked: [...asked], open: !!S().windows[plain] };
console.log(JSON.stringify(seen));
`;

const OTHER_WINDOW_CLOSES_DURING_THE_TABS_CONFIRM = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { requestWindowClose } = await import("./src/state/windows/windowClose.ts");
const { takeQuitWarningCounts } = await import("./src/state/telemetry/quitWarningCounts.ts");
const { setConsentPeriod } = await import("./src/state/telemetry/consentPeriod.ts");
setConsentPeriod(true, "quit-warning-test");
const { shellNativeModules, windows } = await import("./src/test-native/shell.ts");
const S = () => useBrowser.getState();
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const asked = [];
const held = [];
let holding = false;
let answer = { confirmed: true, suppressed: false };
shellNativeModules.ArdiaDialogs.confirm = (options) => {
  asked.push(options.title);
  return holding ? new Promise((resolve) => held.push(resolve)) : Promise.resolve(answer);
};
const seen = {};
const race = async (quitAnswer) => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().updateSettings({ warnBeforeQuitting: true, warnBeforeClosingWindow: true, shareTabsAcrossWindows: false });
  windows.open.clear();
  asked.length = 0;
  const a = S().createWindow({ url: "https://a.example/" });
  S().newTab(a, { url: "https://b.example/" });
  const b = S().createWindow({ url: "https://other.example/" });
  windows.open.set(a, {});
  windows.open.set(b, {});
  holding = true;
  requestWindowClose(a);
  await settle();
  const first = [...asked];
  holding = false;
  answer = { confirmed: true, suppressed: false };
  requestWindowClose(b);
  await settle();
  windows.open.delete(b);
  const otherGone = !S().windows[b];
  answer = quitAnswer;
  held.shift()({ confirmed: true, suppressed: false });
  await settle();
  return { first, otherGone, asked: [...asked], open: !!S().windows[a], counts: takeQuitWarningCounts() };
};
seen.cancelled = await race({ confirmed: false, suppressed: false });
seen.quit = await race({ confirmed: true, suppressed: false });
console.log(JSON.stringify(seen));
`;

test("on Windows, when the other window closes while a window's tabs confirm is open, confirming it asks the quit question: Cancel keeps the window, Quit closes it", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--import", `data:text/javascript,${encodeURIComponent(ON_WINDOWS)}`, "--input-type=module", "-e", OTHER_WINDOW_CLOSES_DURING_THE_TABS_CONFIRM], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
  const quit = QUIT_WARNING.title;
  assert.deepEqual(seen.cancelled.first, ["Close 2 tabs?"], "with another window open, only the tabs question asks");
  assert.equal(seen.cancelled.otherGone, true, "the other window closes without a question while the first still asks");
  assert.deepEqual(seen.cancelled.asked, ["Close 2 tabs?", quit], "confirming the tabs question asks the quit question, since this close now quits");
  assert.equal(seen.cancelled.open, true, "Cancel keeps the window and its tabs");
  assert.deepEqual(seen.cancelled.counts, { quit_warnings_after_tabs_confirm: 1, quit_warnings_after_tabs_confirm_cancelled: 1 });
  assert.deepEqual(seen.quit.asked, ["Close 2 tabs?", quit]);
  assert.equal(seen.quit.open, false, "Quit closes it");
  assert.deepEqual(seen.quit.counts, { quit_warnings_after_tabs_confirm: 1, quit_warnings_after_tabs_confirm_cancelled: 0 });
});

test("on Windows, a browser window's close asks the quit question first: Cancel keeps it, a confirmed quit skips the tabs question and Don't ask again turns the quit warning off; a last tab asks the tabs question, or the quit question when that one is off", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--import", `data:text/javascript,${encodeURIComponent(ON_WINDOWS)}`, "--input-type=module", "-e", BROWSER_WINDOW_CLOSES], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
  const quit = QUIT_WARNING.title;
  assert.deepEqual(seen.windowCancelled, { asked: [quit], open: true }, "the quit question comes first, and Cancel keeps the window");
  assert.deepEqual(seen.windowQuit, { asked: [quit, quit], open: false, otherOpen: true, warnBeforeQuitting: false, warnBeforeClosingWindow: true }, "a confirmed quit closes the window without the tabs question, and its checkbox turns only the quit warning off");
  assert.deepEqual(seen.lastTabAsksTabs, { asked: ["Close 1 tab?"], open: false }, "the last-tab confirm asks instead of the quit question");
  assert.deepEqual(seen.lastTabQuitCancelled, { asked: [quit], open: true }, "with the last-tab confirm off, the quit question asks, and Cancel keeps the tab");
  assert.deepEqual(seen.lastTabQuit, { asked: [quit, quit], open: false }, "Quit closes it");
});
