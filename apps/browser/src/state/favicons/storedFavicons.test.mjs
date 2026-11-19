import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

globalThis.__DEV__ = false;

const native = import.meta.resolve("../../platform/favicons.ts");
const stub = `export * from ${JSON.stringify(native)};
export const faviconsFor = () => Promise.resolve({ pages: new Map(), icons: new Map() });
export const forgetFavicons = (profile) => (globalThis.forgotten.push(profile), Promise.resolve(null));
export const storedFaviconAt = (profile, path) => (globalThis.tokens[profile] ? "ardia-favicon://icon/" + globalThis.tokens[profile] + "/" + path : null);
export const saveLaunchFavicons = (profile, uris) => (globalThis.saved.push([profile, uris]), uris.filter((uri) => globalThis.kept.has(uri)));`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../platform/favicons" && /\/state\/favicons\/(favicons|launchFavicons)\.ts$/.test(context.parentURL ?? ""))
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { resolveFavicon, startFavicons, useFavicons } = await import("./favicons.ts");
const { launchFavicons, seedFavicons } = await import("./launchFavicons.ts");
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { chromeHistoryEvent } = await import("../../test-native/ardiacore.ts");

const OLD = "0123456789abcdef01234567";
const NEW = "fedcba9876543210fedcba98";
const address = (token, kind, url, revision) => `ardia-favicon://icon/${token}/${kind}/${encodeURIComponent(url)}?v=${revision}`;

function reset() {
  globalThis.forgotten = [];
  globalThis.saved = [];
  globalThis.kept = new Set();
  globalThis.tokens = {};
  useBrowser.getState().hydrate({});
  useFavicons.setState({ profiles: {}, themes: {} });
}

function tabAt(url, favicon = null) {
  const S = useBrowser.getState();
  const windowId = S.createWindow({ url });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  useBrowser.getState().updateTab(tabId, { url, favicon });
  return useBrowser.getState().tabs[tabId];
}

test("the launch look keeps relative addresses, and only those the native snapshot saved", () => {
  reset();
  const key = engineProfile(useBrowser.getState(), "default");
  const saved = address(OLD, "icon", "https://a.test/favicon.ico", "00112233445566aa");
  const unsaved = address(OLD, "page", "https://b.test/", "00112233445566bb");
  const a = tabAt("https://a.test/", "https://a.test/favicon.ico");
  const b = tabAt("https://b.test/");
  const c = tabAt("https://c.test/");
  useFavicons.setState({
    profiles: { [key]: { pages: { "https://a.test/": saved, "https://b.test/": unsaved, "https://c.test/": "data:image/png;base64,CCCC" }, srcs: { "https://a.test/favicon.ico": saved }, appearances: {} } },
    themes: { [saved]: { kind: "blur" } },
  });
  globalThis.kept.add(saved);
  const look = launchFavicons([a, b, c]);
  assert.deepEqual(globalThis.saved, [[key, [saved, unsaved]]]);
  const json = JSON.stringify(look);
  assert.ok(!json.includes(OLD), "no token is written to disk");
  assert.ok(!json.includes("https%3A%2F%2Fb.test"), "an icon the snapshot lacks is not promised at launch");
  assert.equal(look.profiles[key].pages["https://b.test/"], undefined);
  assert.equal(look.images[look.profiles[key].pages["https://a.test/"]], "icon/https%3A%2F%2Fa.test%2Ffavicon.ico?v=00112233445566aa");
  assert.equal(look.images[look.profiles[key].pages["https://c.test/"]], "data:image/png;base64,CCCC");

  reset();
  globalThis.tokens[key] = NEW;
  seedFavicons(look);
  const relaunched = address(NEW, "icon", "https://a.test/favicon.ico", "00112233445566aa");
  assert.equal(resolveFavicon("https://a.test/", null, "default")?.uri, relaunched, "a relaunch names the icon under the new session's token");
  assert.deepEqual(useFavicons.getState().themes[relaunched], { kind: "blur" });
  assert.equal(resolveFavicon("https://c.test/", null, "default")?.uri, "data:image/png;base64,CCCC");

  reset();
  seedFavicons(look);
  assert.equal(resolveFavicon("https://a.test/", null, "default"), null, "where no store answers, a relative address seeds nothing");
});

test("removing a page from history drops its icon natively and in JS, and an open tab keeps the icon it shows", async () => {
  reset();
  const stop = startFavicons();
  try {
    const key = engineProfile(useBrowser.getState(), "default");
    const shown = address(OLD, "icon", "https://a.test/favicon.ico", "00112233445566aa");
    const gone = address(OLD, "icon", "https://b.test/favicon.ico", "00112233445566bb");
    tabAt("https://a.test/other", "https://a.test/favicon.ico");
    useFavicons.setState({
      profiles: { [key]: { pages: { "https://a.test/": shown, "https://b.test/": gone }, srcs: { "https://a.test/favicon.ico": shown, "https://b.test/favicon.ico": gone }, appearances: {} } },
      themes: {},
    });
    chromeHistoryEvent({ kind: "deleted", profile: key, all: false, urls: ["https://a.test/", "https://b.test/"] });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const icons = useFavicons.getState().profiles[key];
    assert.deepEqual(Object.keys(icons.pages), []);
    assert.deepEqual(icons.srcs, { "https://a.test/favicon.ico": shown });
    assert.deepEqual(globalThis.forgotten, [key]);
  } finally {
    stop();
  }
});
