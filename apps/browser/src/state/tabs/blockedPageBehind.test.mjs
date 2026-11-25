import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { openFromPage } = await import("./openFromPage.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const BLOCKED = "chrome-extension://fajbdaomknpkicfjcpipdmcpoamdmilh/document-blocked.html?details=%7B%22url%22%3A%22https%3A%2F%2Fads.example%2F%22%7D";

function windowWithTab() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const page = S().windows[w].tabIds[0];
  return { w, page, ref: { windowId: w, profileId: S().windows[w].profileId, tabId: page } };
}

const tabOf = (url) => Object.keys(S().tabs).find((id) => S().tabs[id].url === url);

test("a tab a page opens onto a page uBlock Origin blocked opens behind the page, from a link, a pop-up or a new window", () => {
  for (const request of [
    { url: BLOCKED, disposition: "foreground", fromClick: true, linkWait: "matched" },
    { url: BLOCKED + "&popup", disposition: "foreground", popup: true },
    { url: BLOCKED + "&window", disposition: "window", userGesture: true },
  ]) {
    const { w, page, ref } = windowWithTab();
    const windows = S().windowOrder.length;
    openFromPage(request, ref);
    const opened = tabOf(request.url);
    assert.ok(opened, `${request.disposition} opened a tab`);
    assert.ok(S().windows[w].tabIds.includes(opened), "in the page's own window");
    assert.equal(S().windowOrder.length, windows, "no new window");
    assert.equal(S().windows[w].activeTabIds.default, page, "the page stays in front");
    assert.equal(S().tabs[opened].openerId, page);
  }
});

test("a tab onto any other page still opens in front", () => {
  const { w, ref } = windowWithTab();
  openFromPage({ url: "https://b.example/", disposition: "foreground" }, ref);
  assert.equal(S().windows[w].activeTabIds.default, tabOf("https://b.example/"));
});
