import assert from "node:assert/strict";
import { after, test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });

const { NativeModules } = await import("react-native");
delete NativeModules.ACFreezeWatch;

const client = await import("./client.ts");
const freezes = await import("./freezes.ts");
after(() => client.setSharing(false, "settings"));
client.loadChoice();
const startedWithoutWatch = freezes.startFreezeWatch();

test("without the native watcher, as on Linux and Windows, page hangs are still counted while sharing is on", () => {
  client.loadChoice();
  client.setSharing(true, "settings");
  assert.equal(startedWithoutWatch, false, "no native watcher to start");
  freezes.noteRendererUnresponsive("tab", 1000);
  freezes.noteRendererResponsive("tab", true, 13_000);
  const sent = freezes.takeFreezeCounts(client.consentToken());
  assert.equal(sent.renderer_unresponsive, 1);
  assert.equal(sent.renderer_unresponsive_exited, 1);
  assert.equal(sent.renderer_unresponsive_5_30s, 1);
  assert.equal(sent.main_stall_longest_ms, undefined, "no thread stalls without the watcher");
});

test("without the native watcher, a hang from while sharing was off is dropped and sharing off sends nothing", () => {
  client.loadChoice();
  client.setSharing(false, "settings");
  freezes.noteRendererUnresponsive("off", 1000);
  assert.deepEqual(freezes.takeFreezeCounts(client.consentToken()), {});
  client.setSharing(true, "settings");
  freezes.noteRendererResponsive("off", false, 2000);
  assert.equal(freezes.takeFreezeCounts(client.consentToken()).renderer_unresponsive, 0);
});
