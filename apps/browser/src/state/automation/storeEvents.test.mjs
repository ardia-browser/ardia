import assert from "node:assert/strict";
import { test } from "node:test";
const { storeTransaction, useBrowser } = await import("../browser/store.ts");
const model = await import("../browser/model.ts");
const { startStoreEvents } = await import("./storeEvents.ts");

const S = () => useBrowser.getState();
const MIN = 60_000;

test("tab.idle counts a tab brought back by Restore All as used when it came back", () => {
  S().hydrate({});
  S().updateSettings({ newTabPosition: "bottom" });
  const w = S().createWindow({ url: "https://a.com/" });
  const [, b] = ["b", "c", "d"].reduce((ids, u) => [...ids, S().newTab(w, { url: `https://${u}.com/`, background: true })], [model.viewTabIds(S(), w)[0]]);
  S().updateTab(b, { lastActiveAt: Date.now() - 2 * 60 * MIN });
  S().cleanUpTabs(w, { inactiveForMs: 30 * MIN });
  assert.ok(!S().tabs[b], "cleaned up");
  S().restoreCleaned();
  const sent = [];
  const stop = startStoreEvents((name, data) => sent.push([name, data.url]), { events: new Set(["tab.idle"]), tabIdle: new Set([30 * 60]) });
  stop();
  assert.deepEqual(sent.filter(([, url]) => url === "https://b.com/"), []);
});

function playingSongShared(t) {
  S().hydrate({});
  const a = S().createWindow({ url: "https://a.example/" });
  const song = S().newTab(a, { url: "https://music.example/" });
  const quiet = S().newTab(a, { url: "https://quiet.example/" });
  S().updateSettings({ shareTabsAcrossWindows: true });
  S().updateLive(song, { playingAudio: true });
  const sent = [];
  const stop = startStoreEvents((name, data) => sent.push(`${name} ${data.tabId}`), { events: new Set(["media.started", "media.stopped"]), tabIdle: new Set() });
  t.after(stop);
  return { song, quiet, sent };
}

const freezeOn = (copy, holderId) => useBrowser.setState((x) => ({ tabs: { ...x.tabs, [copy]: { ...x.tabs[copy], page: { kind: "frozen", holderId } } } }));

test("a frozen copy that starts showing a playing page sends media.started once, for the copy alone", (t) => {
  const { song, sent } = playingSongShared(t);
  const b = S().createWindow({ url: "https://b.example/" });
  const copy = Object.values(S().tabs).find((t) => t.windowId === b && t.pinKey === song).id;
  if (S().tabs[copy].page.holderId !== song) freezeOn(copy, song);
  assert.equal(S().tabs[copy].page.holderId, song);
  assert.deepEqual(sent, [`media.started ${copy}`]);
  S().updateLive(song, { playingAudio: false });
  assert.deepEqual(sent.slice(1).sort(), [`media.stopped ${copy}`, `media.stopped ${song}`].sort());
});

test("handing the page to a copy sends nothing; moving the playing tab stops only the tabs that were reported playing", (t) => {
  const { song, sent } = playingSongShared(t);
  const b = S().createWindow({ url: "https://b.example/" });
  const c = S().createWindow({ url: "https://c.example/" });
  const copyIn = (w) => Object.values(S().tabs).find((x) => x.windowId === w && x.pinKey === song)?.id;
  const [inB, inC] = [copyIn(b), copyIn(c)];
  assert.deepEqual(sent.splice(0), [`media.started ${inB}`, `media.started ${inC}`]);
  S().activate(inB);
  assert.equal(S().tabs[song].windowId, b, "the page moved to B with its id");
  assert.deepEqual(sent, [], "a handoff keeps every tab's sound");
  S().moveTabsToWindow([song], c);
  const fresh = copyIn(b);
  assert.ok(fresh && fresh !== inB && !S().tabs[inC], "B got a new copy and C's copy gave way to the page");
  assert.deepEqual(sent.sort(), [`media.stopped ${inB}`, `media.stopped ${song}`].sort(), "the reload stops the song and the copy that played, not B's new copy");
});

test("a copy that sounded through a holder it only had inside a held transaction is quiet again once it ends", (t) => {
  const { song, quiet, sent } = playingSongShared(t);
  S().updateLive(song, { playingAudio: false });
  const b = S().createWindow({ url: "https://b.example/" });
  const copy = Object.values(S().tabs).find((x) => x.windowId === b && x.pinKey === quiet).id;
  sent.length = 0;
  storeTransaction(() => {
    freezeOn(copy, song);
    S().updateLive(song, { playingAudio: true });
    freezeOn(copy, quiet);
  });
  assert.equal(S().tabs[copy].page.holderId, quiet);
  const copyEvents = () => sent.filter((x) => x.endsWith(` ${copy}`));
  assert.ok(copyEvents().length % 2 === 0, `the copy ends where it started: ${copyEvents().join(", ")}`);
  sent.length = 0;
  S().updateLive(quiet, { playingAudio: true });
  assert.deepEqual(copyEvents(), [`media.started ${copy}`], "the copy's real start is sent");
});

test("audio reports outside a transaction aren't remembered for the next transaction's recheck", (t) => {
  const { song, quiet } = playingSongShared(t);
  const w = S().tabs[song].windowId;
  const extra = ["x", "y"].map((h) => S().newTab(w, { url: `https://${h}.example/`, background: true }));
  for (const id of [quiet, ...extra]) S().updateLive(id, { playingAudio: true });
  S().closeTabs(extra);
  const looked = new Set();
  const getState = useBrowser.getState;
  useBrowser.getState = () => {
    const s = getState();
    return { ...s, tabs: new Proxy(s.tabs, { get: (target, key) => (looked.add(key), target[key]) }) };
  };
  try {
    storeTransaction(() => {});
  } finally {
    useBrowser.getState = getState;
  }
  assert.deepEqual(extra.filter((id) => looked.has(id)), [], "closed tabs that once played aren't looked up again");
});
