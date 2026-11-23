import assert from "node:assert/strict";
import { test } from "node:test";
const { shellNativeModules } = await import("../../test-native/index.ts");
const { copyLinkFromPageMenu, startPageLinkCopies } = await import("./pageLinkCopy.ts");
const { emitEvent, webKitAddressWrites } = await import("../../test-native/ardiacore.ts");
const { copyFieldSelection } = await import("../omnibox/paste.ts");
const { shareFromPage, shareTab } = await import("./share.ts");
const { takeUrlCopyCounts } = await import("../telemetry/urlCopies.ts");
const { useBrowser } = await import("../browser/store.ts");
const { copyUrls } = await import("../sidebar/actions.ts");
const { consentToken, setConsentPeriod } = await import("../telemetry/consentPeriod.ts");

setConsentPeriod(true, "link-copies");

const copied = [];
const shared = [];
shellNativeModules.ArdiaShell.copyText = (text) => void copied.push(text);
shellNativeModules.ArdiaApp.share = (url, title) => void shared.push([url, title]);
shellNativeModules.ArdiaApp.shareVia = (service, url, title) => void shared.push(title === undefined || title === null ? [service, url] : [service, url, title]);
const tracked = "https://shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews";
const clean = "https://shop.example/item?id=7#reviews";
const reset = () => {
  copied.length = 0;
  shared.length = 0;
  takeUrlCopyCounts();
};

test("Copy Link, Image or Media Address in a WebKit page hands native the address without trackers, and counts only what native wrote", async () => {
  reset();
  webKitAddressWrites.written.length = 0;
  assert.equal(await copyLinkFromPageMenu(tracked, 1, consentToken()), true);
  assert.equal(await copyLinkFromPageMenu("https://example.com/plain.png", 2, consentToken()), true);
  assert.equal(await copyLinkFromPageMenu("blob:https://example.com/1234?utm_source=x", 3, consentToken()), true);
  assert.deepEqual(webKitAddressWrites.written, [
    { request: 1, url: clean },
    { request: 2, url: "https://example.com/plain.png" },
    { request: 3, url: "blob:https://example.com/1234?utm_source=x" },
  ]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_from_webkit_menu, 3);
  assert.equal(counts.url_copies_cleaned, 1);
});

test("a WebKit copy native declined, because a newer menu copy or another copy came first, is not counted", async () => {
  reset();
  const answer = webKitAddressWrites.answer;
  webKitAddressWrites.answer = () => false;
  try {
    assert.equal(await copyLinkFromPageMenu(tracked, 4, consentToken()), false);
  } finally {
    webKitAddressWrites.answer = answer;
  }
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_from_webkit_menu, 0);
  assert.equal(counts.url_copies_cleaned, 0);
});

test("a WebKit menu copy with no address, one that isn't text, or no request number, copies nothing", async () => {
  reset();
  webKitAddressWrites.written.length = 0;
  for (const value of [undefined, null, "", 42, {}, ["https://a.example/?utm_source=x"]]) assert.equal(await copyLinkFromPageMenu(value, 1, consentToken()), false);
  for (const request of [undefined, null, 1.5, "1", NaN]) assert.equal(await copyLinkFromPageMenu(tracked, request, consentToken()), false);
  assert.deepEqual(webKitAddressWrites.written, []);
  assert.equal(takeUrlCopyCounts().url_copies_from_webkit_menu, 0);
});

test("the address field copies what it shows, trackers included, as Chrome and Safari do (owner decision)", () => {
  reset();
  const shown = "shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews";
  copyFieldSelection(shown, 0, shown.length, tracked);
  copyFieldSelection(shown, 18, 38, tracked);
  copyFieldSelection(shown, 0, 12, tracked);
  copyFieldSelection("typed?utm_source=x", 0, 18, null);
  assert.deepEqual(copied, [tracked, "id=7&utm_source=mail", "shop.example", "typed?utm_source=x"]);
  const counts = takeUrlCopyCounts();
  assert.equal(counts.url_copies_cleaned, 0);
  assert.equal(counts.url_copies_uncleaned, 0);
});

