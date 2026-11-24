import assert from "node:assert/strict";
import test from "node:test";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { initialHostSession, snapshotHostSession } from "./hostSession.ts";
import { createHostWindowOpener, dropRefusedWindow, takeHandedOverWindow } from "./hostWindowProfiles.ts";
import { SMALL_WINDOW_SEED_LIFE, SMALL_WINDOW_SEED_PREFIX, offerSmallWindow, opensOnCommandBar, smallWindowFrame, smallWindowSeed, takeSmallWindow, withSmallWindow } from "./hostSmallWindows.ts";

const S = () => useBrowser.getState();
const tick = () => new Promise(setImmediate);
const quiet = (run) => async (...args) => {
  const error = console.error;
  console.error = () => {};
  try { return await run(...args); } finally { console.error = error; }
};
const SCREEN = { width: 1920, height: 1080, availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 };

function storage() {
  const items = new Map();
  return {
    items,
    get length() { return items.size; },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
  };
}

function mainSession() {
  S().hydrate(initialHostSession({ bootstrap: { windowId: "main", profileId: "default", startup: false } }, null));
  S().setFocusedWindow("main");
}

function fakeHost({ reject, pending = false, windowId = "main" } = {}) {
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    bootstrap: { windowId, profileId: "default", startup: false },
    invoke(method, args) {
      calls.push([method, structuredClone(args)]);
      if (method === "ArdiaShell.openWindow" && reject) return Promise.reject(new Error(reject));
      return Promise.resolve(method === "ArdiaShell.openWindow" && pending ? { pending: true } : null);
    },
    call: async () => "null",
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    native: (event) => { for (const listener of [...listeners]) listener("ArdiaShell", "onWindowEvent", event); },
  };
}

const opener = (host, store) => createHostWindowOpener(host, () => S(), () => {}, (id) => dropRefusedWindow(useBrowser, id), { storage: store, screen: () => SCREEN });
const secondRenderer = (windowId, saved, store, now) => initialHostSession({ bootstrap: { windowId, profileId: "default", pageProfile: "", startup: false } }, saved, now);

test("a Little Ardia window's own renderer starts as that small window, with its page", async () => {
  mainSession();
  const saved = snapshotHostSession(S());
  const id = S().createWindow({ kind: "small", url: "https://example.com/a" });
  const tabId = S().windows[id].tabIds[0];
  const store = storage();
  const host = fakeHost();
  await opener(host, store)(id, { kind: "small", size: [900, 640], profile: "", frame: null });
  assert.deepEqual(host.calls[0][1].args[1].frame, [510, 220, 900, 640], "it opens at the Little Ardia size, centred as on the Mac");
  assert.ok(store.items.has(SMALL_WINDOW_SEED_PREFIX + id));
  const session = withSmallWindow({ bootstrap: { windowId: id, profileId: "default", pageProfile: "", startup: false } }, saved, store);
  assert.equal(session.windows[id].kind, "small");
  assert.deepEqual(session.windows[id].tabIds, [tabId]);
  assert.equal(session.tabs[tabId].url, "https://example.com/a");
  assert.equal(session.focusedWindowId, id);
  assert.equal(store.items.size, 0, "the seed is taken once");
  assert.equal(withSmallWindow({ bootstrap: { windowId: id, profileId: "default", pageProfile: "", startup: false } }, saved, store), undefined);
  S().hydrate(session);
  assert.equal(S().windows[id].kind, "small");
  assert.equal(snapshotHostSession(S()).windows[id], undefined, "and still isn't saved to the session");
});

test("the opener lets go of the window once it has opened, without closing it", async () => {
  mainSession();
  const id = S().createWindow({ kind: "small" });
  S().openPanel(id, "");
  const closedTabs = S().closedTabs;
  const host = fakeHost({ pending: true });
  const store = storage();
  await opener(host, store)(id, { kind: "small", profile: "" });
  assert.ok(S().windows[id], "while the native window is still opening the opener keeps it");
  assert.equal(takeHandedOverWindow(id), false);
  host.native({ type: "attached", id });
  await tick();
  assert.equal(S().windows[id], undefined);
  assert.equal(Object.values(S().tabs).some((tab) => tab.windowId === id), false);
  assert.equal(S().windowUi[id], undefined);
  assert.equal(S().closedTabs, closedTabs);
  assert.deepEqual(S().ui.focusOrder, ["main"]);
  assert.equal(takeHandedOverWindow(id), true, "the close its removal asks for is swallowed once");
  assert.equal(takeHandedOverWindow(id), false);
});

