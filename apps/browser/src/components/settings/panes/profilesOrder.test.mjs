import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SETTINGS } from "../settingsIndex.ts";

const overview = () => {
  const source = readFileSync(new URL("./Profiles.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("function ProfileOverview("), source.indexOf("function AllProfilesSection("));
  return [...body.matchAll(/<(ProfileBar|ThisProfileSection|SearchSection|PasswordsSection|ExtensionsSection|DataSection|AllProfilesSection)\b/g)].map((m) => m[1]);
};

test("Settings › Profiles opens with the profile picker on top, the picked profile's settings under it, and the settings for all profiles last", () => {
  assert.deepEqual(overview(), ["ProfileBar", "ThisProfileSection", "SearchSection", "PasswordsSection", "ExtensionsSection", "DataSection", "AllProfilesSection"]);
});

test("the search index lists the Profiles sections in the order the page shows them", () => {
  const sections = [...new Set(SETTINGS.filter((s) => s.pane === "profiles").map((s) => s.section))];
  assert.deepEqual(sections, ["Profiles", "This profile", "Search", "Passwords and autofill", "Extensions", "Data", "For all profiles"]);
});