test("sharing a page, a link or a tab sends the address without trackers, and a shared image file as it is", async () => {
  reset();
  const tab = { url: tracked, title: "Item", customTitle: null, windowId: "w1" };
  await shareFromPage(tab, { kind: "page" });
  await shareFromPage(tab, { kind: "link", url: "https://news.example/a?gclid=1&page=2", title: "A" });
  await shareFromPage(tab, { kind: "image", url: "https://cdn.example/i.png?utm_medium=x", fileUrl: "file:///tmp/Ardia%20Shared%20Images/i.png?utm_source=x" });
  await shareTab(tab, "w1", "com.apple.share.Mail.compose");
  assert.deepEqual(shared, [
    [clean, "Item"],
    ["https://news.example/a?page=2", "A"],
    ["file:///tmp/Ardia%20Shared%20Images/i.png?utm_source=x", null],
    ["com.apple.share.Mail.compose", clean, "Item"],
  ]);
});

test("a shared page or link whose title is a tracked address shares that title without trackers too", async () => {
  reset();
  const tab = { url: tracked, title: tracked, customTitle: null, windowId: "w1" };
  await shareTab(tab, "w1");
  await shareTab(tab, "w1", "com.apple.share.Mail.compose");
  await shareTab({ ...tab, customTitle: "https://other.example/p?ref=1&utm_campaign=z" }, "w1");
  await shareFromPage(tab, { kind: "link", url: "https://news.example/a?gclid=1&page=2", title: "https://news.example/a?gclid=1&page=2" });
  assert.deepEqual(shared, [
    [clean, clean],
    ["com.apple.share.Mail.compose", clean, clean],
    [clean, "https://other.example/p?ref=1"],
    ["https://news.example/a?page=2", "https://news.example/a?page=2"],
  ]);
});

test("a single cleaned address goes to the native URL writer when the build has one, so apps that read the URL flavour get it", () => {
  reset();
  const urls = [];
  shellNativeModules.ArdiaShell.copyURL = (address) => void urls.push(address);
  try {
    copyFieldSelection("shop.example/item?id=7&utm_source=mail&fbclid=abc#reviews", 0, 4, tracked);
  } finally {
    delete shellNativeModules.ArdiaShell.copyURL;
  }
  assert.deepEqual(urls, []);
  assert.deepEqual(copied, ["shop"]);
});

test("copying an untitled tab as Markdown from the sidebar labels it with the clean address, not the one with trackers", () => {
  reset();
  const S = () => useBrowser.getState();
  S().hydrate({});
  const w = S().createWindow({ url: "https://example.com/item?utm_source=mail" });
  const first = S().windows[w].tabIds[0];
  const second = S().newTab(w, { url: "https://shop.example/a?id=7&fbclid=1" });
  copyUrls([first], true);
  copyUrls([first, second], true);
  assert.deepEqual(copied, [
    "[https://example.com/item](https://example.com/item)",
    "- [https://example.com/item](https://example.com/item)\n- [https://shop.example/a?id=7](https://shop.example/a?id=7)",
  ]);
  assert.equal(takeUrlCopyCounts().url_copies_cleaned, 3);
});

test("a WebKit page menu copy arrives as an app-wide event with its native request number, so it lands even after its page view is gone", async () => {
  reset();
  webKitAddressWrites.written.length = 0;
  const stop = startPageLinkCopies();
  try {
    emitEvent("webKit.copyAddress", { url: tracked, request: 41, epoch: "link-copies" });
    emitEvent("webKit.copyAddress", { url: "https://example.com/plain.png", request: 42, epoch: "link-copies" });
    emitEvent("webKit.copyAddress", { url: tracked, request: 1.5, epoch: "link-copies" });
    emitEvent("webKit.copyAddress", { url: tracked, request: 43 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    stop?.remove?.();
  }
  assert.deepEqual(webKitAddressWrites.written, [
    { request: 41, url: clean },
    { request: 42, url: "https://example.com/plain.png" },
    { request: 43, url: clean },
  ]);
  assert.equal(takeUrlCopyCounts().url_copies_from_webkit_menu, 2);
});
