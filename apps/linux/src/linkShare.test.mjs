import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { linkShareItems, mailtoLink, openMailLink, setShareSurface, shareLink, shareLinkVia, shareText, withShareMenus } from "./linkShare.ts";
import { appModuleFallback } from "./appModuleFallbacks.ts";
import { linuxModuleMethod } from "./hostSystem.ts";

const host = { bootstrap: { capabilities: [] } };
const surface = (choice = null) => {
  const seen = { menus: [], copied: [], opened: [] };
  setShareSurface({
    menu: async (items, at) => (seen.menus.push({ items, at }), choice),
    copy: (text) => void seen.copied.push(text),
    openInActivePage: (url, windowId) => (seen.opened.push([url, windowId]), true),
  });
  return seen;
};
afterEach(() => setShareSurface(null));

test("an email link carries the title as its subject and the address as its body", () => {
  assert.equal(mailtoLink("https://ardia.dev/a b?x=1&y=2", "Ardia & friends"), "mailto:?subject=Ardia%20%26%20friends&body=https%3A%2F%2Fardia.dev%2Fa%20b%3Fx%3D1%26y%3D2");
  assert.equal(mailtoLink("https://ardia.dev/", null), "mailto:?subject=https%3A%2F%2Fardia.dev%2F&body=https%3A%2F%2Fardia.dev%2F");
});

test("Share offers Copy Link and Email Link for a web page and only Copy Link for a file", () => {
  assert.deepEqual(linkShareItems("https://ardia.dev").map((item) => item.title), ["Copy Link", "Email Link"]);
  assert.deepEqual(linkShareItems("file:///home/me/links").map((item) => item.title), ["Copy Link"]);
});

test("Share opens below its anchor, copies the link, or emails it through the window's page", async () => {
  const copy = surface("copy");
  await appModuleFallback(host, "ArdiaApp", "share")("https://ardia.dev/", "Ardia", "w1", [10, 20, 30, 40]);
  assert.deepEqual(copy.menus[0].at, { x: 10, y: 64 });
  assert.deepEqual(copy.copied, ["https://ardia.dev/"]);
  const email = surface("email");
  await shareLink("https://ardia.dev/", "Ardia", "w1", null);
  assert.equal(email.menus[0].at, undefined);
  assert.deepEqual(email.opened, [["mailto:?subject=Ardia&body=https%3A%2F%2Fardia.dev%2F", "w1"]]);
  const dismissed = surface(null);
  await shareLink("https://ardia.dev/", "Ardia", "w1", null);
  assert.deepEqual([dismissed.copied, dismissed.opened], [[], []]);
});

test("a chosen service acts without a menu, and an unknown one is refused", async () => {
  const seen = surface();
  await appModuleFallback(host, "ArdiaApp", "shareVia")("copy", "https://ardia.dev/", null, "w1");
  await appModuleFallback(host, "ArdiaApp", "shareVia")("email", "https://ardia.dev/", null, "w1");
  assert.deepEqual(seen, { menus: [], copied: ["https://ardia.dev/"], opened: [["mailto:?subject=https%3A%2F%2Fardia.dev%2F&body=https%3A%2F%2Fardia.dev%2F", "w1"]] });
  await assert.rejects(shareLinkVia("com.apple.share.AirDrop", "https://ardia.dev/", null, "w1"), { code: "ERR_UNAVAILABLE" });
  await assert.rejects(shareLinkVia("email", "file:///home/me/links", null, "w1"), { code: "ERR_UNAVAILABLE" });
});

test("sharing text offers Copy", async () => {
  const seen = surface("copy");
  await appModuleFallback(host, "ArdiaApp", "shareText")("some words", "w1", null);
  assert.deepEqual(seen.menus[0].items.map((item) => item.title), ["Copy"]);
  assert.deepEqual(seen.copied, ["some words"]);
});

test("without a window to show it in, Share is refused instead of silently doing nothing", async () => {
  await assert.rejects(shareLink("https://ardia.dev/", null, null, null), { code: "ERR_UNAVAILABLE" });
  await assert.rejects(shareText("words", null, null), { code: "ERR_UNAVAILABLE" });
});

test("openExternalURL sends an email link through the page and refuses every other scheme", async () => {
  const open = linuxModuleMethod(host, "ArdiaApp", "openExternalURL");
  assert.equal(await open("mailto:?subject=a&body=b"), false);
  const seen = surface();
  assert.equal(await open("mailto:?subject=a&body=b"), true);
  assert.equal(await open("x-apple.systempreferences:com.apple.preference"), false);
  assert.equal(await open("https://ardia.dev/"), false);
  assert.deepEqual(seen.opened, [["mailto:?subject=a&body=b", null]]);
  assert.equal(openMailLink("MAILTO:someone@example.com", "w2"), true);
});

test("a menu's Share row gains the Linux share choices under its own id", () => {
  const items = withShareMenus([{ id: "copy", title: "Copy Link" }, { separator: true }, { id: "share", title: "Share", share: true }, { id: "more", title: "More", children: [{ id: "s2", title: "Share", share: true }] }]);
  assert.deepEqual(items[2].children.map((item) => item.id), ["share:via:copy", "share:via:email"]);
  assert.deepEqual(items[3].children[0].children.map((item) => item.id), ["s2:via:copy", "s2:via:email"]);
  assert.equal(items[0].children, undefined);
});
