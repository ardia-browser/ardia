import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const COMPONENTS = new URL("..", import.meta.url).pathname;
const SCROLLERS = /(?<![\w.])<(Animated\.ScrollView|ScrollView|FlatList|SectionList|SheetScrollView)(?=\s)/g;
const OWNED_ELSEWHERE = new Set(["search/SearchTray.tsx"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

function openingTag(source: string, at: number): string {
  let depth = 0;
  for (let index = at; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0 && source[index - 1] !== "=") return source.slice(at, index + 1);
  }
  return source.slice(at);
}

function reactNativeScrollers() {
  return files(COMPONENTS).flatMap((path) => {
    const name = relative(COMPONENTS, path);
    if (OWNED_ELSEWHERE.has(name)) return [];
    const source = readFileSync(path, "utf8");
    return [...source.matchAll(SCROLLERS)].map((match) => ({ name, tag: openingTag(source, match.index!) })).filter(({ tag }) => !tag.includes("modifiers="));
  });
}

test("every scroll view, list and sheet the app draws turns bounce off at its source, unless it pulls to refresh", () => {
  const scrollers = reactNativeScrollers();
  assert.ok(scrollers.length > 20, `found ${scrollers.length}`);
  const bouncing = scrollers.filter(({ tag }) => !/bounces=\{(false|refresh !== undefined)\}/.test(tag) && !tag.includes("refreshControl"));
  assert.deepEqual(bouncing.map(({ name, tag }) => `${name}: ${tag.slice(0, 80)}`), []);
  const refreshing = scrollers.filter(({ tag }) => tag.includes("refreshControl"));
  for (const { name, tag } of refreshing) assert.ok(!/bounces=\{false\}/.test(tag), `${name} pulls to refresh and must keep its bounce`);
});

test("every SwiftUI Settings, Library and Archive page turns bounce off, except the ones that pull to refresh", () => {
  const pages = files(COMPONENTS).filter((path) => /\/Expo[A-Za-z]+\.tsx$/.test(path));
  const offenders: string[] = [];
  const off: string[] = [];
  for (const path of pages) {
    const source = readFileSync(path, "utf8");
    const calls = source.split("modifierList(").slice(1).map((rest) => rest.slice(0, rest.indexOf(";") >= 0 ? rest.indexOf(";") : rest.length));
    for (const call of calls) {
      if (!call.includes("settingsChrome()") || call.includes("accessibilityHidden(true)") || call.includes("ignoreSafeArea(")) continue;
      if (call.includes("neverBounces()")) off.push(relative(COMPONENTS, path));
      else if (!call.includes("refreshable(")) offenders.push(`${relative(COMPONENTS, path)}: ${call.slice(0, 80)}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual([...new Set(off)].sort(), [
    "library/ExpoLibrary.tsx",
    "settings/ExpoAboutPages.tsx",
    "settings/ExpoAppearancePage.tsx",
    "settings/ExpoBlockingPages.tsx",
    "settings/ExpoClearDataPage.tsx",
    "settings/ExpoInfoPages.tsx",
    "settings/ExpoPhrasePage.tsx",
    "settings/ExpoSearchEnginePage.tsx",
    "settings/ExpoSettingsPanes.tsx",
    "settings/ExpoSettingsRoot.tsx",
    "settings/ExpoSiteSettingsPage.tsx",
    "settings/ExpoSyncConnectPage.tsx",
    "tabs/ExpoArchive.tsx",
  ]);
});
