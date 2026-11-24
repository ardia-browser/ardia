import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as sharedWords from "./sharedWords.ts";
import { actionWords, blockingWords, dismissWords, incognitoWords } from "./sharedWords.ts";

const source = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const literal = (word: string) => new RegExp(`(["'\`>])${word}(["'\`<])`);

test("Open has one owner: native and drawn Archive and Spaces and the open-link prompt read actionWords.open", () => {
  assert.equal(actionWords.open, "Open");
  for (const path of ["components/tabs/ExpoArchive.tsx", "components/tabs/ArchiveView.tsx", "components/sync/ExpoSpaces.tsx", "components/sync/SpacesView.tsx", "state/page/pagePrompts.ts"]) {
    const text = source(path);
    assert.doesNotMatch(text, literal("Open"), path);
    assert.match(text, /actionWords\.open/, path);
  }
});

test("Done has one owner: Settings, Archive, Library and Spaces take it from the shared Done control", () => {
  assert.equal(dismissWords.done, "Done");
  assert.doesNotMatch(source("components/settings/ExpoSettingsDone.tsx"), literal("Done"));
  assert.match(source("components/settings/ExpoSettingsDone.tsx"), /dismissWords\.done/);
  for (const path of ["components/tabs/ExpoArchive.tsx", "components/library/ExpoLibrary.tsx", "components/sync/ExpoSpaces.tsx"]) {
    const text = source(path);
    assert.doesNotMatch(text, /label=\{dismissWords\.done\}/, path);
    assert.match(text, /Done(ToolbarItem|Button)/, path);
  }
});

test("the blocking label has one owner, which the Trusted Sites explanation and all three page menus read", () => {
  assert.equal(blockingWords.blockAdsAndTrackers, "Block Ads and Trackers");
  for (const path of ["components/settings/ExpoBlockingPages.tsx", "components/browsing/PageMenuWords.tsx", "components/browsing/PageMenu.tsx", "components/browsing/MaterialPageMenu.tsx"]) {
    const text = source(path);
    assert.doesNotMatch(text, literal("Block Ads and Trackers"), path);
    assert.match(text, /blockingWords\.blockAdsAndTrackers/, path);
  }
});

test("Close Incognito Tabs has one owner: the deck's confirm, menus and bar, and Material's bar read incognitoWords", () => {
  assert.equal(incognitoWords.closeIncognitoTabs, "Close Incognito Tabs");
  for (const path of ["components/tabs/TabDeck.tsx", "components/tabs/DeckBottomBar.tsx", "components/ui/MaterialBottomBar.tsx"]) {
    const text = source(path);
    assert.doesNotMatch(text, /Close Incognito Tabs/, path);
    assert.match(text, /incognitoWords\.closeIncognitoTabs/, path);
  }
});

const shipping = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "dev" ? [] : shipping(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) && name !== "sharedWords.ts" ? [path] : [];
  });

test("no shipping file writes a shared word out as its own label literal", () => {
  const words = Object.values(sharedWords).flatMap((group) => (typeof group === "object" ? Object.values(group).filter((value): value is string => typeof value === "string") : []));
  const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = shipping(fileURLToPath(new URL("..", import.meta.url))).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return words.filter((word) => literal(escape(word)).test(text)).map((word) => `${path}: ${word}`);
  });
  assert.deepEqual(found, []);
});
