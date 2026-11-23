import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { useBrowser } = await import("../browser/store.ts");
const { sidebarEntries } = await import("./entries.ts");
const { openMultiMenu } = await import("./multiTabMenu.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
after(() => client.setSharing(false, "settings"));

const S = () => useBrowser.getState();

async function usageCounts() {
  await client.saveQueueNow();
  const queue = stub.docs.get("telemetry-queue.json");
  return queue ? JSON.parse(queue).events.filter((e) => e.event === "usage_counts").map((e) => e.properties) : [];
}

async function pickFromMenu(open, choice) {
  const shell = shellNativeModules.ArdiaMenus;
  const real = shell.showMenu;
  shell.showMenu = async () => choice;
  try {
    await open();
  } finally {
    shell.showMenu = real;
  }
}

test("Remove from Group on two selected rows keeps their order below the group, and is counted with its tab count", async () => {
  client.setSharing(true, "onboarding");
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const [a] = S().windows[w].tabIds;
  const b = S().newTab(w, { url: "https://b.example/", background: true });
  const c = S().newTab(w, { url: "https://c.example/", background: true });
  const reading = S().groupTabs([a, b, c], { name: "Reading", pinned: false });
  S().setSelection(w, [a, b]);
  await pickFromMenu(() => openMultiMenu(w, S().selection[w]), "ungroup");
  assert.deepEqual(sidebarEntries(S(), w).list, [`g:${reading}`, `t:${a}`, `t:${b}`]);
  assert.deepEqual(S().groups[reading].tabIds, [c]);
  usage.sessionEnding();
  const sent = await usageCounts();
  assert.deepEqual(
    sent.filter((e) => e.selection_group_removals).map((e) => [e.selection_group_removals, e.selection_group_removal_tabs]),
    [[1, 2]],
  );
});

test("the count is of tabs that left a group, not of the selection, and nothing is counted while sharing is off", async () => {
  for (const sharing of [true, false]) {
    client.setSharing(sharing, "settings");
    const before = (await usageCounts()).length;
    S().hydrate({});
    const w = S().createWindow({ url: "https://a.example/" });
    const [a] = S().windows[w].tabIds;
    const b = S().newTab(w, { url: "https://b.example/", background: true });
    const c = S().newTab(w, { url: "https://c.example/", background: true });
    S().groupTabs([a, b], { name: "Reading", pinned: false });
    await pickFromMenu(() => openMultiMenu(w, [a, c]), "ungroup");
    usage.sessionEnding();
    const sent = (await usageCounts()).slice(before);
    assert.deepEqual(
      sent.filter((e) => e.selection_group_removals).map((e) => [e.selection_group_removals, e.selection_group_removal_tabs]),
      sharing ? [[1, 1]] : [],
    );
  }
});
