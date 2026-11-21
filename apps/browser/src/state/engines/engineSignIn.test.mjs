import assert from "node:assert/strict";
import { test } from "node:test";

const webKit = { cookies: [], storage: {}, writes: [], released: [], releasedWith: [], listeners: [], writeHold: null, writing: false, readDelay: 0 };
const key = (c) => `${c.name}|${c.domain}|${c.path}`;
const webKitCalls = {
  watchSiteData: () => null,
  siteDataReady: ({ id }) => (webKit.released.push(id), webKit.releasedWith.push(webKit.cookies.map((c) => c.domain)), null),
  readSiteData: ({ origins }) => ({ cookies: webKit.cookies, storage: Object.fromEntries(origins.map((o) => [o, webKit.storage[o] ?? []])) }),
  writeSiteData: ({ profile, set, remove, storage }) => {
    webKit.writes.push({ profile, set, remove, storage });
    webKit.cookies = [...webKit.cookies.filter((c) => !remove.some((r) => key(r) === key(c)) && !set.some((s) => key(s) === key(c))), ...set];
    for (const [origin, change] of Object.entries(storage)) {
      const kept = (webKit.storage[origin] ?? []).filter(([k]) => !change.remove.includes(k) && !change.set.some(([s]) => s === k));
      webKit.storage[origin] = [...kept, ...change.set];
    }
    return { cookies: set.length, removed: remove.length, storage: Object.values(storage).reduce((n, c) => n + c.set.length + c.remove.length, 0) };
  },
  exportCookies: () => 0,
};
globalThis.acTestNativeModules = {
  ArdiaWebKit: {
    addListener: (_event, listener) => (webKit.listeners.push(listener), { remove() {} }),
    call: async (name, profile, json) => {
      if (name === "readSiteData" && webKit.readDelay) await new Promise((resolve) => setTimeout(resolve, webKit.readDelay));
      if (name === "writeSiteData" && webKit.writeHold) {
        webKit.writing = true;
        await webKit.writeHold;
      }
      return JSON.stringify(webKitCalls[name]({ ...JSON.parse(json), profile }) ?? null);
    },
  },
};

const { useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { carrySignIn } = await import("./engineSignIn.ts");
const { carrySite, clearSiteDataEverywhere, resetSiteDataForTest, startSiteData } = await import("./siteData.ts");
const { clearBrowsingData } = await import("../profiles/profileData.ts");
const stub = await import("../../test-native/index.ts");
startSiteData();

const S = () => useBrowser.getState();
const ORIGIN = "https://app.test";
const signedIn = { name: "sid", value: "chromium", domain: ".app.test", path: "/", expires: -1, session: true, httpOnly: true, secure: true };
const sso = { name: "SSID", value: "g", domain: ".google.com", path: "/", expires: -1, session: true, httpOnly: true, secure: true };

function chromiumPage(jar = { cookies: [], storage: {} }, readDelay = 0) {
  const writes = [];
  let hold = null;
  const page = {
    writes,
    jar,
    readDelay,
    holdReads() {
      let answer;
      hold = new Promise((resolve) => (answer = resolve));
      return () => answer();
    },
    siteData: async (request) => {
      if (request.op === "read") {
        if (hold) await hold;
        if (page.readDelay) await new Promise((resolve) => setTimeout(resolve, page.readDelay));
        const covered = (d) => request.domains.some((w) => d.replace(/^\./, "") === w || d.replace(/^\./, "").endsWith(`.${w}`));
        return { cookies: jar.cookies.filter((c) => covered(c.domain)), storage: Object.fromEntries(request.origins.map((o) => [o, jar.storage[o] ?? []])) };
      }
      writes.push(request);
      const written = request.cookies.map((c) => ({ ...c, domain: c.domain ?? new URL(c.url).hostname }));
      jar.cookies = [...jar.cookies.filter((c) => ![...request.remove, ...written].some((r) => key(r) === key(c))), ...written];
      for (const [origin, change] of Object.entries(request.storage))
        jar.storage[origin] = [...(jar.storage[origin] ?? []).filter(([k]) => !change.remove.includes(k) && !change.set.some(([s]) => s === k)), ...change.set];
      return { cookiesWritten: request.cookies.length, removed: request.remove.length, storageWritten: Object.values(request.storage).reduce((n, c) => n + c.set.length + c.remove.length, 0) };
    },
  };
  return page;
}

function setup({ kind, settings } = {}) {
  S().hydrate({});
  if (settings) S().updateSettings(settings);
  stub.docs.delete("site-data-carry.json");
  resetSiteDataForTest();
  webKit.writeHold = null;
  webKit.writing = false;
  webKit.readDelay = 0;
  webKit.released.length = 0;
  webKit.releasedWith.length = 0;
  webKit.cookies = [];
  webKit.storage = {};
  webKit.writes.length = 0;
  webviews.clear();
  const w = S().createWindow({ url: `${ORIGIN}/home`, ...(kind ? { kind } : {}) });
  const tabId = model.activeTabId(S(), w);
  S().updateTab(tabId, { url: `${ORIGIN}/home`, engine: "chromium" });
  return { w, tabId };
}

test("a site signed in on Chromium arrives in WebKit with its subdomain cookies and its saved data, and nothing from sites it never used", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn, { ...signedIn, name: "api", domain: "api.app.test" }, sso, { ...signedIn, domain: ".bank.test" }], storage: { [ORIGIN]: [["token", "t1"]] } });
  webviews.set(tabId, page);
  assert.equal(await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null), 2);
  assert.deepEqual(webKit.cookies.map((c) => c.domain).sort(), [".app.test", "api.app.test"]);
  assert.deepEqual(webKit.storage[ORIGIN], [["token", "t1"]]);
});

