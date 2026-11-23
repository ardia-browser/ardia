import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

registerHooks({
  resolve(specifier, context, next) {
    const renderer = context.parentURL?.match(/[?&]renderer=(\w+)/)?.[1];
    const resolved = next(specifier, context);
    if (!renderer || !resolved.url.startsWith("file:") || resolved.url.includes("/node_modules/") || /\.(json|tsx)$/.test(resolved.url)) return resolved;
    return { ...resolved, url: `${resolved.url.split("?")[0]}?renderer=${renderer}` };
  },
});

const CHROME_DEFAULT = { folder: "/home/me/Downloads", askWhereToSave: false, managed: false };
const SHARED = "/home/me/Shared";
const LOAD_MS = 25;
const BUSY_MS = { browser: 1, settings: 12 };
let engine;
let loads;
globalThis.acTestNativeModules = {
  ArdiaDownloads: {
    call: (verb, profile, json) => {
      if (!loads.has(profile)) loads.set(profile, sleep(LOAD_MS));
      return loads.get(profile).then(() => {
        const next = { ...CHROME_DEFAULT, ...engine.get(profile), ...JSON.parse(json) };
        if (verb === "setSettings") engine.set(profile, next);
        return JSON.stringify(next);
      });
    },
    addListener: () => ({ remove() {} }),
  },
};
globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { hidden: false });

async function rendererModules(id) {
  const from = (path) => import(`${new URL(path, import.meta.url).href}?renderer=${id}`);
  return {
    ...(await from("../../browser/src/state/browser/store.ts")),
    ...(await from("../../browser/src/state/settings/paneData.ts")),
    ...(await from("../../browser/src/state/profiles/engineProfiles.ts")),
    ...(await from("../../browser/src/state/downloads/downloadTurns.ts")),
    ...(await from("./hostDownloadTurns.ts")),
    ...(await from("./hostSession.ts")),
  };
}

const modules = { browser: await rendererModules("browser"), settings: await rendererModules("settings") };
const { mergeSession } = await import("./hostSessionMerge.ts");

function fifoLocks() {
  const tails = new Map();
  const names = new Set();
  return {
    names,
    request(name, job) {
      names.add(name);
      const held = (tails.get(name) ?? Promise.resolve()).then(() => job());
      tails.set(name, held.catch(() => {}));
      return held;
    },
  };
}

async function linux(run) {
  engine = new Map([["", { ...CHROME_DEFAULT, folder: SHARED }]]);
  loads = new Map();
  const seeded = modules.browser;
  seeded.useBrowser.getState().hydrate({});
  seeded.useBrowser.getState().updateSettings({ separateDownloadFolders: false });
  const initial = structuredClone(seeded.snapshotHostSession(seeded.useBrowser.getState()));
  let canonical = initial;
  const hosts = [];
  const locks = fifoLocks();
  const renderers = {};
  for (const [id, renderer] of Object.entries(modules)) {
    renderer.useBrowser.getState().hydrate(structuredClone(initial));
    const listeners = new Set();
    let channel = Promise.resolve();
    const deliver = (message) => (channel = channel.then(() => sleep(BUSY_MS[id])).then(message));
    const host = {
      bootstrap: { windowId: id, profileId: "default", startup: false },
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      onBeforeClose: () => () => {},
      hear: (update) => deliver(() => listeners.forEach((listener) => listener("ArdiaHost", "session", update))),
      invoke(method, pair) {
        if (method !== "session.write") return deliver(() => ["browser", "settings"]);
        const base = canonical;
        canonical = mergeSession(pair.base, pair.session, canonical);
        const replied = structuredClone(canonical);
        const reply = deliver(() => replied);
        for (const other of hosts) other.hear(structuredClone({ base: other === host ? pair.session : base, session: canonical, sourceWindowId: id }));
        return reply;
      },
    };
    hosts.push(host);
    const persistence = renderer.startHostPersistence(host, renderer.useBrowser, structuredClone(initial));
    const turns = renderer.linuxDownloadTurns(locks, host, persistence.flush);
    renderer.setDownloadTurns(turns);
    const stopPublishing = renderer.publishSwitchInTurn(renderer.useBrowser, turns);
    renderers[id] = { ...renderer, persistence, stopPublishing, S: () => renderer.useBrowser.getState() };
  }
  try {
    await run(renderers);
    assert.equal(locks.names.size, 1, "every renderer waits on the same lock");
  } finally {
    for (const renderer of Object.values(renderers)) await renderer.inDownloadTurn(async () => {});
    await sleep(LOAD_MS * 6);
    for (const renderer of Object.values(renderers)) {
      renderer.stopPublishing();
      renderer.persistence();
    }
  }
}

