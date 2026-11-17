import assert from "node:assert/strict";
import { test } from "node:test";
const { diaProfilesFor, diaProfilesWithoutFolder } = await import("./diaTabs.ts");

const dia = (profiles) => ({ profiles: profiles.map(([name, index]) => ({ id: `${index}:${name}`, name, index, pinned: [], tabs: [] })), windowCount: 1, skipped: 0, duplicates: 0, favicons: [] });
const onDisk = [
  { id: "Default", name: "Personal" },
  { id: "Profile 2", name: "Work" },
];
const ids = (map) => Object.fromEntries([...map].map(([k, v]) => [k, v.id]));

test("Dia's tabs go to the profile on disk with the same name, whatever the order", () => {
  assert.deepEqual(ids(diaProfilesFor(dia([["Work", 1], [" personal ", 2]]), onDisk)), { Default: "2: personal ", "Profile 2": "1:Work" });
});

test("without a name match a Dia profile goes by position, never onto a profile another one is named after", () => {
  assert.deepEqual(ids(diaProfilesFor(dia([["Profile 1", 1], ["Work", 2]]), onDisk)), { Default: "1:Profile 1", "Profile 2": "2:Work" });
  assert.deepEqual(ids(diaProfilesFor(dia([["Work", 1]]), onDisk)), { "Profile 2": "1:Work" });
});

test("profiles sharing a name each get their own Dia profile, by position", () => {
  const twins = [
    { id: "Default", name: "Personal" },
    { id: "Profile 2", name: "personal" },
  ];
  assert.deepEqual(ids(diaProfilesFor(dia([["Personal", 1], ["Personal", 2]]), twins)), { Default: "1:Personal", "Profile 2": "2:Personal" });
});

test("a Dia profile with tabs and no folder on disk is left for a new profile, an empty one isn't", () => {
  const result = dia([["Personal", 1], ["Work", 2], ["Side project", 3], ["Empty", 4]]);
  result.profiles[2].pinned = [{ url: "https://a.example/", title: "A", pinned: true }];
  assert.deepEqual(diaProfilesWithoutFolder(result, onDisk).map((d) => d.id), ["3:Side project"]);
});

test("a folderless Dia profile is only taken for the tab kinds being imported, so none gets an empty profile", () => {
  const result = dia([["Personal", 1], ["Work", 2], ["Pins only", 3], ["Open only", 4]]);
  result.profiles[2].pinned = [{ url: "https://a.example/", title: "A", pinned: true }];
  result.profiles[3].tabs = [{ url: "https://b.example/", title: "B", pinned: false }];
  const ids = (kinds) => diaProfilesWithoutFolder(result, onDisk, kinds).map((d) => d.id);
  assert.deepEqual(ids({ pinned: true, open: true }), ["3:Pins only", "4:Open only"]);
  assert.deepEqual(ids({ pinned: false, open: true }), ["4:Open only"]);
  assert.deepEqual(ids({ pinned: true, open: false }), ["3:Pins only"]);
  assert.deepEqual(ids({ pinned: false, open: false }), []);
});
