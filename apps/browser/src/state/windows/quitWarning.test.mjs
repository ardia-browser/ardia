import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const { useBrowser } = await import("../browser/store.ts");
const { QUIT_WARNING, askBeforeQuitting, asksBeforeQuit, closeQuits, downloadsQuitWarning, quitWarningMayAsk, windowsStayingOpen } = await import("./quitWarning.ts");
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

test("the downloads question uses the Mac's words, for one download and for several", () => {
  const mac = readFileSync(new URL("../../../../../packages/shell/ios/QuitFlow.swift", import.meta.url), "utf8");
  const one = downloadsQuitWarning(1);
  const three = downloadsQuitWarning(3);
  assert.equal(one.title, QUIT_WARNING.title);
  assert.ok(mac.includes(`"${one.message}"`));
  assert.ok(mac.includes(`"${three.message.replace("3", "\\(count)")}"`));
  assert.equal(one.confirmTitle, "Quit");
});

test("a close that quits is one on Windows, in a shown instance, with no other window staying open, whatever the warning setting", () => {
  assert.equal(closeQuits({ quitsWithLastWindow: true, background: false, staysOpen: [] }), true);
  assert.equal(closeQuits({ quitsWithLastWindow: false, background: false, staysOpen: [] }), false);
  assert.equal(closeQuits({ quitsWithLastWindow: true, background: true, staysOpen: [] }), false);
  assert.equal(closeQuits({ quitsWithLastWindow: true, background: false, staysOpen: ["w2"] }), false);
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
  assert.deepEqual(seen.cancelled.counts, { quit_warnings_after_tabs_confirm: 1, quit_warnings_after_tabs_confirm_cancelled: 1, quit_warnings_with_downloads: 0, quit_warnings_with_downloads_cancelled: 0 });
  assert.deepEqual(seen.quit.asked, ["Close 2 tabs?", quit]);
  assert.equal(seen.quit.open, false, "Quit closes it");
  assert.deepEqual(seen.quit.counts, { quit_warnings_after_tabs_confirm: 1, quit_warnings_after_tabs_confirm_cancelled: 0, quit_warnings_with_downloads: 0, quit_warnings_with_downloads_cancelled: 0 });
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

const QUITS_WITH_DOWNLOADS_RUNNING = `
const { useBrowser } = await import("./src/state/browser/store.ts");
const { requestWindowClose } = await import("./src/state/windows/windowClose.ts");
const { closeTab } = await import("./src/state/browser/actions.ts");
const { closeLittleArdia } = await import("./src/state/littleArdia/actions.ts");
const { quitWarningMayAsk } = await import("./src/state/windows/quitWarning.ts");
const { takeQuitWarningCounts } = await import("./src/state/telemetry/quitWarningCounts.ts");
const { setConsentPeriod } = await import("./src/state/telemetry/consentPeriod.ts");
setConsentPeriod(true, "quit-downloads-test");
const { shellNativeModules, windows } = await import("./src/test-native/shell.ts");
const S = () => useBrowser.getState();
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const asked = [];
let answers = [];
let whileAsking = null;
shellNativeModules.ArdiaDialogs.confirm = (options) => {
  asked.push(options.message);
  const meanwhile = whileAsking;
  whileAsking = null;
  meanwhile?.();
  return Promise.resolve({ confirmed: answers.shift() ?? false, suppressed: false });
};
const download = (id, extra = {}) => ({ id, url: "https://dl.example/" + id, filename: id, path: "/tmp/" + id, state: "downloading", paused: false, received: 0, total: 1, speed: 0, mimeType: "", profile: "", ...extra });
const fresh = (settings, downloads) => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().updateSettings({ warnBeforeQuitting: false, warnBeforeClosingWindow: false, warnBeforeClosingLastTab: false, ...settings });
  windows.open.clear();
  for (const each of downloads) S().upsertDownload(each);
  asked.length = 0;
  takeQuitWarningCounts();
};
const lone = (options = {}) => {
  const id = S().createWindow({ url: "https://a.example/", ...options });
  windows.open.set(id, {});
  return id;
};
const closing = async (id, close, replies) => {
  answers = [...replies];
  close(id);
  await settle();
  return { asked: [...asked], open: !!S().windows[id] };
};
const byButton = (id) => requestWindowClose(id);
const seen = {};

fresh({}, [download("one")]);
let w = lone();
seen.mayAsk = quitWarningMayAsk();
seen.oneCancelled = await closing(w, byButton, [false]);
seen.oneQuit = await closing(w, byButton, [true]);
seen.oneCounts = takeQuitWarningCounts();

fresh({}, [download("one"), download("two", { paused: true }), download("done", { state: "finished" })]);
w = lone();
seen.several = await closing(w, byButton, [false]);

fresh({ warnBeforeQuitting: true }, [download("one")]);
w = lone();
seen.warningCancelled = await closing(w, byButton, [false]);
seen.downloadsCancelled = await closing(w, byButton, [true, false]);
seen.bothQuit = await closing(w, byButton, [true, true]);
seen.bothCounts = takeQuitWarningCounts();

fresh({}, []);
w = lone();
seen.mayAskWithNothingRunning = quitWarningMayAsk();
seen.nothingRunning = await closing(w, byButton, []);

fresh({}, [download("done", { state: "finished" })]);
w = lone();
seen.onlyFinished = await closing(w, byButton, []);

fresh({}, [download("one")]);
const other = lone();
w = lone();
seen.besideAnotherWindow = { ...(await closing(w, byButton, [])), otherOpen: !!S().windows[other] };

fresh({}, [download("one")]);
w = lone();
seen.lastTabCancelled = await closing(w, (id) => void closeTab(S().windows[id].tabIds[0]), [false]);
seen.lastTabQuit = await closing(w, (id) => void closeTab(S().windows[id].tabIds[0]), [true]);

fresh({}, [download("one")]);
w = lone({ kind: "small" });
seen.littleArdiaCancelled = await closing(w, closeLittleArdia, [false]);
seen.littleArdiaQuit = await closing(w, closeLittleArdia, [true]);

const lastTab = (id) => void closeTab(S().windows[id].tabIds[0]);
fresh({ warnBeforeClosingLastTab: true }, [download("one")]);
w = lone();
seen.tabsConfirmCancelled = await closing(w, lastTab, [false]);
seen.tabsConfirmThenDownloadsCancelled = await closing(w, lastTab, [true, false]);
seen.tabsConfirmThenQuit = await closing(w, lastTab, [true, true]);

fresh({ warnBeforeClosingLastTab: true, warnBeforeQuitting: true }, [download("one")]);
w = lone();
seen.tabsConfirmStandsInForTheWarning = await closing(w, lastTab, [true, true]);

fresh({ warnBeforeClosingLastTab: true, warnBeforeQuitting: true }, []);
w = lone();
seen.tabsConfirmWithNothingRunning = await closing(w, lastTab, [true]);

fresh({ warnBeforeQuitting: true }, [download("one")]);
w = lone();
let opened;
whileAsking = () => { opened = lone(); };
seen.windowOpenedDuringTheWarning = { ...(await closing(w, byButton, [true])), openedStays: !!S().windows[opened] };

setConsentPeriod(false, null);
fresh({}, [download("one")]);
w = lone();
seen.withoutSharing = { ...(await closing(w, byButton, [false])), counts: takeQuitWarningCounts() };
console.log(JSON.stringify(seen));
`;

test("on Windows, a close that quits with a download running asks first, whatever the warning setting: Cancel keeps the window, Quit closes it; the warning asks before it; a finished download or another open window means no question", () => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--import", `data:text/javascript,${encodeURIComponent(ON_WINDOWS)}`, "--input-type=module", "-e", QUITS_WITH_DOWNLOADS_RUNNING], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split("\n").at(-1));
  const one = downloadsQuitWarning(1).message;
  const two = downloadsQuitWarning(2).message;
  const warning = QUIT_WARNING.message;
  assert.equal(seen.mayAsk, true, "with the warning off, a running download is enough for the close paths to ask");
  assert.deepEqual(seen.oneCancelled, { asked: [one], open: true }, "Cancel keeps the window, so the download keeps running");
  assert.deepEqual(seen.oneQuit, { asked: [one, one], open: false }, "Quit closes it");
  assert.deepEqual(seen.oneCounts, { quit_warnings_after_tabs_confirm: 0, quit_warnings_after_tabs_confirm_cancelled: 0, quit_warnings_with_downloads: 2, quit_warnings_with_downloads_cancelled: 1 });
  assert.deepEqual(seen.several, { asked: [two], open: true }, "a paused download counts, a finished one doesn't");
  assert.deepEqual(seen.warningCancelled, { asked: [warning], open: true }, "the warning comes first, and its Cancel ends it there");
  assert.deepEqual(seen.downloadsCancelled, { asked: [warning, warning, one], open: true }, "after the warning's Quit the downloads question still asks, and its Cancel keeps the window");
  assert.deepEqual(seen.bothQuit, { asked: [warning, warning, one, warning, one], open: false }, "both agreed: the window closes");
  assert.deepEqual(seen.bothCounts, { quit_warnings_after_tabs_confirm: 0, quit_warnings_after_tabs_confirm_cancelled: 0, quit_warnings_with_downloads: 2, quit_warnings_with_downloads_cancelled: 1 });
  assert.equal(seen.mayAskWithNothingRunning, false);
  assert.deepEqual(seen.nothingRunning, { asked: [], open: false }, "nothing running and the warning off: no question");
  assert.deepEqual(seen.onlyFinished, { asked: [], open: false });
  assert.deepEqual(seen.besideAnotherWindow, { asked: [], open: false, otherOpen: true }, "another window keeps Ardia and its downloads running");
  assert.deepEqual(seen.lastTabCancelled, { asked: [one], open: true }, "Ctrl+W on the last tab asks the same way");
  assert.deepEqual(seen.lastTabQuit, { asked: [one, one], open: false });
  assert.deepEqual(seen.littleArdiaCancelled, { asked: [one], open: true }, "and so does a lone Little Ardia");
  assert.deepEqual(seen.littleArdiaQuit.asked, [one, one]);
  const tabs = "This window has 1 tab open in your Personal profile.";
  assert.deepEqual(seen.tabsConfirmCancelled, { asked: [tabs], open: true }, "with the last-tab confirm on (the default), its Cancel ends it there");
  assert.deepEqual(seen.tabsConfirmThenDownloadsCancelled, { asked: [tabs, tabs, one], open: true }, "agreeing to close the tab still asks about the download, and Cancel keeps the window");
  assert.deepEqual(seen.tabsConfirmThenQuit, { asked: [tabs, tabs, one, tabs, one], open: false });
  assert.deepEqual(seen.tabsConfirmStandsInForTheWarning, { asked: [tabs, one], open: false }, "the last-tab confirm stands in for the warning, never for the downloads question");
  assert.deepEqual(seen.tabsConfirmWithNothingRunning, { asked: [tabs], open: false }, "and with nothing running it is the only question, as before");
  assert.deepEqual(seen.windowOpenedDuringTheWarning, { asked: [warning], open: false, openedStays: true }, "a window opened while the warning was up keeps Ardia running, so the downloads question isn't asked");
  assert.deepEqual(seen.withoutSharing, { asked: [one], open: true, counts: { quit_warnings_after_tabs_confirm: 0, quit_warnings_after_tabs_confirm_cancelled: 0, quit_warnings_with_downloads: 0, quit_warnings_with_downloads_cancelled: 0 } }, "with sharing off the question still asks and nothing is counted");
});

const quitLogLines = (hidden) => `
const { shellNativeModules, windows } = await import("./src/test-native/shell.ts");
shellNativeModules.ArdiaSystem.backgroundInstance = ${hidden};
const said = [];
console.info = (...args) => { if (String(args[0]).startsWith("[quit]")) said.push(args.join(" ")); };
const { useBrowser } = await import("./src/state/browser/store.ts");
const { requestWindowClose } = await import("./src/state/windows/windowClose.ts");
const { closeLittleArdia } = await import("./src/state/littleArdia/actions.ts");
const S = () => useBrowser.getState();
const settle = async () => { for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
let asked = 0;
let answers = [];
shellNativeModules.ArdiaDialogs.confirm = () => { asked += 1; return Promise.resolve({ confirmed: answers.shift() ?? false, suppressed: false }); };
const download = (id, extra = {}) => ({ id, url: "https://dl.example/" + id, filename: id, path: "/tmp/" + id, state: "downloading", paused: false, received: 0, total: 1, speed: 0, mimeType: "", profile: "", ...extra });
const fresh = (settings, downloads) => {
  S().hydrate({ profiles: { default: { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 } }, profileOrder: ["default"] });
  S().updateSettings({ warnBeforeQuitting: false, warnBeforeClosingWindow: false, warnBeforeClosingLastTab: false, ...settings });
  windows.open.clear();
  for (const each of downloads) S().upsertDownload(each);
  said.length = 0;
  asked = 0;
};
const lone = (options = {}) => {
  const id = S().createWindow({ url: "https://a.example/", ...options });
  windows.open.set(id, {});
  return id;
};
const closing = async (id, close, replies) => {
  answers = [...replies];
  close(id);
  await settle();
  return { said: [...said], asked, open: !!S().windows[id] };
};
const byButton = (id) => requestWindowClose(id);
const seen = {};

fresh({}, [download("one")]);
let w = lone();
seen.cancelled = await closing(w, byButton, [false]);
if (S().windows[w]) seen.quit = await closing(w, byButton, [true]);

fresh({ warnBeforeQuitting: true }, [download("one"), download("two", { paused: true })]);
w = lone();
seen.warningAndSeveral = await closing(w, byButton, [true, true]);

fresh({ warnBeforeQuitting: true }, []);
w = lone({ kind: "small" });
seen.littleArdiaWarning = await closing(w, closeLittleArdia, [true]);

fresh({}, [download("one")]);
w = lone({ kind: "small" });
seen.littleArdiaDownload = await closing(w, closeLittleArdia, [true]);

fresh({}, [download("one")]);
const other = lone();
w = lone();
seen.besideAnotherWindow = await closing(w, byButton, []);

fresh({}, []);
w = lone();
seen.nothingToAsk = await closing(w, byButton, []);
console.log(JSON.stringify(seen));
`;

const quitLogRun = (hidden) => {
  const run = spawnSync(process.execPath, ["--no-warnings", "--import", "./src/test-loader.mjs", "--import", `data:text/javascript,${encodeURIComponent(ON_WINDOWS)}`, "--input-type=module", "-e", quitLogLines(hidden)], { cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
};

test("on Windows, a close that asked the quit question says in the log what it asked about and how it was answered, and one that asked nothing says nothing", () => {
  const seen = quitLogRun(false);
  assert.deepEqual(seen.cancelled, { said: ["[quit] asked: 1 download in progress, warning off; answered cancel"], asked: 1, open: true });
  assert.deepEqual(seen.quit, { said: ["[quit] asked: 1 download in progress, warning off; answered cancel", "[quit] asked: 1 download in progress, warning off; answered quit"], asked: 2, open: false });
  assert.deepEqual(seen.warningAndSeveral, { said: ["[quit] asked: 2 downloads in progress, warning on; answered quit"], asked: 2, open: false }, "two questions, one line");
  assert.deepEqual(seen.littleArdiaWarning.said, ["[quit] asked: 0 downloads in progress, warning on; answered quit"]);
  assert.deepEqual(seen.littleArdiaDownload.said, ["[quit] asked: 1 download in progress, warning off; answered quit"]);
  assert.deepEqual(seen.besideAnotherWindow, { said: [], asked: 0, open: false }, "another window stays open, so nothing quits and nothing is said");
  assert.deepEqual(seen.nothingToAsk, { said: [], asked: 0, open: false });
});

test("on Windows, a hidden instance never asks, and says once per window that a quitting close went unasked, with the downloads running and the warning setting", () => {
  const seen = quitLogRun(true);
  assert.deepEqual(seen.cancelled, { said: ["[quit] not asked on a hidden instance: 1 download in progress, warning off"], asked: 0, open: false });
  assert.equal(seen.quit, undefined, "the first close already closed it");
  assert.deepEqual(seen.warningAndSeveral, { said: ["[quit] not asked on a hidden instance: 2 downloads in progress, warning on"], asked: 0, open: false });
  assert.deepEqual(seen.littleArdiaWarning.said, ["[quit] not asked on a hidden instance: 0 downloads in progress, warning on"]);
  assert.deepEqual(seen.littleArdiaDownload.said, ["[quit] not asked on a hidden instance: 1 download in progress, warning off"], "Little Ardia as the last window says it too");
  assert.equal(seen.littleArdiaDownload.asked, 0);
  assert.deepEqual(seen.besideAnotherWindow, { said: [], asked: 0, open: false }, "a close that doesn't quit says nothing");
  assert.deepEqual(seen.nothingToAsk, { said: [], asked: 0, open: false }, "nothing running and the warning off: nothing would have been asked");
});
