import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
const { FOLDER_SWAP_MS, folderSwapMs, folderSymbolFor } = await import("../../../../packages/expo-windows/src/views/folderSymbol.ts");
const { labelTextStyle } = await import("../../../../packages/expo-windows/src/views/labelStyle.ts");

const repo = new URL("../../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, repo), "utf8");
const sourcesIn = (folder) =>
  readdirSync(new URL(folder, repo))
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => read(folder + file));

const ASKED_BY = ["packages/shell/src/", "packages/ardiacore/src/", "packages/shaders/src/", "packages/import/src/", "packages/sync/src/"];
const DRAWN_AS_NOTHING_ON_WINDOWS = ["ArdiaMeadow", "ArdiaPlugins", "ArdiaPowerUp", "ArdiaReport", "ArdiaWebKit"];

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
  const unanswered = asked().filter((name) => !drawn.has(name) && !DRAWN_AS_NOTHING_ON_WINDOWS.includes(name));
  assert.deepEqual(unanswered, [], "a view the Mac added: without a Windows view it draws an empty box");
  assert.deepEqual(DRAWN_AS_NOTHING_ON_WINDOWS.filter((name) => drawn.has(name)), [], "listed as drawing nothing, but Windows draws it");
  assert.ok(asked().length > 20);
});

test("a group's folder is the folder symbol, filled while open, sized to its box", () => {
  assert.deepEqual(folderSymbolFor(false, 16), { name: "folder", size: 12.8 });
  assert.deepEqual(folderSymbolFor(true, 20), { name: "folder.fill", size: 16 });
  assert.deepEqual(folderSymbolFor(false, undefined), { name: "folder", size: 12.8 });
});

test("a group's folder swaps over the Mac's 0.2 s, less in proportion when it turns back part way, and at once with animation effects off", () => {
  assert.equal(FOLDER_SWAP_MS, 200);
  assert.equal(folderSwapMs(0, 1, false), 200);
  assert.equal(folderSwapMs(1, 0, false), 200);
  assert.equal(folderSwapMs(0.25, 0, false), 50);
  assert.equal(folderSwapMs(0.6, 1, false), 80);
  assert.equal(folderSwapMs(1, 1, false), 0);
  assert.equal(folderSwapMs(0, 1, true), 0);
});

test("a label asked to strike its text through draws the line, and one not asked draws none", () => {
  assert.equal(labelTextStyle({ strikethrough: true }, false).textDecorationLine, "line-through");
  assert.equal("textDecorationLine" in labelTextStyle({}, false), false);
  assert.equal("textDecorationLine" in labelTextStyle({ strikethrough: false }, true), false);
  assert.deepEqual(labelTextStyle({ fontSize: 15, weight: "semibold", color: "#112233" }, true), { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"], color: "#112233" });
  assert.equal(labelTextStyle({}, true).color, "rgba(255,255,255,0.85)");
});

const NOT_ON_WINDOWS_YET = ["executeExtensionAction", "exitPictureInPicture", "mediaCaptureSourceId", "nativeTag", "notificationAction", "resolveAutofillPrompt", "resolveDisplayMedia", "resolvePasswordPrompt"];

const tableKeys = (source, name) => {
  const from = source.indexOf(`const ${name}:`);
  return [...source.slice(from, source.indexOf("\n};", from)).matchAll(/^  ([A-Za-z]+): /gm)].map(([, key]) => key);
};

test("every call the shared UI can make on a page is one Windows carries out or answers, or one it is listed as not having yet", () => {
  const types = read("packages/ardiacore/src/pageTypes.ts");
  const handle = types.slice(types.indexOf("export type WebViewHandle"));
  const asked = [...handle.slice(0, handle.indexOf("\n};")).matchAll(/^  ([A-Za-z]+)\(/gm)].map(([, name]) => name);
  const view = read("packages/expo-windows/src/engine/EngineWebView.tsx");
  const calls = read("packages/expo-windows/src/engine/pageCalls.ts");
  const has = new Set([...tableKeys(calls, "ARGUMENTS"), ...tableKeys(calls, "MISSING_ANSWERS"), ...[...view.matchAll(/if \(method === "([A-Za-z]+)"\) return /g)].map(([, name]) => name)]);
  assert.ok(asked.length > 30 && has.size > 25);
  assert.deepEqual(asked.filter((name) => !has.has(name) && !NOT_ON_WINDOWS_YET.includes(name)), [], "a page call the Mac added: on Windows it does nothing and answers null");
  assert.deepEqual(NOT_ON_WINDOWS_YET.filter((name) => has.has(name) || !asked.includes(name)), [], "listed as missing, but Windows has it or the Mac dropped it");
});