const folderOf = (id) => (engine.get(id) ?? CHROME_DEFAULT).folder;

test("General in the Settings renderer waits for profiles another window is still giving the shared folder", () =>
  linux(async ({ browser, settings }) => {
    const made = ["One", "Two", "Three"].map((name) => browser.S().createProfile({ name }));
    await browser.persistence.flush();
    await sleep(BUSY_MS.settings * 3);
    const seen = settings.engineProfiles(settings.S());
    assert.equal(seen.length, 4, "Settings heard of every new profile");
    await settings.separateIfFoldersDiffer(seen, () => true);
    assert.equal(settings.S().settings.separateDownloadFolders, false);
    for (const id of made) assert.equal(folderOf(id), SHARED);
  }));

test("a folder picked in the Settings renderer reaches a profile another window just made and hasn't published", () =>
  linux(async ({ browser, settings }) => {
    const work = browser.S().createProfile({ name: "Work" });
    await browser.inDownloadTurn(async () => {});
    await settings.setDownloadsForEveryProfile({ folder: "/home/me/Picked" });
    assert.equal(folderOf(work), "/home/me/Picked");
  }));

test("a folder picked while another window's copy waits is the one the new profile gets", () =>
  linux(async ({ browser, settings }) => {
    const picked = settings.setDownloadsForEveryProfile({ folder: "/home/me/Picked" });
    const work = browser.S().createProfile({ name: "Work" });
    await picked;
    await browser.inDownloadTurn(async () => {});
    assert.equal(folderOf(work), "/home/me/Picked");
  }));

test("a folder picked during another window's copy waits to hear of that profile before it's written", () =>
  linux(async ({ browser, settings }) => {
    const work = browser.S().createProfile({ name: "Work" });
    await sleep(LOAD_MS / 2);
    assert.equal(settings.engineProfiles(settings.S()).length, 1, "Settings hasn't heard of the profile yet");
    await settings.setDownloadsForEveryProfile({ folder: "/home/me/Picked" });
    assert.equal(folderOf(work), "/home/me/Picked");
  }));

test("a profile made right after Settings turned the switch off still gets the shared folder", () =>
  linux(async ({ browser, settings }) => {
    settings.S().updateSettings({ separateDownloadFolders: true });
    await settings.persistence.flush();
    await sleep(BUSY_MS.settings * 3);
    assert.equal(browser.S().settings.separateDownloadFolders, true);
    settings.setSeparateDownloadFolders(false);
    const work = browser.S().createProfile({ name: "Work" });
    await browser.inDownloadTurn(async () => {});
    assert.equal(folderOf(work), SHARED);
  }));

test("turning the switch on in Settings reaches another window before it copies to a profile made there right after", () =>
  linux(async ({ browser, settings }) => {
    settings.setSeparateDownloadFolders(true);
    const work = browser.S().createProfile({ name: "Work" });
    await browser.inDownloadTurn(async () => {});
    assert.equal(folderOf(work), CHROME_DEFAULT.folder);
    assert.equal(browser.S().settings.separateDownloadFolders, true);
  }));

test("turning the switch off from anywhere reaches another window before it skips a profile made there right after", () =>
  linux(async ({ browser, settings }) => {
    settings.S().updateSettings({ separateDownloadFolders: true });
    await settings.persistence.flush();
    await sleep(BUSY_MS.settings * 3);
    settings.S().updateSettings({ separateDownloadFolders: false });
    const work = browser.S().createProfile({ name: "Work" });
    await browser.inDownloadTurn(async () => {});
    assert.equal(folderOf(work), SHARED);
  }));

test("a failing session write doesn't hold the lock or fail the download settings call", async () => {
  const { linuxDownloadTurns } = modules.browser;
  const locks = fifoLocks();
  const reported = [];
  const host = { invoke: () => Promise.reject(new Error("no reply")) };
  const turns = linuxDownloadTurns(locks, host, () => Promise.reject(new Error("no write")), (error) => reported.push(error.message));
  assert.equal(await turns(async () => "saved"), "saved");
  await assert.rejects(turns(async () => { throw new Error("refused"); }), /refused/);
  assert.deepEqual(reported, ["no reply", "no write", "no reply", "no write"]);
});
