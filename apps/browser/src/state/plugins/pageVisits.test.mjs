import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { makeTab } = await import("../browser/model.ts");
const { DEFAULT_PROFILE_ID } = await import("../settings/settings.ts");
const native = await import("../../test-native/ardiacore.ts");
const { notePluginPageVisit, replacePluginPageVisit, endPluginPageVisit } = await import("./pageVisits.ts");

const { engineProfile } = await import("../browser/model.ts");
const engine = () => engineProfile(useBrowser.getState(), DEFAULT_PROFILE_ID);
const visited = () => [...native.chromeHistory(engine()).keys()].filter((u) => u.startsWith("ardia://notes"));
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function tab(id) {
  useBrowser.setState((s) => ({ tabs: { ...s.tabs, [id]: { ...makeTab("w1", DEFAULT_PROFILE_ID, "ardia://notes"), id } } }));
}

test("a replace before the visit settles records only the corrected address", async () => {
  tab("pv1");
  notePluginPageVisit("pv1", "ardia://notes/Wrong-slug-0123456789ab", "");
  replacePluginPageVisit("pv1", "ardia://notes/Wrong-slug-0123456789ab", "ardia://notes/Right-0123456789ab");
  notePluginPageVisit("pv1", "ardia://notes/Right-0123456789ab", "Right");
  endPluginPageVisit("pv1");
  await settle();
  assert.deepEqual(visited().filter((u) => u.includes("0123456789ab")), ["ardia://notes/Right-0123456789ab"]);
});

test("a replace after the visit was written adds the corrected address and never deletes another tab's visit to the old one", async () => {
  tab("pv2");
  tab("pv2b");
  notePluginPageVisit("pv2b", "ardia://notes/Old-slug-aaaaaaaaaaaa", "Old");
  endPluginPageVisit("pv2b");
  notePluginPageVisit("pv2", "ardia://notes/Old-slug-aaaaaaaaaaaa", "Old");
  endPluginPageVisit("pv2");
  await settle();
  assert.ok(visited().includes("ardia://notes/Old-slug-aaaaaaaaaaaa"));
  replacePluginPageVisit("pv2", "ardia://notes/Old-slug-aaaaaaaaaaaa", "ardia://notes/New-aaaaaaaaaaaa");
  notePluginPageVisit("pv2", "ardia://notes/New-aaaaaaaaaaaa", "New");
  endPluginPageVisit("pv2");
  await settle();
  const mine = visited().filter((u) => u.includes("aaaaaaaaaaaa")).sort();
  assert.deepEqual(mine, ["ardia://notes/New-aaaaaaaaaaaa", "ardia://notes/Old-slug-aaaaaaaaaaaa"]);
});

test("a replace to another page's address leaves earlier pages alone", async () => {
  tab("pv3");
  notePluginPageVisit("pv3", "ardia://notes/First-bbbbbbbbbbbb", "First");
  endPluginPageVisit("pv3");
  notePluginPageVisit("pv3", "ardia://notes/Second-cccccccccccc", "Second");
  endPluginPageVisit("pv3");
  await settle();
  replacePluginPageVisit("pv3", "ardia://notes/First-bbbbbbbbbbbb", "ardia://notes/Third-dddddddddddd");
  await settle();
  assert.ok(visited().includes("ardia://notes/First-bbbbbbbbbbbb"));
});
