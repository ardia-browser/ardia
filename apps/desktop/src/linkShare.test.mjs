import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { linkShareItems, mailtoLink, MORE_SHARE_SERVICE, refreshShareServices, openMailLink, setShareServices, setShareSurface, shareLink, shareLinkVia, shareServicesFrom, shareText, withShareMenus } from "./linkShare.ts";
import { loadShareServices, SHARE_SERVICES_STALL_MS, shareModuleMethod } from "./hostShare.ts";
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
afterEach(() => {
  setShareSurface(null);
  setShareServices([], null);
});

test("an email link carries the title as its subject and the address as its body", () => {
  assert.equal(mailtoLink("https://ardia.dev/a b?x=1&y=2", "Ardia & friends"), "mailto:?subject=Ardia%20%26%20friends&body=https%3A%2F%2Fardia.dev%2Fa%20b%3Fx%3D1%26y%3D2");
  assert.equal(mailtoLink("https://ardia.dev/", null), "mailto:?subject=https%3A%2F%2Fardia.dev%2F&body=https%3A%2F%2Fardia.dev%2F");
});

test("an email's subject never carries the trackers its body was cleaned of, whatever title the page had", async () => {
  const tracked = "https://shop.example/item?id=7&utm_source=mail";
  const seen = surface("email");
  await appModuleFallback(host, "ArdiaApp", "share")(tracked, tracked, "w1", null);
  await appModuleFallback(host, "ArdiaApp", "shareVia")("email", tracked, ` ${tracked}\n`, "w1");
  await appModuleFallback(host, "ArdiaApp", "shareVia")("email", tracked, "https://other.example/?gclid=1&q=2", "w1");
  const clean = encodeURIComponent("https://shop.example/item?id=7");
  assert.deepEqual(seen.opened.map(([url]) => url), [
    `mailto:?subject=${clean}&body=${clean}`,
    `mailto:?subject=${clean}&body=${clean}`,
    `mailto:?subject=${encodeURIComponent("https://other.example/?q=2")}&body=${clean}`,
  ]);
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

test("on a Mac the share submenu lists the system's services and More…, and opening one refreshes the list", () => {
  let refreshed = 0;
  setShareServices(shareServicesFrom([{ title: "AirDrop", menuTitle: "AirDrop" }, { title: "Messages" }, { title: "" }, { title: "copy" }, { title: "bad\nname" }, null]), () => void refreshed++);
  assert.deepEqual(linkShareItems("https://ardia.dev").map((item) => [item.id, item.title]), [["AirDrop", "AirDrop"], ["Messages", "Messages"], [MORE_SHARE_SERVICE, "More…"]]);
  const [share] = withShareMenus([{ id: "share", title: "Share", share: true }]);
  assert.deepEqual(share.children.map((item) => item.id), ["share:via:AirDrop", "share:via:Messages", `share:via:${MORE_SHARE_SERVICE}`]);
  assert.equal(refreshed, 1);
  withShareMenus([{ id: "copy", title: "Copy" }]);
  assert.equal(refreshed, 1, "a menu without Share asks for nothing");
  assert.deepEqual(linkShareItems("file:///Users/me/Shared").map((item) => item.title), ["Copy Link"]);
});

test("the Mac host shares through macOS, keeps Copy Link and Email Link in the shell, and opens sharing settings for More…", async () => {
  const calls = [];
  const mac = { bootstrap: { capabilities: ["ArdiaApp.share", "ArdiaApp.shareVia", "ArdiaApp.shareServices", "ArdiaApp.openSharingSettings"] }, invoke: async (method, args) => (calls.push([method, args.args]), method === "ArdiaApp.shareServices" ? [{ title: "AirDrop", menuTitle: "AirDrop" }] : null) };
  assert.equal(appModuleFallback(mac, "ArdiaApp", "share"), undefined, "Share goes to the host's picker");
  const via = shareModuleMethod(mac, "ArdiaApp", "shareVia");
  const seen = surface();
  await via("copy", "https://shop.example/item?id=7&utm_source=mail", null, "w1");
  await via("AirDrop", "https://shop.example/item?id=7&utm_source=mail", " Item\n", "w1");
  await via(MORE_SHARE_SERVICE, "https://ardia.dev/", null, "w1");
  assert.deepEqual(seen.copied, ["https://shop.example/item?id=7"]);
  assert.deepEqual(calls, [["ArdiaApp.shareVia", ["AirDrop", "https://shop.example/item?id=7", "Item", "w1"]], ["ArdiaApp.openSharingSettings", []]]);
  assert.equal(shareModuleMethod(host, "ArdiaApp", "shareVia"), undefined, "Linux keeps its own Copy and Email menu");
  loadShareServices(mac);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(linkShareItems("https://ardia.dev").map((item) => item.title), ["AirDrop", "More…"]);
});

test("opening a menu waits for the services macOS lists, but never longer than the fallback", async () => {
  let release;
  setShareServices([], () => new Promise((resolve) => (release = () => {
    setShareServices([{ title: "AirDrop", menuTitle: "AirDrop" }]);
    resolve();
  })));
  const waiting = refreshShareServices(1000);
  release();
  await waiting;
  assert.deepEqual(linkShareItems("https://ardia.dev").map((item) => item.title), ["AirDrop", "More…"]);
  setShareServices([], () => new Promise(() => {}));
  const started = Date.now();
  await refreshShareServices(20);
  assert.ok(Date.now() - started < 500, "a stalled host never holds the menu");
  setShareServices([], () => Promise.reject(new Error("host gone")));
  await refreshShareServices(20);
});

test("a services request expires after its deadline even with no second refresh, and only the newest reply is kept", async () => {
  const pending = [];
  const deadlines = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const mac = { bootstrap: { capabilities: ["ArdiaApp.shareServices"] }, invoke: () => new Promise((resolve) => pending.push(resolve)) };
  loadShareServices(mac, (expire, ms) => {
    const deadline = { expire, ms, cleared: false };
    deadlines.push(deadline);
    return () => void (deadline.cleared = true);
  });
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(deadlines[0].ms, SHARE_SERVICES_STALL_MS);
  await refreshShareServices(0);
  await tick();
  assert.equal(pending.length, 1, "a request still within its deadline is reused");
  deadlines[0].expire();
  pending[0]([{ title: "Late", menuTitle: "Late" }]);
  await tick();
  assert.deepEqual(linkShareItems("https://ardia.dev").map((item) => item.title), ["Copy Link", "Email Link"], "a reply after the deadline is ignored");
  await refreshShareServices(0);
  await tick();
  assert.equal(pending.length, 2, "an expired request no longer holds the refresh");
  await refreshShareServices(0);
  pending[1]([{ title: "Messages", menuTitle: "Messages" }, { title: "Messages", menuTitle: "Messages again" }]);
  await tick();
  assert.equal(deadlines[1].cleared, true, "a settled request clears its deadline");
  assert.deepEqual(linkShareItems("https://ardia.dev").map((item) => item.title), ["Messages", "More…"], "same-title services collapse into one");
});

test("More… in File › Share opens the system's sharing settings directly, whatever page is showing", async () => {
  const { isMoreShareChoice, openSharingSettings } = await import("./hostShare.ts");
  assert.equal(isMoreShareChoice("share", `via:${MORE_SHARE_SERVICE}`), true);
  assert.equal(isMoreShareChoice("share", "via:copy"), false);
  assert.equal(isMoreShareChoice("copyUrl", `via:${MORE_SHARE_SERVICE}`), false);
  const calls = [];
  const mac = { bootstrap: { capabilities: ["ArdiaApp.openSharingSettings"] }, invoke: async (method, args) => void calls.push([method, args.args]) };
  await openSharingSettings(mac);
  await openSharingSettings(host);
  assert.deepEqual(calls, [["ArdiaApp.openSharingSettings", []]]);
});

test("a newer click supersedes an earlier app menu open, and a detached anchor never shows a menu", async () => {
  const { beginAppMenuOpen, mayPublishAppMenu } = await import("./appMenuOpen.ts");
  const first = beginAppMenuOpen("w1");
  const other = beginAppMenuOpen("w2");
  const second = beginAppMenuOpen("w1");
  assert.equal(first(), false);
  assert.equal(second(), true);
  assert.equal(other(), true);
  assert.equal(mayPublishAppMenu(second, { isConnected: true }), true);
  assert.equal(mayPublishAppMenu(second, { isConnected: false }), false);
  assert.equal(mayPublishAppMenu(first, { isConnected: true }), false);
});
