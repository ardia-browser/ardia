import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { colorLibraryProfile, moveLibraryProfile, movedProfileOrder, nudgeLibraryProfile, renameLibraryProfile } = await import("./profileEdits.ts");
const { takeLibraryCounts } = await import("../telemetry/libraryCounts.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const WORK = { id: "work", name: "Work", color: "blue", icon: null, createdAt: 1 };
const SCHOOL = { id: "school", name: "School", color: "green", icon: null, createdAt: 2 };

function threeProfiles() {
  S().hydrate({ profiles: { default: PERSONAL, work: WORK, school: SCHOOL }, profileOrder: ["default", "work", "school"] });
  takeLibraryCounts();
}

const edits = () => Object.fromEntries(Object.entries(takeLibraryCounts()).filter(([key, n]) => key.startsWith("library_profile_edits_") && n > 0));

test("moving a profile puts it at the slot it was dropped on, and a drop in place changes nothing", () => {
  assert.deepEqual(movedProfileOrder(["a", "b", "c"], "a", 2), ["b", "c", "a"]);
  assert.deepEqual(movedProfileOrder(["a", "b", "c"], "c", -4), ["c", "a", "b"]);
  assert.equal(movedProfileOrder(["a", "b", "c"], "b", 1), null);
  assert.equal(movedProfileOrder(["a", "b"], "z", 0), null);
});

test("edits from the Library change the shared profile store and count once each, by kind", () => {
  threeProfiles();
  assert.equal(renameLibraryProfile("work", "  Office  "), true);
  assert.equal(S().profiles.work.name, "Office");
  assert.equal(renameLibraryProfile("work", "Office"), true, "the same name commits without an edit");
  assert.equal(renameLibraryProfile("work", "   "), false, "a blank name is refused");
  assert.equal(S().profiles.work.name, "Office");
  colorLibraryProfile("school", "orange");
  colorLibraryProfile("school", "orange");
  assert.equal(S().profiles.school.color, "orange");
  moveLibraryProfile("school", 0);
  nudgeLibraryProfile("default", -1);
  nudgeLibraryProfile("work", 1);
  assert.deepEqual(S().profileOrder, ["default", "school", "work"], "the last profile stays last");
  assert.deepEqual(edits(), { library_profile_edits_rename: 1, library_profile_edits_color: 1, library_profile_edits_reorder: 2 });
});
