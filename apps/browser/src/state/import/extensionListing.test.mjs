import assert from "node:assert/strict";
import { test } from "node:test";
const { leftOutCounts, leftOutText, listedCount, planExtensionListing, sourceNotes } = await import("./extensionListing.ts");

const ext = (id, name, more = {}) => ({ id: id.repeat(32), name, webStoreUrl: `https://evil.example/${id}`, enabled: true, ...more });
const none = () => new Set();
const named = (id) => ({ default: "Personal", work: "Work" })[id] ?? id;

test("each source profile's Web Store extensions are listed under the profile it was imported into, every one of them", () => {
  const many = "abcdefghijklmnop".split("").map((c, i) => ext(c, `Extension ${String(i).padStart(2, "0")}`));
  const listing = planExtensionListing(
    [
      { sourceProfile: "Default", profileId: "default", list: [...many, ext("a", "Extension 00", { enabled: false, pinnedIndex: 0 })] },
      { sourceProfile: "Profile 1", profileId: "work", list: [ext("b", "Beta", { pinnedIndex: 1 })] },
    ],
    none,
    named,
  );
  assert.deepEqual(listing.targets.map((t) => [t.profileName, t.extensions.length]), [["Personal", 16], ["Work", 1]]);
  assert.equal(listedCount(listing), 17);
  assert.deepEqual(listing.targets[1].extensions[0], { id: "b".repeat(32), name: "Beta", webStoreUrl: `https://chromewebstore.google.com/detail/${"b".repeat(32)}`, offInSource: false, pinnedInSource: true });
  assert.equal(listing.storeOpened, false);
});

test("the store link is built from the extension's id, never taken from the source's files", () => {
  const listing = planExtensionListing([{ sourceProfile: "Default", profileId: "default", list: [ext("a", "Alpha")] }], none, named);
  assert.equal(listing.targets[0].extensions[0].webStoreUrl, `https://chromewebstore.google.com/detail/${"a".repeat(32)}`);
});

test("what the source had off or pinned is said where it helps", () => {
  const e = (offInSource, pinnedInSource) => ({ id: "a", name: "A", webStoreUrl: "", offInSource, pinnedInSource });
  assert.equal(sourceNotes(e(true, true), "Chrome"), "off and pinned in Chrome");
  assert.equal(sourceNotes(e(false, true), "Chrome"), "pinned in Chrome");
  assert.equal(sourceNotes(e(false, false), "Chrome"), "");
});

test("extensions that can't come from the Web Store, or are already in the profile, are left out with their reason", () => {
  const listing = planExtensionListing(
    [
      {
        sourceProfile: "Default",
        profileId: "default",
        list: [
          ext("a", "Alpha"),
          ext("b", "Old Toolbar", { skip: "manifestV2" }),
          ext("c", "Dev Helper", { skip: "unpacked" }),
          ext("d", "Company SSO", { skip: "policy" }),
          ext("e", "Password Helper", { skip: "external" }),
          ext("f", "Dragged In", { skip: "notWebStore" }),
          { id: "not-an-id", name: "Odd", webStoreUrl: "", enabled: true },
        ],
      },
      { sourceProfile: "Profile 1", profileId: "work", list: [ext("b", "Old Toolbar", { skip: "manifestV2" })] },
    ],
    () => new Set(["a".repeat(32)]),
    named,
  );
  assert.deepEqual(listing.targets, []);
  assert.deepEqual(leftOutCounts(listing), { installed: 1, manifestV2: 1, unpacked: 1, policy: 1, external: 1, notWebStore: 2 });
  assert.deepEqual(listing.leftOut.map(leftOutText), [
    "Alpha (already in Ardia)",
    "Old Toolbar (uses Manifest V2, which Chrome no longer runs)",
    "Dev Helper (loaded unpacked in developer mode)",
    "Company SSO (installed by your organization's policy)",
    "Password Helper (added by another app)",
    "Dragged In (not from the Chrome Web Store)",
    "Odd (not from the Chrome Web Store)",
  ]);
});

test("a reader that doesn't say where an extension came from, like Linux's, keeps the plain store-link list", () => {
  const linux = { id: "a".repeat(32), name: "Alpha", webStoreUrl: "https://chromewebstore.google.com/detail/x" };
  assert.equal(planExtensionListing([{ sourceProfile: "Default", profileId: "default", list: [linux] }], none, named), null);
  assert.equal(planExtensionListing([{ sourceProfile: "Default", profileId: "default", list: [ext("b", "Beta"), linux] }], none, named), null);
});

test("nothing listed and nothing left out is no listing", () => {
  assert.equal(planExtensionListing([{ sourceProfile: "Default", profileId: "default", list: [] }], none, named), null);
  assert.equal(planExtensionListing([{ sourceProfile: "Default", profileId: "", list: [ext("a", "Alpha")] }], none, named), null);
});
