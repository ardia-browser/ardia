import assert from "node:assert/strict";
import { test } from "node:test";

const native = await import("../../test-native/ardiacore.ts");
const { useApplePasswords } = await import("./applePasswords.ts");
const { pageOf } = await import("../tabs/pageState.ts");
const { cancelLoginListPairing, pairFromLoginList } = await import("./loginListPairing.ts");

const flush = () => new Promise((r) => setImmediate(r));

test("Connect in the Login list asks for the code over that tab, and Cancel puts the prompt away and cancels the Pairing", async () => {
  native.applePasswords.state = "notConnected";
  native.applePasswords.calls.length = 0;
  pairFromLoginList("tab-1");
  assert.equal(pageOf("tab-1").applePasswordsPairing, true, "the prompt shows over the tab whose Login list asked");
  assert.equal(pageOf("tab-2").applePasswordsPairing, false, "no other tab shows it");
  await flush();
  assert.equal(useApplePasswords.getState().pairing?.step, "code");
  assert.equal(useApplePasswords.getState().pairing?.profileId, null, "the profile's Password manager is left as it is");
  cancelLoginListPairing("tab-1");
  await flush();
  assert.equal(pageOf("tab-1").applePasswordsPairing, false);
  assert.equal(useApplePasswords.getState().pairing, null);
  assert.deepEqual(native.applePasswords.calls, ["pair", "cancelPairing"]);
});
