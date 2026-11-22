import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { flushPersistence, loadSession, startPersistence } = await import("../session/persist.ts");
const stub = await import("../../test-native/index.ts");
const { adoptParkedPins } = await import("./parkedPins.ts");

const S = () => useBrowser.getState();
const PAGE = "https://example.com/page";
const NOTES = "https://example.com/page#notes";
const pinsIn = (w, profileId = S().windows[w].profileId) =>
  S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => t.pin && t.profileId === profileId).map((t) => [t.pinnedUrl ?? t.url, t.pin.as]);

function twoPinsOfOnePage(w, profileId) {
  const one = S().newTab(w, { url: PAGE, profileId, background: true });
  const two = S().newTab(w, { url: NOTES, profileId, background: true });
  S().pinTabs([one], true);
  S().pinTabs([two], true);
  return [one, two];
}

test("closing a profile's last window parks both pins of one page, and both come back (#3149)", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "https://a1.com" });
  const b = S().createWindow({ url: "https://b1.com" });
  const work = S().createProfile({ name: "Work" });
  S().switchProfile(b, work);
  twoPinsOfOnePage(b, work);
  S().closeWindow(b);
  assert.deepEqual(S().parkedPins[work]?.tabs.map((t) => t.url).sort(), [PAGE, NOTES]);
  S().switchProfile(a, work);
  assert.deepEqual(pinsIn(a, work).map(([u]) => u).sort(), [PAGE, NOTES]);
});

test("launching with Restore Session off keeps both pins of one page (#3149)", () => {
  stub.docs.clear();
  const stop = startPersistence();
  const w = S().createWindow({ url: "https://a1.com" });
  twoPinsOfOnePage(w, S().windows[w].profileId);
  S().updateSettings({ restoreSession: false });
  flushPersistence();
  stop();
  S().hydrate(loadSession());
  const n = S().createWindow();
  assert.deepEqual(pinsIn(n).map(([u]) => u).sort(), [PAGE, NOTES]);
});

test("adopting parked pins next to a pin of the same page keeps both; the same pin isn't added twice (#3149)", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a1.com" });
  const profileId = S().windows[w].profileId;
  const one = S().newTab(w, { url: PAGE, background: true });
  S().pinTabs([one], true);
  const kept = S().tabs[one];
  const parked = { tabs: [{ ...kept, id: one, groupId: null }, { ...kept, url: NOTES, pinnedUrl: NOTES, id: "parked-notes", groupId: null }], groups: [] };
  useBrowser.setState(adoptParkedPins({ ...S(), parkedPins: { [profileId]: parked } }, w, profileId));
  assert.deepEqual(pinsIn(w).map(([u]) => u).sort(), [PAGE, NOTES]);
});

test("reopening a closed copy of a pin whose pin is parked brings that pin back, not a second one (#3149)", () => {
  S().hydrate({});
  const a = S().createWindow({ url: "https://a1.com" });
  const profileId = S().windows[a].profileId;
  const pin = S().newTab(a, { url: "https://pin.com", background: true });
  S().pinTabs([pin], true);
  const b = S().createWindow({ url: "https://b1.com" });
  const work = S().createProfile({ name: "Work" });
  S().createWindow({ url: "https://w1.com", profileId: work });
  S().closeWindow(a);
  const copy = S().windows[b].tabIds.find((id) => S().tabs[id].pin && (S().tabs[id].pinKey ?? id) === pin);
  assert.notEqual(copy, pin, "B shows its own copy of the pin");
  S().activate(copy);
  S().closeTab(copy);
  const entry = S().closedTabs.at(-1);
  S().closeWindow(b);
  assert.deepEqual(S().parkedPins[profileId]?.tabs.map((t) => t.id), [pin]);
  S().restoreClosed(entry.id, null);
  const live = Object.values(S().tabs).filter((t) => t.profileId === profileId && t.pin);
  assert.deepEqual(live.map((t) => t.pinKey ?? t.id), [pin], "the parked pin itself is back");
  assert.equal(entry.restoreFrom, undefined, "the closed copy had no separate restore source");
  const back = live[0].page;
  assert.equal(back.adopt ?? back.wake, `restore:${copy}`, "its page comes back from the closed copy's history");
  for (const w of Object.values(S().windows).filter((x) => x.profileId === profileId)) S().closeWindow(w.id);
  assert.deepEqual(S().parkedPins[profileId]?.tabs.map((t) => t.id), [pin], "and parks again as one pin");
});

test("adopting a parked split whose pane the window already holds keeps the split (#3149)", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a1.com" });
  const profileId = S().windows[w].profileId;
  const one = S().newTab(w, { url: "https://one.com", background: true });
  S().pinTabs([one], true);
  const held = S().tabs[one];
  const row = { as: "row" };
  useBrowser.setState({ tabs: { ...S().tabs, [one]: { ...held, pin: row } } });
  const parked = {
    tabs: [
      { ...held, pin: row, id: one, groupId: null },
      { ...held, pin: row, url: "https://two.com", pinnedUrl: "https://two.com", id: "parked-two", groupId: null },
    ],
    groups: [],
    splits: [{ orientation: "horizontal", slots: [{ size: 0.5, tabId: one }, { size: 0.5, tabId: "parked-two" }] }],
  };
  useBrowser.setState(adoptParkedPins({ ...S(), parkedPins: { [profileId]: parked } }, w, profileId));
  const split = Object.values(S().splits).find((v) => v.windowId === w);
  assert.ok(split, "the split comes back");
  assert.deepEqual(split.slots.map((x) => S().tabs[x.tabId].pinnedUrl ?? S().tabs[x.tabId].url), ["https://one.com", "https://two.com"]);
});