test("WebKit's newer value goes back to Chromium, and an unchanged carry writes nothing", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: { [ORIGIN]: [["token", "t1"]] } });
  webviews.set(tabId, page);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  webKit.cookies = webKit.cookies.map((c) => ({ ...c, value: "webkit" }));
  webKit.storage[ORIGIN] = [["token", "t2"]];
  await carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null);
  assert.equal(page.jar.cookies.find((c) => c.name === "sid").value, "webkit");
  assert.deepEqual(page.jar.storage[ORIGIN], [["token", "t2"]]);
  const before = webKit.writes.length + page.writes.length;
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  assert.equal(webKit.writes.length + page.writes.length, before);
});

test("data cleared in Chromium is cleared in WebKit too, and never comes back from WebKit", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: { [ORIGIN]: [["token", "t1"]] } });
  webviews.set(tabId, page);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  page.jar.cookies = [];
  page.jar.storage = {};
  await carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null);
  assert.deepEqual(page.jar.cookies, []);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  assert.deepEqual(webKit.cookies, []);
  assert.deepEqual(webKit.storage[ORIGIN], []);
});

test("private windows, a tab that changed profile mid-read, and the carry setting turned off move nothing", async () => {
  {
    const { tabId } = setup({ kind: "private" });
    webviews.set(tabId, chromiumPage({ cookies: [signedIn], storage: {} }));
    assert.equal(await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null), 0);
  }
  {
    const { tabId } = setup();
    const page = chromiumPage({ cookies: [signedIn], storage: {} });
    const release = page.holdReads();
    webviews.set(tabId, page);
    const carried = carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    S().updateTab(tabId, { profileId: "work" });
    release();
    assert.equal(await carried, 0);
  }
  {
    const { tabId } = setup({ settings: { engineSwitchCarriesSiteData: false } });
    webviews.set(tabId, chromiumPage({ cookies: [signedIn], storage: {} }));
    assert.equal(await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null), 0);
  }
  assert.deepEqual(webKit.writes, []);
});

test("a fresh WebKit load holds until the Chromium sign-in has landed, then lets the page go", async () => {
  const { tabId } = setup();
  webviews.set(tabId, chromiumPage({ cookies: [signedIn], storage: {} }));
  webKit.released.length = 0;
  for (const listener of webKit.listeners) listener({ name: "webKit.siteDataWanted", data: { id: "g1", profile: "", origin: ORIGIN } });
  for (let i = 0; i < 50 && !webKit.released.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(webKit.released, ["g1"]);
  assert.deepEqual(webKit.cookies.map((c) => c.value), ["chromium"]);
});

test("Clear Browsing Data while a carry is reading cancels it, so nothing it read comes back", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: { [ORIGIN]: [["token", "t1"]] } });
  const release = page.holdReads();
  webviews.set(tabId, page);
  const carried = carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await clearBrowsingData("", ["siteData", "cache"]);
  release();
  assert.equal(await carried, 0);
  assert.deepEqual(webKit.writes, []);
});