test("a refused or failed window leaves no seed behind and is not handed over", quiet(async () => {
  mainSession();
  const store = storage();
  const failed = S().createWindow({ kind: "small" });
  await opener(fakeHost({ reject: "no window" }), store)(failed, { kind: "small", profile: "" });
  await tick();
  assert.equal(store.items.size, 0);
  assert.equal(takeHandedOverWindow(failed), false);
}));

test("a small window never seeds or hands over itself, and a second open of the same window doesn't seed again", async () => {
  mainSession();
  const id = S().createWindow({ kind: "small" });
  const store = storage();
  await createHostWindowOpener(fakeHost({ windowId: id }), () => S(), () => {}, (gone) => dropRefusedWindow(useBrowser, gone), { storage: store, screen: () => SCREEN })(id, { kind: "small", profile: "" });
  await tick();
  assert.equal(store.items.size, 0);
  assert.ok(S().windows[id]);
  const other = S().createWindow({ kind: "small" });
  const host = fakeHost({ pending: true });
  const open = opener(host, store);
  await open(other, { kind: "small", profile: "" });
  store.items.clear();
  await open(other, { kind: "small", profile: "" });
  assert.equal(store.items.size, 0);
  host.native({ type: "attached", id: other });
  await tick();
  takeHandedOverWindow(other);
});

test("seeds are checked before they are used", () => {
  mainSession();
  const saved = snapshotHostSession(S());
  const id = S().createWindow({ kind: "small", url: "https://example.com/" });
  const now = 1_000_000;
  const seed = smallWindowSeed(S(), id, now);
  const boot = (windowId, extra = {}) => ({ bootstrap: { windowId, profileId: "default", pageProfile: "", startup: false, ...extra } });
  const fresh = () => { const store = storage(); offerSmallWindow(seed, store); return store; };
  assert.equal(withSmallWindow(boot("other"), saved, fresh(), now), undefined, "another window's seed is not this one's");
  assert.equal(withSmallWindow(boot(id), saved, fresh(), now + SMALL_WINDOW_SEED_LIFE + 1), undefined, "a stale seed is dropped");
  assert.equal(withSmallWindow(boot(id, { startup: true }), saved, fresh(), now), undefined, "a launch never reads one");
  assert.equal(withSmallWindow(boot(id, { pageProfile: `incognito:${id}` }), saved, fresh(), now), undefined);
  assert.equal(withSmallWindow(boot(id), { ...saved, windows: { ...saved.windows, [id]: { ...saved.windows.main, id } } }, fresh(), now), undefined, "a saved window keeps its saved state");
  const forged = storage();
  forged.setItem(SMALL_WINDOW_SEED_PREFIX + id, JSON.stringify({ ...seed, window: { ...seed.window, kind: "private" } }));
  assert.equal(takeSmallWindow(id, forged, now), undefined);
  forged.setItem(SMALL_WINDOW_SEED_PREFIX + id, "{not json");
  assert.equal(takeSmallWindow(id, forged, now), undefined);
  assert.equal(forged.items.size, 0);
  const crowded = storage();
  crowded.setItem(SMALL_WINDOW_SEED_PREFIX + "old", JSON.stringify({ ...seed, at: now - SMALL_WINDOW_SEED_LIFE - 1 }));
  crowded.setItem("unrelated", "kept");
  offerSmallWindow(seed, crowded);
  assert.deepEqual([...crowded.items.keys()].sort(), [SMALL_WINDOW_SEED_PREFIX + id, "unrelated"].sort(), "an offer sweeps seeds nobody took");
  assert.equal(smallWindowSeed(S(), "main"), undefined, "only small windows are seeded");
  assert.equal(secondRenderer(id, saved, undefined, now).windows[id].kind, "main", "without a seed the window is an ordinary one");
});

test("the Little Ardia frame is the Mac's: the saved size, at least 420 by 300 and at most 80 % of the work area, centred in it", () => {
  assert.deepEqual(smallWindowFrame([900, 640], SCREEN), [510, 220, 900, 640]);
  assert.deepEqual(smallWindowFrame(undefined, SCREEN), [510, 220, 900, 640]);
  assert.deepEqual(smallWindowFrame([100, 100], SCREEN), [750, 390, 420, 300]);
  assert.deepEqual(smallWindowFrame([4000, 4000], SCREEN), [192, 108, 1536, 864], "a size saved on a bigger screen fits 80 % of this one");
  assert.deepEqual(smallWindowFrame([900, 1060], SCREEN), [510, 108, 900, 864], "a tall window is capped and stays centred on the screen");
  assert.deepEqual(smallWindowFrame([900, 640], { ...SCREEN, availWidth: 500, availHeight: 360, height: 360 }), [40, 30, 420, 300], "the minimum wins over the cap");
  assert.equal(smallWindowFrame([900, 640], { ...SCREEN, availWidth: 0 }), undefined);
});

