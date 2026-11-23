import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
const { folderSymbolFor } = await import("../../../../packages/expo-windows/src/views/folderSymbol.ts");
const { labelTextStyle } = await import("../../../../packages/expo-windows/src/views/labelStyle.ts");

const repo = new URL("../../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");
const sourcesIn = (folder) =>
  readdirSync(new URL(folder, repo))
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => read(folder + file));

const ASKED_BY = ["packages/shell/src/", "packages/ardiacore/src/", "packages/shaders/src/", "packages/import/src/", "packages/sync/src/"];
const DRAWN_AS_NOTHING_ON_WINDOWS = ["ArdiaFieldGlow", "ArdiaMeadow", "ArdiaPlugins", "ArdiaPowerUp", "ArdiaReport", "ArdiaWebKit"];
const PASSWORD_MANAGER_VIEWS = ["ArdiaAutofillCardField", "ArdiaVaultPasswordField", "ArdiaVaults"];
const passwordManagersOnWindows = () => /systemPasswordManagers: true\b/.test(read("apps/browser/src/lib/platformFeatures.windows.ts"));

const asked = () => {
  const names = new Set();
  for (const folder of ASKED_BY) for (const source of sourcesIn(folder)) for (const [, name] of source.matchAll(/requireNativeViewManager(?:<[^(]*>)?\("(Ardia[A-Za-z]+)"\)/g)) names.add(name);
  return [...names].sort();
};

const known = () => {
  const names = new Set();
  for (const source of [read("packages/expo-windows/src/views/index.ts"), read("packages/expo-windows/src/views/registry.tsx")]) for (const [, name] of source.matchAll(/\["(Ardia[A-Za-z]+)",/g)) names.add(name);
  return names;
};

test("every native view the shared UI asks for is one Windows draws, or one it is listed as drawing nothing for", () => {
  const drawn = known();
  assert.equal(passwordManagersOnWindows(), false, "the password manager views are left out only while Windows hides password managers");
  const unanswered = asked().filter((name) => !drawn.has(name) && !DRAWN_AS_NOTHING_ON_WINDOWS.includes(name) && !PASSWORD_MANAGER_VIEWS.includes(name));
  assert.deepEqual(unanswered, [], "a view the Mac added: without a Windows view it draws an empty box");
  assert.deepEqual(DRAWN_AS_NOTHING_ON_WINDOWS.filter((name) => drawn.has(name)), [], "listed as drawing nothing, but Windows draws it");
  assert.ok(asked().length > 20);
});

test("a group's folder is the folder symbol, filled while open, sized to its box", () => {
  assert.deepEqual(folderSymbolFor(false, 16), { name: "folder", size: 12.8 });
  assert.deepEqual(folderSymbolFor(true, 20), { name: "folder.fill", size: 16 });
  assert.deepEqual(folderSymbolFor(false, undefined), { name: "folder", size: 12.8 });
});

test("a label asked to strike its text through draws the line, and one not asked draws none", () => {
  assert.equal(labelTextStyle({ strikethrough: true }, false).textDecorationLine, "line-through");
  assert.equal("textDecorationLine" in labelTextStyle({}, false), false);
  assert.equal("textDecorationLine" in labelTextStyle({ strikethrough: false }, true), false);
  assert.deepEqual(labelTextStyle({ fontSize: 15, weight: "semibold", color: "#112233" }, true), { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"], color: "#112233" });
  assert.equal(labelTextStyle({}, true).color, "rgba(255,255,255,0.85)");
});
