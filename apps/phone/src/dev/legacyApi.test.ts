import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyApis, type LegacyNative } from "../../../../packages/phone/src/legacyApi.ts";

const oldData = { version: 1 as const, tabs: [], archive: [], visits: [], preferences: {} };

test("a failed old-style read is tried again on the next call instead of being kept", async () => {
  let reads = 0;
  const native: LegacyNative = {
    imported: async () => false,
    available: async () => true,
    read: async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient I/O");
      return oldData;
    },
  };
  const { legacyImport } = legacyApis(native);
  await assert.rejects(legacyImport.source());
  assert.deepEqual(await legacyImport.source(), { kind: "pending", counts: { tabs: 0, archive: 0, visits: 0 } });
  assert.equal(reads, 2);
});

test("an old-style read that came back empty is tried again too", async () => {
  let reads = 0;
  const { legacyImport } = legacyApis({ imported: async () => false, available: async () => true, read: async () => (++reads === 1 ? null : oldData) });
  assert.deepEqual(await legacyImport.source(), { kind: "unusable", reason: "io" });
  assert.equal((await legacyImport.source()).kind, "pending");
});

test("a native module that names its probe sourceState takes the paged path with the receipt", async () => {
  const calls: string[] = [];
  const receipt = { version: 1 as const, tabs: 1, archive: 0, visits: 0, preferences: 0 };
  const native: LegacyNative = {
    sourceState: async () => (calls.push("sourceState"), { kind: "pending", counts: { tabs: 1, archive: 0, visits: 0 } }),
    readLegacy: async () => (calls.push("readLegacy"), { tabs: [], archive: [], selectedTabId: null, preferences: {} }),
    readVisits: async () => (calls.push("readVisits"), { visits: [], next: null }),
    applyNativeSettings: async () => void calls.push("applyNativeSettings"),
    markImportedWith: async (given) => void calls.push(`markImportedWith ${given.tabs}`),
    read: async () => (calls.push("oldRead"), oldData),
    markImported: async () => void calls.push("oldMarkImported"),
  };
  const { legacyImport } = legacyApis(native);
  await legacyImport.source();
  await legacyImport.read();
  await legacyImport.readVisits(0, 10);
  await legacyImport.applyNativeSettings();
  await legacyImport.markImported(receipt);
  assert.deepEqual(calls, ["sourceState", "readLegacy", "readVisits", "applyNativeSettings", "markImportedWith 1"]);
});
