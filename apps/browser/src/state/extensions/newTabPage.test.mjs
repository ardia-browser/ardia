import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HOSTILE_VALUES, URL_SCHEMES } from "../../../../../scripts/security/hostile-inputs.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId, engineProfile } = await import("../browser/model.ts");
const { customNewTabUrl } = await import("../settings/settings.ts");
const { runCommand } = await import("../commands/commands.ts");
const { useExtensions } = await import("./store.ts");
const { extensionNewTabPage } = await import("./newTabPage.ts");
const { takeNewTabPageCounts } = await import("../telemetry/newTabPageCounts.ts");
const client = await import("../telemetry/client.ts");
client.loadChoice();
client.setSharing(true, "onboarding");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();
const shownUrl = (w) => S().tabs[activeTabId(S(), w)].url;
const CADRAN = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";
const SPEED_DIAL = "imfeikbeimbfpmgfkkmjekabdehiiajc";
const label = (value) => (typeof value === "string" ? value.slice(0, 80) : typeof value);
const extension = (id, newTabPage, more = {}) => ({ id, name: id, enabled: true, newTabPage, ...more });

function reset(settings = {}, list = []) {
  S().hydrate({});
  S().updateSettings(settings);
  const w = S().createWindow({ url: "https://a.com/" });
  useExtensions.setState({ lists: { [engineProfile(S(), S().windows[w].profileId)]: list } });
  takeNewTabPageCounts();
  return w;
}

test("#1126: an extension's page is a custom New Tab address, so Cadran's page opens on ⌘T", () => {
  const url = `chrome-extension://${CADRAN}/app/app.html`;
  assert.equal(customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl: url }), url);
  assert.equal(customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl: url.replace("chrome-extension", "CHROME-EXTENSION") }), url);
  const w = reset({ newTabUrl: url });
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), url);
  assert.deepEqual(takeNewTabPageCounts(), { new_tab_extension_overrides: 0, new_tab_extension_addresses: 1 });
});

test("#1126: an extension address with a malformed id is still refused", () => {
  for (const newTabUrl of ["chrome-extension://short/app.html", `chrome-extension://${"z".repeat(32)}/app.html`, `chrome-extension://${CADRAN}x/app.html`, "chrome-extension://"]) {
    assert.equal(customNewTabUrl({ newTabOpens: "page", minimalismMode: false, newTabUrl }), undefined, newTabUrl);
  }
});

test("#1126: an installed extension's chrome_url_overrides.newtab opens on ⌘T, the New Tab row and in a new window", () => {
  const w = reset({}, [extension(SPEED_DIAL, "dial.html")]);
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), `chrome-extension://${SPEED_DIAL}/dial.html`, "⌘T");
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), `chrome-extension://${SPEED_DIAL}/dial.html`, "the New Tab row");
  assert.equal(shownUrl(S().createWindow()), `chrome-extension://${SPEED_DIAL}/dial.html`, "a new window");
  assert.deepEqual(takeNewTabPageCounts(), { new_tab_extension_overrides: 3, new_tab_extension_addresses: 0 });
});

test("#1126: a custom New Tab address wins over an extension's, and Command Bar mode keeps the command bar", () => {
  const w = reset({ newTabUrl: "example.com" }, [extension(SPEED_DIAL, "dial.html")]);
  runCommand({ command: "newTab", arg: null, windowId: w });
  assert.equal(shownUrl(w), "https://example.com");
  const bar = reset({ newTabOpens: "commandBar" }, [extension(SPEED_DIAL, "dial.html")]);
  S().newTab(bar, { newTabCommand: true });
  assert.equal(shownUrl(bar), "");
});

test("#1126: a disabled extension, one without an override and a private window keep the New Tab page", () => {
  const w = reset({}, [extension(CADRAN, null), extension(SPEED_DIAL, "dial.html", { enabled: false })]);
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), "");
  reset({}, [extension(SPEED_DIAL, "dial.html")]);
  const dark = S().createWindow({ kind: "private" });
  S().newTab(dark, { newTabCommand: true });
  assert.equal(shownUrl(dark), "");
});

test("#1126: the override path stays inside its extension, and hostile manifest values open nothing", () => {
  assert.equal(extensionNewTabPage(extension(CADRAN, "/app/app.html")), `chrome-extension://${CADRAN}/app/app.html`);
  assert.equal(extensionNewTabPage(extension(CADRAN, "index.html#home")), `chrome-extension://${CADRAN}/index.html#home`);
  const prefix = `chrome-extension://${CADRAN}/`;
  const insideItsExtension = (url) => url.startsWith(prefix) && new URL(url).href.startsWith(prefix) && new URL(url).host === CADRAN && !/[\s\\]/.test(url);
  const hostile = [...HOSTILE_VALUES.map(({ value }) => value), ...Object.values(URL_SCHEMES), "https://evil.example/", `chrome-extension://${SPEED_DIAL}/dial.html`, "//evil.example/x.html"];
  for (const value of hostile) {
    const url = extensionNewTabPage(extension(CADRAN, value));
    assert.ok(url === undefined || insideItsExtension(url), `${label(value)} -> ${url}`);
  }
  const refused = [...Object.values(URL_SCHEMES).filter((url) => typeof url === "string" && /^\s*[a-z][\w+.-]*:/i.test(url)), "../other/page.html", "app/../../page.html", "./page.html", "app//page.html", "", "/", "https://evil.example/", "javascript:alert(1)", `chrome-extension://${SPEED_DIAL}/dial.html`, "a b.html", "a\\b.html", "a\nb.html", "a".repeat(2000)];
  for (const value of refused) assert.equal(extensionNewTabPage(extension(CADRAN, value)), undefined, label(value));
  for (const id of [...HOSTILE_VALUES.map(({ value }) => value), "short", `${CADRAN}/x`, CADRAN.toUpperCase()]) assert.equal(extensionNewTabPage(extension(id, "dial.html")), undefined, label(id));
  const w = reset({}, refused.map((value, i) => extension(CADRAN.slice(0, 31) + "abcdefghijklmnop"[i % 16], value)));
  S().newTab(w, { newTabCommand: true });
  assert.equal(shownUrl(w), "", "the sink: no new tab opens a hostile override");
});
