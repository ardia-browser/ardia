import assert from "node:assert/strict";
import { test } from "node:test";
await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const { openExternalUrls } = await import("./actions.ts");
const { admitIncomingUrl } = await import("./incomingUrls.ts");
const { setLinkGate } = await import("./linkGate.ts");
const { noteIncomingLinksRefused, takeExternalAppCounts } = await import("../telemetry/externalAppCounts.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

const ADMITTED = [
  ["https://example.com/a?b#c", "https://example.com/a?b#c"],
  ["HTTP://Example.com/", "HTTP://Example.com/"],
  ["file:///Users/me/page.html", "file:///Users/me/page.html"],
  ["file:///C:/Users/me/doc.pdf", "file:///C:/Users/me/doc.pdf"],
  ["about:blank", "about:blank"],
  ["ardia://history", "ardia://history"],
  ["ardia://bookmarks?q=otters", "ardia://bookmarks?q=otters"],
  ["ardia://downloads", "ardia://downloads"],
  ["ardia://newtab", "ardia://newtab"],
  ["ardia://settings", "ardia://settings"],
  ["ardia://settings/passwords", "ardia://settings/passwords"],
  ["ARDIA://Settings/Appearance", "ardia://settings/Appearance"],
  ["ardia:history", "ardia://history"],
  ["ardia://game", "ardia://game"],
  ["ardia://version", "ardia://version"],
  ["chrome://history", "ardia://history"],
  ["netnyahoo://yahu", "ardia://game"],
  ["netnyahoo://bookmarks", "ardia://bookmarks"],
];

const REFUSED = [
  "ardia://restart",
  "ardia://quit",
  "ardia://kill",
  "ardia://crash",
  "ardia://hang",
  "ardia://gpuclean",
  "ardia://gpucrash",
  "ardia://inducebrowsercrashforrealz",
  "ardia://flags",
  "ardia://flags/#enable-x",
  "ardia://net-internals",
  "ardia://net-export",
  "ardia://extensions",
  "ardia://extensions/?id=abc",
  "ardia://policy",
  "ardia://inspect",
  "ardia://password-manager/passwords",
  "ardia://settings-reset",
  "ardia://settings/reset",
  "ardia://settings/clearBrowserData",
  "ardia://chrome-urls",
  "ardia://downloads-internals",
  "ardia://",
  "ardia:",
  "ARDIA://FLAGS",
  "Ardia://Restart",
  "ardia:flags",
  "ardia:restart",
  "ardia://%66lags",
  "ardia://%72estart",
  "ardia://history%2f..%2fflags",
  "ardia://history@flags",
  "ardia://settings@restart",
  "ardia://version\\..\\restart",
  " ardia://flags",
  "ardia://flags ",
  "\tardia://restart",
  "ardia://restart\n",
  "ardia://fl\nags",
  "ardia://re\u0000start",
  "\u200bardia://flags",
  "\ufeffardia://quit",
  "ardia://quit\u00a0",
  "chrome://flags",
  "chrome://restart",
  "CHROME://quit",
  "chrome:kill",
  "chrome://version\u2028",
  "netnyahoo://flags",
  "NETNYAHOO://restart",
  "netnyahoo:quit",
  "about:flags",
  "about:restart",
  "about:version ",
  "ABOUT:crash",
  "view-source:ardia://settings",
  "view-source:chrome://flags",
  "view-source:netnyahoo://version",
  "view-source:https://example.com/",
  "VIEW-SOURCE:ardia://history",
  "chrome-untrusted://terminal",
  "devtools://devtools/bundled/inspector.html",
  "chrome-extension://abc/page.html",
  "data:text/html,<b>x</b>",
  "blob:https://example.com/123",
  "filesystem:https://example.com/temporary/x",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "mailto:a@example.com",
  "http:/example.com",
  "http:\\\\example.com",
  "https://",
  "https:///flags",
  "https:example.com",
  " https://example.com/",
  "https://exa mple.com/",
  "https://example.com/\r\nx",
  "about:srcdoc",
  "",
];

for (const [given, expected] of ADMITTED) {
  test(`a link from another app to ${JSON.stringify(given)} is admitted as ${expected}`, () => {
    assert.equal(admitIncomingUrl(given), expected);
  });
}

for (const given of REFUSED) {
  test(`a link from another app to ${JSON.stringify(given)} is refused`, () => {
    assert.equal(admitIncomingUrl(given), null);
  });
}

function mainWindow(settings = {}) {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"], windows: {}, tabs: {} });
  const main = S().createWindow({ url: "https://main.example/" });
  S().setFocusedWindow(main);
  S().updateSettings({ openLinksInLittleArdia: false, allowJavaScriptFromAppleEvents: false, ...settings });
  return main;
}

const allTabUrls = () => Object.values(S().tabs).map((t) => t.url);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

for (const gated of [false, true]) {
  test(`links from other apps never open internal pages, legacy aliases included (${gated ? "with" : "without"} a link gate)`, async () => {
    setLinkGate(gated ? (url) => ({ url, route: null, decided: false }) : null);
    mainWindow();
    const refused = openExternalUrls(["ardia://restart", "netnyahoo://flags", "chrome://quit", "about:kill", "view-source:ardia://settings", "https://ok.example/", "ardia://history"]);
    await settle();
    const urls = allTabUrls();
    assert.ok(urls.includes("https://ok.example/"));
    assert.ok(urls.includes("ardia://history"));
    for (const url of urls) assert.ok(!/restart|flags|quit|kill|view-source/i.test(url ?? ""), `opened ${url}`);
    assert.equal(refused, 5);
    setLinkGate(null);
  });
}

test("a link gate can't turn a link from another app into an internal page", async () => {
  setLinkGate(() => ({ url: "ardia://flags", route: null, decided: true }));
  mainWindow();
  openExternalUrls(["https://ok.example/"]);
  await settle();
  assert.ok(!allTabUrls().some((url) => /flags/.test(url ?? "")));
  setLinkGate(null);
});

test("a routed link from another app is still checked when the gate rewrites it", async () => {
  setLinkGate(() => ({ url: "chrome://restart", route: { profileId: null, open: "tab", windowId: null, groupKey: null }, decided: true }));
  mainWindow();
  openExternalUrls(["https://ok.example/"]);
  await settle();
  assert.ok(!allTabUrls().some((url) => /restart/.test(url ?? "")));
  setLinkGate(null);
});

test("JavaScript links from other apps open only with Allow JavaScript from Apple Events on", async () => {
  mainWindow();
  openExternalUrls(["javascript:void(1)"]);
  await settle();
  assert.ok(!allTabUrls().some((url) => /^javascript:/i.test(url ?? "")));
});

test("refused links from other apps are summed into the hourly external app counts", () => {
  takeExternalAppCounts();
  noteIncomingLinksRefused(2);
  noteIncomingLinksRefused(0);
  assert.equal(takeExternalAppCounts().incoming_links_refused, 2);
  assert.equal(takeExternalAppCounts().incoming_links_refused, 0);
});
