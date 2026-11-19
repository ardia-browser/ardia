import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostModule } from "./hostModules.ts";
import { mount } from "../../browser/src/test-hooks.mjs";

const requests = [];
const host = {
  bootstrap: { windowId: "window", profileId: "default" },
  call: async (name, profile, args) => {
    const input = JSON.parse(args);
    requests.push({ name, profile, input });
    if (name === "favicons.fetch") {
      if (typeof input.url !== "string" || Object.keys(input).length !== 1) throw Object.assign(new Error("favicons.fetch requires one icon URL"), { code: "ERR_ENGINE" });
      return JSON.stringify({ uri: "data:image/png;base64,AAAA", width: 32, height: 32 });
    }
    if (name === "favicons.get") return JSON.stringify({ pages: input.pages.includes("https://a.test/") ? { "https://a.test/": { png: "BBBB", icon: "https://a.test/i.png" } } : {}, icons: {} });
    if (name === "favicons.set") return JSON.stringify({ stored: true });
    throw Object.assign(new Error(`${name} isn't a call`), { code: "ERR_ENGINE" });
  },
  invoke: async () => ({}),
  onEvent: () => () => {},
};
globalThis.acTestNativeModules = { ...(globalThis.acTestNativeModules ?? {}), ArdiaFavicons: new Proxy({}, { get: (_target, key) => (typeof key === "string" ? resolveHostModule(host, "ArdiaFavicons", key) : undefined) }) };

const { faviconsFor, fetchFavicon, forgetFavicons, isStoredFavicon, saveLaunchFavicons, storedFaviconAt, storeFavicon } = await import("../../../packages/ardiacore/src/favicons.ts");

test("the shared fetch sends the Linux host exactly the one icon URL it accepts, and gets its data: icon", async () => {
  const image = await fetchFavicon("https://a.test/i.png", "default");
  assert.deepEqual(image, { uri: "data:image/png;base64,AAAA", width: 32, height: 32 });
  assert.deepEqual(requests.at(-1), { name: "favicons.fetch", profile: "default", input: { url: "https://a.test/i.png" } });
  assert.equal(isStoredFavicon(image.uri), false);
});

test("the host that requires one argument refuses a fetch that also names the page, as the Linux engine does", async () => {
  const call = resolveHostModule(host, "ArdiaFavicons", "call");
  await assert.rejects(call("fetch", "default", JSON.stringify({ url: "https://a.test/i.png", page: "https://a.test/" })), /requires one icon URL/);
});

test("the calls only the Mac's icon store answers are never sent to the Linux host", async () => {
  const before = requests.length;
  await forgetFavicons("default");
  assert.deepEqual(saveLaunchFavicons("default", ["ardia-favicon://icon/0123456789abcdef01234567/icon/https%3A%2F%2Fa.test%2Fi.png?v=0123456789abcdef"]), []);
  assert.equal(storedFaviconAt("default", "icon/https%3A%2F%2Fa.test%2Fi.png?v=0123456789abcdef"), null);
  assert.equal(requests.length, before);
});

test("lookups and stored icons on Linux stay data: URIs behind the shared calls", async () => {
  const found = await faviconsFor("default", ["https://a.test/"]);
  assert.deepEqual(found.pages.get("https://a.test/"), { uri: "data:image/png;base64,BBBB", icon: "https://a.test/i.png" });
  assert.equal(await storeFavicon("default", "https://a.test/", "https://a.test/i.png", "CCCC"), "data:image/png;base64,CCCC");
  assert.deepEqual(requests.at(-1).input, { page: "https://a.test/", icon: "https://a.test/i.png", png: "CCCC" });
});

test("a row whose page has no stored icon fetches its icon source through the Linux host and shows it", async () => {
  globalThis.__DEV__ = false;
  const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
  const { resolveFavicon, useFavicon } = await import("../../browser/src/state/favicons/favicons.ts");
  useBrowser.getState().hydrate({});
  const page = "https://no-stored-icon.test/";
  const source = "https://no-stored-icon.test/icon.png";
  const before = requests.length;
  const row = mount(() => useFavicon(page, source, "default"));
  try {
    for (let i = 0; i < 200 && !resolveFavicon(page, source, "default"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(resolveFavicon(page, source, "default")?.uri, "data:image/png;base64,AAAA");
    const sent = requests.slice(before);
    assert.deepEqual(sent.find((r) => r.name === "favicons.fetch")?.input, { url: source });
    for (let i = 0; i < 100 && !sent.some((r) => r.name === "favicons.set") && requests.slice(before).every((r) => r.name !== "favicons.set"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(requests.slice(before).find((r) => r.name === "favicons.set")?.input, { page, icon: source, png: "AAAA" });
    assert.deepEqual([...new Set(requests.slice(before).map((r) => r.name))].sort(), ["favicons.fetch", "favicons.get", "favicons.set"]);
  } finally {
    row.unmount();
  }
});