test("a carry that moved data saves what it learned at once, so a crash right after cannot bring deleted cookies back", async () => {
  const { tabId } = setup();
  stub.docs.delete("site-data-carry.json");
  webviews.set(tabId, chromiumPage({ cookies: [signedIn], storage: {} }));
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  const saved = JSON.parse(stub.docs.get("site-data-carry.json") ?? "{}");
  assert.ok(Object.keys(saved.profiles?.[""]?.cookies ?? {}).some((k) => k.startsWith("sid\u0001.app.test")));
});

async function withEngineClear(clearEngines, body) {
  const profiles = stub.ardiaCoreNativeModules.ArdiaProfiles;
  const real = profiles.call;
  profiles.call = (verb, profile, json) => (verb === "clearBrowsingData" ? clearEngines().then(() => "null") : real(verb, profile, json));
  try {
    await body();
  } finally {
    profiles.call = real;
  }
}

test("a carry that starts while Clear Browsing Data is still running waits for it, so Chromium's old cookies never land in the cleared WebKit", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: {} });
  webviews.set(tabId, page);
  let finishChromium;
  const chromiumCleared = new Promise((resolve) => (finishChromium = resolve));
  const clearEngines = async () => {
    webKit.cookies = [];
    await chromiumCleared;
    page.jar.cookies = [];
  };
  await withEngineClear(clearEngines, async () => {
    const cleared = clearBrowsingData("", ["siteData", "cache"]);
    const carried = carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishChromium();
    await cleared;
    await carried;
  });
  assert.deepEqual(webKit.cookies, []);
});

test("after Clear Browsing Data, signing in again on one engine reaches the other instead of being signed out", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: {} });
  webviews.set(tabId, page);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  await withEngineClear(async () => {
    webKit.cookies = [];
    page.jar.cookies = [];
  }, () => clearBrowsingData("", ["siteData", "cache"]));
  webKit.cookies = [{ ...signedIn }];
  await carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  assert.deepEqual(webKit.cookies.map((c) => c.name), ["sid"]);
  assert.deepEqual(page.jar.cookies.map((c) => c.name), ["sid"]);
});

async function withSites(handlers, body) {
  const sites = stub.ardiaCoreNativeModules.ArdiaSites;
  const real = sites.call;
  sites.call = (verb, profile, json) => (handlers[verb] ? Promise.resolve(handlers[verb](JSON.parse(json))).then((v) => JSON.stringify(v)) : real(verb, profile, json));
  try {
    await body();
  } finally {
    sites.call = real;
  }
}

test("with no Chromium page open, WebKit's saved data reaches Chromium through the engine's storage calls, and an engine without them moves cookies only", async () => {
  const { tabId } = setup();
  S().updateTab(tabId, { engine: "webkit" });
  webKit.cookies = [{ ...signedIn, value: "webkit" }];
  webKit.storage[ORIGIN] = [["token", "fromWebKit"]];
  const chromiumStore = { [ORIGIN]: [["kept", "1"]] };
  const writes = [];
  await withSites(
    {
      readStorage: ({ origin }) => ({ items: chromiumStore[origin] ?? [] }),
      writeStorage: ({ origin, set, remove }) => {
        writes.push({ origin, set, remove });
        chromiumStore[origin] = [...(chromiumStore[origin] ?? []).filter(([k]) => !remove.includes(k) && !set.some(([n]) => n === k)), ...set];
        return { written: set.length + remove.length };
      },
    },
    () => carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null),
  );
  assert.deepEqual(writes, [{ origin: ORIGIN, set: [["token", "fromWebKit"]], remove: [] }]);
  assert.deepEqual(Object.fromEntries(chromiumStore[ORIGIN]), { kept: "1", token: "fromWebKit" });

  webKit.storage[ORIGIN] = [["token", "newer"]];
  webKit.cookies = [{ ...signedIn, value: "webkit-newer" }];
  const exported = [];
  const realExport = webKitCalls.exportCookies;
  webKitCalls.exportCookies = ({ keys }) => (exported.push(...(keys ?? [])), (keys ?? []).length);
  const before = writes.length;
  try {
    await withSites(
      {
        readStorage: () => Promise.reject(new Error("the engine has no ac_local_storage_read")),
        writeStorage: () => (writes.push("unexpected"), { written: 0 }),
      },
      () => carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null),
    );
  } finally {
    webKitCalls.exportCookies = realExport;
  }
  assert.equal(writes.length, before);
  assert.ok(exported.length > 0, "the cookie still goes through the engine's cookie import");
});

