import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const nav = readFileSync(new URL("./NavButtons.tsx", import.meta.url), "utf8");
const reload = nav.slice(nav.indexOf("export const ReloadButton"), nav.indexOf("export const HistoryButton"));

test("a middle click on reload duplicates the tab, as the back and forward buttons answer one", () => {
  assert.match(reload, /<MouseArea style=\{place\?\.style\} onMiddleClick=\{onMiddleClick\}>/, "the reload button sits in a MouseArea, like the history buttons");
  assert.match(reload, /const onMiddleClick = useStableHandler\(\(\) => \{\n\s*if \(!tab\.url\) return;\n\s*void duplicateTab\(tab\.id\);/, "a middle click duplicates the shown tab, and a button with no url does nothing");
  assert.match(nav, /import \{ newTab, duplicateTab \} from "\.\.\/\.\.\/state\/tabs\/actions";/);
});

test("a left click on reload still reloads, and the duplicate only answers the middle button", () => {
  assert.match(reload, /if \(m\.metaKey\) return void newTab\(tab\.windowId, \{ url: tab\.url, background: true, openerId: tab\.id \}\);/);
  assert.match(reload, /void withLivePage\(tab\.id, \(page\) => \(m\.shiftKey \? page\.forceReload\(\) : page\.reload\(\)\)\);/);
  assert.doesNotMatch(reload.slice(reload.indexOf("const onMiddleClick")), /newTab\(/, "the middle click duplicates rather than opening a url in a new tab");
});
