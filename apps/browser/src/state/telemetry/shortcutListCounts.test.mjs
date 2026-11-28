import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });

const client = await import("./client.ts");
const usage = await import("./usage.ts");
const { noteShortcutList, takeShortcutListCounts } = await import("./shortcutListCounts.ts");
const { mount } = await import("../../test-hooks.mjs");
const { noteMenuShortcuts, shortcutItems } = await import("../settings/paneData.ts");
const { load, useResource } = await import("../settings/resources.ts");

const menus = stub.shellNativeModules.ArdiaMenus;
const original = menus.menuShortcuts;
after(() => client.setSharing(false, "settings"));
afterEach(() => {
  menus.menuShortcuts = original;
});

const LIST = [{ id: "reload", title: "Reload This Page", path: ["View"], remappable: true }];
const settle = () => new Promise((done) => setTimeout(done, 0));
const listed = () => {
  menus.menuShortcuts = () => Promise.resolve(LIST.map((item) => ({ ...item })));
};

async function sentCounts() {
  await client.saveQueueNow();
  const events = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events;
  return events.filter((e) => e.event === "usage_counts").map((e) => e.properties);
}

test("each way the Shortcuts list is read or reused is counted once, and the counts reset when taken", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeShortcutListCounts();
  noteShortcutList("read");
  noteShortcutList("reuse");
  noteShortcutList("reuse");
  noteShortcutList("menuSync");
  assert.deepEqual(takeShortcutListCounts(), { shortcut_list_reads: 1, shortcut_list_reuses: 2, shortcut_list_menu_syncs: 1 });
  assert.deepEqual(takeShortcutListCounts(), { shortcut_list_reads: 0, shortcut_list_reuses: 0, shortcut_list_menu_syncs: 0 });
});

test("a count is taken only under the consent period it was seen in, and not with sharing off", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  const seen = client.consentToken();
  takeShortcutListCounts();
  noteShortcutList("read", seen);
  assert.equal(takeShortcutListCounts().shortcut_list_reads, 1);
  client.setSharing(false, "settings");
  client.setSharing(true, "settings");
  noteShortcutList("read", seen);
  assert.equal(takeShortcutListCounts().shortcut_list_reads, 0, "seen in an earlier period");
  client.setSharing(false, "settings");
  noteShortcutList("read");
  assert.equal(takeShortcutListCounts().shortcut_list_reads, 0, "sharing off");
});

test("the counts are sent with the hourly usage counts and nothing is left for the next report", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  takeShortcutListCounts();
  noteShortcutList("read");
  noteShortcutList("reuse");
  usage.sessionEnding();
  const sent = await sentCounts();
  assert.ok(sent.some((p) => p.shortcut_list_reads === 1 && p.shortcut_list_reuses === 1 && p.shortcut_list_menu_syncs === 0), JSON.stringify(sent));
  assert.equal(takeShortcutListCounts().shortcut_list_reads, 0);
});

test("the Settings list counts its native reads, the panes that reuse it, and the menu sync's reads", async () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  listed();
  takeShortcutListCounts();

  await load(shortcutItems, [], { fresh: true });
  assert.deepEqual(takeShortcutListCounts(), { shortcut_list_reads: 1, shortcut_list_reuses: 0, shortcut_list_menu_syncs: 0 });

  const pane = mount(() => useResource(shortcutItems));
  await settle();
  assert.deepEqual(takeShortcutListCounts(), { shortcut_list_reads: 0, shortcut_list_reuses: 1, shortcut_list_menu_syncs: 0 });
  pane.unmount();

  noteMenuShortcuts(LIST, client.consentToken());
  assert.deepEqual(takeShortcutListCounts(), { shortcut_list_reads: 0, shortcut_list_reuses: 0, shortcut_list_menu_syncs: 1 });
  noteMenuShortcuts(LIST, null);
  assert.deepEqual(takeShortcutListCounts(), { shortcut_list_reads: 0, shortcut_list_reuses: 0, shortcut_list_menu_syncs: 0 }, "a sync that began with sharing off is not counted");

  menus.menuShortcuts = () => Promise.reject(new Error("the menu walk failed"));
  await load(shortcutItems, [], { fresh: true });
  const retried = mount(() => useResource(shortcutItems));
  await settle();
  assert.equal(takeShortcutListCounts().shortcut_list_reuses, 0, "an empty list left by a failed read is not reused");
  retried.unmount();
});
