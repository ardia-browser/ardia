import assert from "node:assert/strict";
import { after, test } from "node:test";
import { noteTabLayoutSwitch, takeTabLayoutCounts } from "./tabLayoutCounts.ts";
globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 503 });
const client = await import("./client.ts");
client.loadChoice();
client.setSharing(true, "settings");
after(() => client.setSharing(false, "settings"));

test("tab layout switches are counted by direction, and taking them starts over", () => {
  noteTabLayoutSwitch("top");
  noteTabLayoutSwitch("top");
  noteTabLayoutSwitch("sidebar");
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 2, tab_layout_switches_to_sidebar: 1 });
  assert.deepEqual(takeTabLayoutCounts(), { tab_layout_switches_to_top: 0, tab_layout_switches_to_sidebar: 0 });
});
