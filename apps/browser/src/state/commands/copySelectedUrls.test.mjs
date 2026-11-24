import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { runCommand } = await import("./commands.ts");
const { shellNativeModules } = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const copied = [];
shellNativeModules.ArdiaShell.copyText = (text) => void copied.push(text);

function windowWith(...hosts) {
  S().hydrate({});
  const w = S().createWindow({ url: `https://${hosts[0]}.com/` });
  S().setFocusedWindow(w);
  const ids = [S().windows[w].tabIds[0]];
  for (const h of hosts.slice(1)) ids.push(S().newTab(w, { url: `https://${h}.com/` }));
  return { w, ids };
}

test("⇧⌘C with several tabs selected copies every selected tab's address, one per line", () => {
  const { w, ids: [a, b] } = windowWith("a", "b", "c");
  S().activate(a);
  S().setSelection(w, [a, b]);
  copied.length = 0;
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.deepEqual(copied, ["https://a.com/\nhttps://b.com/"]);
});

test("a copy aimed at one tab (an automation request) copies that tab, whatever the sidebar has selected", async () => {
  const { w, ids: [a, b, c] } = windowWith("a", "b", "c");
  S().activate(a);
  S().setSelection(w, [a, b]);
  copied.length = 0;
  runCommand({ command: "copyUrl", arg: null, windowId: w }, { tabId: c });
  runCommand({ command: "copyUrlAsMarkdown", arg: null, windowId: w }, { tabId: c });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied.length, 2);
  assert.match(copied[0], /^https:\/\/c\.com\/$/);
  assert.match(copied[1], /\(https:\/\/c\.com\/\)$/);
});

test("Email Page Location mails the page's address without trackers, in the body and as the subject of an untitled page", () => {
  const opened = [];
  const before = shellNativeModules.ArdiaApp.openExternalURL;
  shellNativeModules.ArdiaApp.openExternalURL = (url) => (opened.push(url), Promise.resolve(true));
  try {
    S().hydrate({});
    const w = S().createWindow({ url: "https://shop.example/item?id=7&utm_source=mail" });
    S().setFocusedWindow(w);
    runCommand({ command: "emailPageLocation", arg: null, windowId: w });
  } finally {
    shellNativeModules.ArdiaApp.openExternalURL = before;
  }
  assert.deepEqual(opened, [`mailto:?subject=${encodeURIComponent("https://shop.example/item?id=7")}&body=${encodeURIComponent("https://shop.example/item?id=7")}`]);
});

test("Email Page Location cleans a subject that is the page's own tracked address or another tracked address", () => {
  const opened = [];
  const before = shellNativeModules.ArdiaApp.openExternalURL;
  shellNativeModules.ArdiaApp.openExternalURL = (url) => (opened.push(url), Promise.resolve(true));
  const tracked = "https://shop.example/item?id=7&utm_source=mail";
  try {
    S().hydrate({});
    const w = S().createWindow({ url: tracked });
    S().setFocusedWindow(w);
    const t = S().windows[w].tabIds[0];
    for (const title of [tracked, ` ${tracked}\n`, "https://other.example/?gclid=1&q=2", "Item & more"]) {
      S().updateTab(t, { title });
      runCommand({ command: "emailPageLocation", arg: null, windowId: w });
    }
  } finally {
    shellNativeModules.ArdiaApp.openExternalURL = before;
  }
  const subjects = opened.map((url) => decodeURIComponent(/subject=([^&]*)/.exec(url)[1]));
  assert.deepEqual(subjects, ["https://shop.example/item?id=7", "https://shop.example/item?id=7", "https://other.example/?q=2", "Item & more"]);
  for (const url of opened) assert.doesNotMatch(decodeURIComponent(url), /utm_|gclid/);
});

test("copying several selected tabs counts each address that lost a tracker", async () => {
  const { setConsentPeriod } = await import("../telemetry/consentPeriod.ts");
  const { takeUrlCopyCounts } = await import("../telemetry/urlCopies.ts");
  setConsentPeriod(true, "selected-tabs");
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/?utm_source=x" });
  S().setFocusedWindow(w);
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://b.com/?fbclid=1&q=2" });
  const c = S().newTab(w, { url: "https://c.com/" });
  S().activate(a);
  S().setSelection(w, [a, b, c]);
  takeUrlCopyCounts();
  copied.length = 0;
  runCommand({ command: "copyUrl", arg: null, windowId: w });
  assert.deepEqual(copied, ["https://a.com/\nhttps://b.com/?q=2\nhttps://c.com/"]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_of_selected_tabs, 1);
  assert.equal(counts.url_copies_cleaned, 2);
  setConsentPeriod(false, null);
});