test("a carry never sends Chromium a write past the origin's storage quota, so the value already there stays", async () => {
  const { tabId } = setup();
  S().updateTab(tabId, { engine: "webkit" });
  const kept = "k".repeat(1_900_000);
  webKit.storage[ORIGIN] = [["kept", kept], ["huge", "h".repeat(6_900_000)], ["small", "s"]];
  const chromiumStore = { [ORIGIN]: [["kept", kept]] };
  const QUOTA = 10 * 1024 * 1024 + 100 * 1024;
  const latin1 = (text) => 1 + text.length;
  const used = (items) => items.reduce((n, [k, v]) => n + latin1(k) + latin1(v), 0);
  const calls = [];
  const profiles = [];
  const sites = stub.ardiaCoreNativeModules.ArdiaSites;
  await withSites(
    {
      readStorage: ({ origin }) => {
        calls.push({ op: "read" });
        const items = chromiumStore[origin] ?? [];
        return { items: items.reduce((n, [k, v]) => n + k.length + v.length, 0) > 2_000_000 ? null : items };
      },
      writeStorage: ({ origin, set, remove }) => {
        calls.push({ op: "write", keys: set.map(([k]) => k), remove });
        let items = (chromiumStore[origin] ?? []).filter(([k]) => !remove.includes(k));
        for (const [k, v] of set) {
          const next = [...items.filter(([n]) => n !== k), [k, v]];
          if (used(next) > QUOTA) return Promise.reject(new Error("refused for quota"));
          items = next;
        }
        chromiumStore[origin] = items;
        return { written: set.length + remove.length };
      },
    },
    () => {
      const handled = sites.call;
      sites.call = (verb, profile, json) => (profiles.push(profile), handled(verb, profile, json));
      return carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null).finally(() => (sites.call = handled));
    },
  );
  const writes = calls.filter((c) => c.op === "write");
  assert.deepEqual(writes.map((w) => w.keys), [["small"]], "only what fits is sent");
  assert.ok(profiles.length > 0 && profiles.every((p) => p === ""), "the default profile is the engine's empty name, never \"default\"");
  assert.equal(Object.fromEntries(chromiumStore[ORIGIN]).kept, kept);
  assert.equal(Object.fromEntries(chromiumStore[ORIGIN]).huge, undefined);
});

test("the quota check counts what Chromium holds at its largest, skips an empty key, and sizes new entries as Blink stores them", async () => {
  const { fitStorageChange } = await import("./siteDataChromium.ts");
  const stored = [["a", "x".repeat(40)]];
  assert.deepEqual(fitStorageChange(stored, { set: [["b", "y".repeat(10)]], remove: [] }, 100).change.set.map(([k]) => k), ["b"], "84 held at most + 13 fits in 100");
  assert.equal(fitStorageChange(stored, { set: [["b", "y".repeat(20)]], remove: [] }, 100).overQuota, 1, "84 + 23 doesn't");
  assert.equal(fitStorageChange(stored, { set: [["b", "é".repeat(8)]], remove: [] }, 100).overQuota, 0, "Latin-1 is a byte a character: 84 + 11");
  assert.equal(fitStorageChange(stored, { set: [["b", "€".repeat(8)]], remove: [] }, 100).overQuota, 1, "UTF-16 is two: 84 + 19");
  const empty = fitStorageChange([], { set: [["", "v"]], remove: [""] }, 100);
  assert.deepEqual(empty.change, { set: [], remove: [] }, "an empty key stays pending");
  assert.equal(fitStorageChange(stored, { set: [["a", "x".repeat(10)]], remove: [] }, 100).change.set.length, 1, "a smaller value always fits");
});

