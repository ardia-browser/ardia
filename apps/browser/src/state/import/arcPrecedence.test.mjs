import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { importArcSpace } = await import("./apply.ts");
const { isPinnedRow } = await import("../browser/model.ts");

const S = () => useBrowser.getState();
const P = "default";
const link = (url) => ({ type: "url", title: url, url });
const folder = (title, children) => ({ type: "folder", title, children });
const space = (pinned, tabs = []) => ({ id: "s", name: "Home", profileId: P, pinned, tabs: tabs.map((url) => ({ url, title: url })) });

function start() {
  S().hydrate({});
  return S().createWindow({ url: "https://home.example/" });
}

const groupHolding = (url) => Object.values(S().groups).find((g) => g.tabIds.some((id) => S().tabs[id].url === url));

test("a page that is both in an Arc folder and a later top-level pin stays a pinned row", () => {
  start();
  importArcSpace(P, space([folder("Stuff", [link("https://both.example/"), link("https://only.example/")]), link("https://both.example/")]));
  const copies = Object.values(S().tabs).filter((t) => t.url === "https://both.example/");
  assert.equal(copies.length, 1);
  assert.ok(isPinnedRow(copies[0]));
  assert.equal(groupHolding("https://both.example/"), undefined);
});

test("a page in an Arc folder and in its open tabs comes over in both", () => {
  start();
  importArcSpace(P, space([folder("Stuff", [link("https://both.example/")])], ["https://both.example/"]));
  const copies = Object.values(S().tabs).filter((t) => t.url === "https://both.example/");
  assert.equal(copies.length, 2);
  assert.ok(copies.some((t) => groupHolding(t.url) && S().groups[Object.keys(S().groups).find((id) => S().groups[id].tabIds.includes(t.id))].name === "Imported"));
});
