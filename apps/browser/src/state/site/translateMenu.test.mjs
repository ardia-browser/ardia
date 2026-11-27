import assert from "node:assert/strict";
import { test } from "node:test";
const { translateMenuItems } = await import("./translateMenu.ts");

const G = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
const keys = (i) => (i.key ? ["control", "option", "shift", "command"].filter((m) => i.modifiers?.includes(m)).map((m) => G[m]).join("") + i.key.toUpperCase() : "");
const render = (items, depth = 0) =>
  items.flatMap((i) => [
    "  ".repeat(depth) + (i.separator ? "---" : [i.checked ? "✓" : "", i.title, keys(i), i.symbol ? `[${i.symbol}]` : "", i.swatch ? "(swatch)" : "", i.enabled === false ? "(off)" : "", i.children ? "›" : ""].filter(Boolean).join(" ")),
    ...(i.children ? render(i.children, depth + 1) : []),
  ]);

test("the translate button's menu puts the other languages in a submenu", () => {
  const languages = [
    { id: "fr", name: "French", current: true },
    { id: "de", name: "German", current: false },
  ];
  assert.deepEqual(render(translateMenuItems({ translated: true, target: "English", languages, neverTranslate: false })), [
    "Show Original [arrow.uturn.backward]",
    "Choose Another Language [globe] ›",
    "  ✓ French",
    "  German",
    "---",
    "Never Translate This Site",
  ]);
  assert.deepEqual(render(translateMenuItems({ translated: false, target: "English", languages: [], neverTranslate: null })), ["Translate to English [translate]"]);
});

test("the page's right-click menu offers the translation only where the translate button shows", async () => {
  const { translatePageMenu, translatePageMenuItems } = await import("./translateMenu.ts");
  const items = (state) => translatePageMenuItems(translatePageMenu(state), "English");
  assert.deepEqual(items({ status: "idle", source: "de" }), [{ id: "translatePage", title: "Translate to English" }]);
  assert.deepEqual(items({ status: "idle", source: null }), []);
  assert.deepEqual(items(undefined), []);
  assert.deepEqual(items({ status: "translating", source: "de" }), [{ id: "showOriginal", title: "Show Original" }]);
  assert.deepEqual(items({ status: "translated", source: "ja" }), [{ id: "showOriginal", title: "Show Original" }]);
  assert.equal(translatePageMenu({ status: "translating", source: "de" }), translatePageMenu({ status: "translated", source: "ja" }));
});