test("an entry too big for one engine call stays pending while the rest goes through", async () => {
  const { tabId } = setup();
  S().updateTab(tabId, { engine: "webkit" });
  webKit.storage[ORIGIN] = [["nuls", "\u0000".repeat(1_300_000)], ["small", "s"]];
  const sent = [];
  await withSites(
    {
      readStorage: () => ({ items: [] }),
      writeStorage: ({ set, remove }) => {
        if (new TextEncoder().encode(JSON.stringify({ set, remove })).length > 8 * 1024 * 1024) return Promise.reject(new Error("the arguments are too big"));
        sent.push(...set.map(([k]) => k));
        return { written: set.length + remove.length };
      },
    },
    () => carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null),
  );
  assert.deepEqual(sent, ["small"]);
});

test("a page-free storage carry larger than one engine write goes in batches the engine takes", async () => {
  const { tabId } = setup();
  S().updateTab(tabId, { engine: "webkit" });
  webKit.storage[ORIGIN] = Array.from({ length: 4500 }, (_, i) => [`k${i}`, `v${i}`]);
  const batches = [];
  await withSites(
    {
      readStorage: () => ({ items: [] }),
      writeStorage: ({ set, remove }) => {
        if (set.length + remove.length > 4000) return Promise.reject(new Error("too many writes in one call"));
        batches.push(set.length + remove.length);
        return { written: set.length + remove.length };
      },
    },
    () => carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null),
  );
  assert.deepEqual(batches, [4000, 500]);
});

test("Clear Browsing Data that starts while a carry is writing waits for the write, then clears what it wrote", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: {} });
  webviews.set(tabId, page);
  let finishWrite;
  webKit.writeHold = new Promise((resolve) => (finishWrite = resolve));
  const carried = carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  for (let i = 0; i < 50 && !webKit.writing; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(webKit.writing);
  let enginesCleared = false;
  await withEngineClear(async () => {
    webKit.cookies = [];
    page.jar.cookies = [];
    enginesCleared = true;
  }, async () => {
    const cleared = clearBrowsingData("", ["siteData", "cache"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(enginesCleared, false);
    finishWrite();
    await cleared;
  });
  await carried;
  assert.deepEqual(webKit.cookies, []);
});

test("carries for one profile run one at a time, so carries in both directions can't swap two values", async () => {
  const { tabId } = setup();
  S().updateTab(tabId, { url: "https://elsewhere.test/" });
  const page = chromiumPage({ cookies: [{ ...signedIn, value: "c" }], storage: {} });
  webviews.set(tabId, page);
  webKit.cookies = [{ ...signedIn, value: "w" }];
  await Promise.all([
    carrySite("", "app.test", "webkit", { origin: ORIGIN, consent: null }),
    carrySite("", "app.test", "chromium", { origin: ORIGIN, consent: null }),
  ]);
  assert.equal(webKit.cookies.find((c) => c.name === "sid").value, page.jar.cookies.find((c) => c.name === "sid").value);
});

test("saved data WebKit dropped for a site not used in WebKit lately stays in Chromium", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: { [ORIGIN]: [["token", "t1"]] } });
  webviews.set(tabId, page);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  webKit.cookies = [];
  webKit.storage[ORIGIN] = [];
  await carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null);
  assert.deepEqual(page.jar.cookies.map((c) => c.name), ["sid"]);
  assert.deepEqual(page.jar.storage[ORIGIN], [["token", "t1"]]);
});

