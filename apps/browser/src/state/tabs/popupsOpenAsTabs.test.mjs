import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { DEFAULT_SETTINGS } = await import("../settings/settings.ts");
const { isConfigSettingKey } = await import("../settings/configAllowlist.ts");
const { openFromPage } = await import("./openFromPage.ts");
const { takePopupTabCounts } = await import("../telemetry/popupTabCounts.ts");
const { setOpeningGate } = await import("./openingGate.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

function windowWithTab() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const page = S().windows[w].tabIds[0];
  return { w, page, ref: (tabId) => ({ windowId: w, profileId: S().windows[w].profileId, tabId }) };
}

const popupTabOf = (url) => Object.keys(S().tabs).find((id) => S().tabs[id].url === url);

test("pop-ups stay windows unless the switch is on, and config.json can set it", () => {
  assert.equal(DEFAULT_SETTINGS.popupsOpenAsTabs, false);
  assert.equal(isConfigSettingKey("popupsOpenAsTabs"), true);
});

test("a pop-up the engine hands over as a tab opens next to its page and is counted; a link tab is not", () => {
  const { w, ref, page } = windowWithTab();
  takePopupTabCounts();
  openFromPage({ url: "https://a.example/popup", disposition: "foreground", popup: true }, ref(page));
  openFromPage({ url: "https://a.example/link", disposition: "foreground", linkWait: "matched" }, ref(page));
  const urls = S().windows[w].tabIds.map((id) => S().tabs[id].url);
  assert.ok(urls.includes("https://a.example/popup"));
  assert.deepEqual(takePopupTabCounts(), { popups_opened_as_tabs: 1 });
});

test("a pop-up from a Peek keeps the Peek's page as a tab, opens in front of it, and closing it goes back there", () => {
  const { w, page, ref } = windowWithTab();
  const peek = S().openPeek(page, "https://signin.example/start");
  takePopupTabCounts();
  openFromPage({ url: "https://signin.example/popup", disposition: "foreground", popup: true }, ref(peek));
  const popup = popupTabOf("https://signin.example/popup");
  assert.ok(popup);
  assert.ok(S().tabs[peek], "the page that opened the pop-up is still open");
  assert.equal(S().peeks[page], undefined);
  assert.deepEqual(S().windows[w].tabIds.slice(0, 3), [page, peek, popup]);
  assert.equal(S().tabs[popup].openerId, peek);
  assert.equal(S().windows[w].activeTabIds.default, popup);
  assert.deepEqual(takePopupTabCounts(), { popups_opened_as_tabs: 1 });
  S().updateTab(peek, { lastActiveAt: S().tabs[page].lastActiveAt });
  S().closeTab(popup);
  assert.equal(S().windows[w].activeTabIds.default, peek);
});

async function openThroughGate(w, peek, ref, answer, meanwhile = () => {}) {
  let settle;
  setOpeningGate(() => new Promise((resolve) => (settle = resolve)));
  try {
    openFromPage({ url: "https://signin.example/popup", disposition: "foreground", popup: true }, ref(peek));
    meanwhile();
    settle(answer);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    setOpeningGate(null);
  }
}

test("a pop-up from a Peek that an opening rule cancels leaves the Peek a Peek", async () => {
  const { w, page, ref } = windowWithTab();
  const peek = S().openPeek(page, "https://signin.example/start");
  const tabs = [...S().windows[w].tabIds];
  await openThroughGate(w, peek, ref, { cancel: true });
  assert.equal(popupTabOf("https://signin.example/popup"), undefined);
  assert.equal(S().peeks[page]?.tabId, peek);
  assert.deepEqual(S().windows[w].tabIds, tabs);
});

test("a pop-up whose Peek you close while the opening rule decides still opens in front", async () => {
  const { w, page, ref } = windowWithTab();
  const other = S().newTab(w, { url: "https://b.example/", background: true });
  const peek = S().openPeek(page, "https://signin.example/start");
  await openThroughGate(w, peek, ref, null, () => {
    S().activate(other);
    S().closePeek(page);
  });
  const popup = popupTabOf("https://signin.example/popup");
  assert.ok(popup);
  assert.equal(S().tabs[peek], undefined);
  assert.equal(S().windows[w].activeTabIds.default, popup);
});

test("a pop-up from a Peek hidden behind another tab keeps that Peek's page as a tab, not another tab's Peek", () => {
  const { w, page, ref } = windowWithTab();
  const other = S().newTab(w, { url: "https://b.example/", background: true });
  const peek = S().openPeek(page, "https://signin.example/start");
  S().activate(other);
  const otherPeek = S().openPeek(other, "https://c.example/");
  openFromPage({ url: "https://signin.example/popup", disposition: "foreground", popup: true }, ref(peek));
  const popup = popupTabOf("https://signin.example/popup");
  assert.ok(popup);
  assert.equal(S().peeks[page], undefined);
  assert.ok(S().windows[w].tabIds.includes(peek), "the hidden Peek's page became a tab");
  assert.equal(S().peeks[other]?.tabId, otherPeek, "the shown Peek stays a Peek");
  assert.equal(S().tabs[popup].openerId, peek);
});