test("a blank Little Ardia window starts on its command bar; one with a page doesn't", () => {
  mainSession();
  const blank = S().createWindow({ kind: "small" });
  const page = S().createWindow({ kind: "small", url: "https://example.com/" });
  assert.equal(opensOnCommandBar(S(), blank), true);
  assert.equal(opensOnCommandBar(S(), page), false);
  assert.equal(opensOnCommandBar(S(), "main"), false);
});

test("an engine that relays small windows carries the window in the bootstrap, sizes it itself and needs no storage", async () => {
  mainSession();
  const saved = snapshotHostSession(S());
  const id = S().createWindow({ kind: "small", url: "https://example.com/relayed" });
  const tabId = S().windows[id].tabIds[0];
  const store = storage();
  const host = fakeHost({ pending: true });
  host.bootstrap.capabilities = ["ArdiaShell.smallWindows"];
  await opener(host, store)(id, { kind: "small", size: [700, 500], profile: "", frame: null });
  const options = host.calls[0][1].args[1];
  assert.equal(options.frame, null, "the engine places the window from its size");
  assert.deepEqual(options.size, [700, 500]);
  assert.equal(options.smallWindow.window.id, id);
  assert.equal(options.smallWindow.tabs[tabId].url, "https://example.com/relayed");
  assert.equal(store.items.size, 0, "nothing is left in localStorage");
  const bootstrap = { windowId: id, profileId: "default", pageProfile: "", startup: false, windowKind: "small", smallWindow: structuredClone(options.smallWindow) };
  const session = withSmallWindow({ bootstrap }, saved, store, Date.now() + SMALL_WINDOW_SEED_LIFE * 10);
  assert.equal(session.windows[id].kind, "small");
  assert.deepEqual(session.windows[id].tabIds, [tabId]);
  assert.equal(session.tabs[tabId].url, "https://example.com/relayed");
  assert.equal(session.focusedWindowId, id);
  host.native({ type: "attached", id });
  await tick();
  assert.equal(S().windows[id], undefined, "the opener hands the window over as it does with a stored seed");
  assert.equal(takeHandedOverWindow(id), true);
});

test("the bootstrap's window kind decides: a browser window takes no seed, and a small one falls back to storage", async () => {
  mainSession();
  const saved = snapshotHostSession(S());
  const id = S().createWindow({ kind: "small", url: "https://example.com/stored" });
  const seed = smallWindowSeed(S(), id);
  const store = storage();
  offerSmallWindow(seed, store);
  const base = { windowId: id, profileId: "default", pageProfile: "", startup: false };
  assert.equal(withSmallWindow({ bootstrap: { ...base, windowKind: "browser", smallWindow: seed } }, saved, store), undefined);
  assert.equal(store.items.size, 1, "a browser window leaves another window's seed alone");
  assert.equal(withSmallWindow({ bootstrap: { ...base, windowKind: "small", smallWindow: { ...seed, window: { ...seed.window, id: "other" } } } }, saved, storage()), undefined, "a seed for another window is refused");
  assert.equal(withSmallWindow({ bootstrap: { ...base, windowKind: "small", smallWindow: "nonsense" } }, saved, storage()), undefined);
  const session = withSmallWindow({ bootstrap: { ...base, windowKind: "small" } }, saved, store);
  assert.equal(session.windows[id].kind, "small", "without a relayed object the stored seed still opens the window");
  assert.equal(store.items.size, 0);
  S().closeWindow(id);
});

test("a private small window relays nothing, and a seed over the engine's limit is left out", async () => {
  mainSession();
  const id = S().createWindow({ kind: "small", url: `https://example.com/${"x".repeat(1024 * 1024)}` });
  const host = fakeHost();
  host.bootstrap.capabilities = ["ArdiaShell.smallWindows"];
  const store = storage();
  await opener(host, store)(id, { kind: "small", profile: "" });
  assert.equal("smallWindow" in host.calls[0][1].args[1], false);
  assert.equal(store.items.size, 0);
  await tick();
  assert.equal(takeHandedOverWindow(id), false);
  S().closeWindow(id);
});