test("without the public suffix list a carry stays on the exact host, and with it sibling hosts of a private suffix stay apart", async () => {
  const alice = { ...signedIn, domain: "alice.github.io" };
  const bob = { ...signedIn, domain: "bob.github.io" };
  const shared = { ...signedIn, name: "pref", domain: ".app.test" };
  {
    const { tabId } = setup();
    webviews.set(tabId, chromiumPage({ cookies: [alice, bob], storage: {} }));
    await carrySignIn(tabId, "https://alice.github.io/", "webkit", null);
    assert.deepEqual(webKit.cookies.map((c) => c.domain), ["alice.github.io"]);
  }
  await withSites({ registrableDomains: ({ hosts }) => ({ domains: hosts.map((h) => (h.endsWith("github.io") ? h : h.split(".").slice(-2).join("."))) }) }, async () => {
    const { tabId } = setup();
    webviews.set(tabId, chromiumPage({ cookies: [alice, bob, shared], storage: {} }));
    await carrySignIn(tabId, "https://alice.github.io/", "webkit", null);
    await carrySignIn(tabId, "https://www.app.test/", "webkit", null);
    assert.deepEqual(webKit.cookies.map((c) => c.domain).sort(), [".app.test", "alice.github.io"]);
  });
});

test("hosts go to the engine's registrable-domain lookup in lowercase, whatever case they arrive in", async () => {
  const { learnRegistrableDomains, resetRegistrableLookupsForTest } = await import("./siteDataDomains.ts");
  resetRegistrableLookupsForTest();
  const asked = [];
  await withSites({ registrableDomains: ({ hosts }) => (asked.push(...hosts), { domains: hosts.map((h) => h.split(".").slice(-2).join(".")) }) }, () =>
    learnRegistrableDomains(["WWW.Example.CO.UK", ".Mixed.Example.com.", "plain.test"]),
  );
  assert.deepEqual(asked, ["www.example.co.uk", "mixed.example.com", "plain.test"]);
});

test("Clear Site Data clears both engines, and signing in again afterwards reaches the other engine", async () => {
  const { tabId } = setup();
  const page = chromiumPage({ cookies: [signedIn], storage: {} });
  webviews.set(tabId, page);
  await carrySignIn(tabId, `${ORIGIN}/home`, "webkit", null);
  const clearedIn = [];
  await withSites({ clearData: ({ engine }) => {
    clearedIn.push(engine);
    if (engine === "webkit") webKit.cookies = [];
    else page.jar.cookies = [];
    return { cookies: 1, storage: true };
  } }, async () => {
    assert.deepEqual(await clearSiteDataEverywhere("", ORIGIN), { cookies: 2, storage: true });
  });
  assert.deepEqual(clearedIn.sort(), ["chromium", "webkit"]);
  webKit.cookies = [{ ...signedIn }];
  await carrySignIn(tabId, `${ORIGIN}/home`, "chromium", null);
  assert.deepEqual(page.jar.cookies.map((c) => c.name), ["sid"]);
});

const signedInOn = (site) => ({ ...signedIn, domain: `.${site}` });

test("five tabs switching engines at once with slow reads all arrive signed in", async () => {
  const { tabId } = setup();
  const sites = ["one.test", "two.test", "three.test", "four.test", "five.test"];
  webviews.set(tabId, chromiumPage({ cookies: sites.map(signedInOn), storage: {} }, 400));
  webKit.readDelay = 400;
  const carried = await Promise.all(sites.map((site) => carrySignIn(tabId, `https://${site}/`, "webkit", null)));
  assert.deepEqual(carried, [1, 1, 1, 1, 1]);
});

test("a WebKit load behind ten queued background carries still gets its sign-in before the page goes", async () => {
  const sites = Array.from({ length: 10 }, (_, i) => `pushed${i}.test`);
  const { tabId } = setup();
  webviews.set(tabId, chromiumPage({ cookies: [...sites.map(signedInOn), signedInOn("late.test")], storage: {} }, 150));
  webKit.readDelay = 150;
  const pushes = Promise.all(sites.map((site) => carrySite("", site, "chromium", { origin: `https://${site}`, consent: null })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const listener of webKit.listeners) listener({ name: "webKit.siteDataWanted", data: { id: "late", profile: "", origin: "https://late.test" } });
  for (let i = 0; i < 200 && !webKit.released.includes("late"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(webKit.releasedWith[webKit.released.indexOf("late")]?.includes(".late.test"));
  await pushes;
});
