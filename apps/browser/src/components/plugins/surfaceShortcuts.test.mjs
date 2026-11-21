import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const { useBrowser } = await import("../../state/browser/store.ts");
const { resolvedShortcuts } = await import("../../state/commands/commandShortcuts.ts");
const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
const { takePluginCounts } = await import("../../state/telemetry/pluginCounts.ts");
const { bindingsOf, pluginShortcutOf } = await import("../../lib/pluginShortcuts.ts");
const { SurfaceContext } = await import("./surfaceNodes.ts");
const { SurfaceShortcutScope } = await import("./SurfaceActions.tsx");
const { heldByArdia, panelShortcuts, menuKeyOf, shortcutHint } = await import("./surfaceShortcuts.ts");

const action = (title, shortcut, handler = title) => ({ type: "Action", props: { title, shortcut, onAction: { __handler: handler } }, children: [] });

function surface(t) {
  const fired = [];
  const reported = [];
  const dispatch = { plugin: "demo", surfaceId: "s1", windowId: "w1", kind: "command", fire: (ref, args, options) => (fired.push({ handler: ref.__handler, args, options }), true), render: () => null };
  const onKeys = (keys) => reported.push(keys);
  const mounted = mount(() => SurfaceShortcutScope({ onKeys, children: null }), { contexts: [[SurfaceContext, dispatch]] });
  t.after(() => mounted.unmount());
  return { fired, reported, scope: () => mounted.value.props.value, mounted };
}

function ardiaHeldLetter() {
  const resolved = resolvedShortcuts(useBrowser.getState());
  for (const keys of resolved.bindings.values()) {
    for (const k of keys) {
      if (!/^[a-z]$/.test(k.key) || !k.modifiers.includes("command")) continue;
      const words = k.modifiers.map((m) => ({ command: "cmd", control: "ctrl", option: "opt", shift: "shift" })[m]).filter(Boolean);
      const s = pluginShortcutOf([...words, k.key].join("+"));
      if (s) return { text: [...words, k.key].join("+"), shortcut: s, event: { key: k.key, metaKey: true, ctrlKey: k.modifiers.includes("control"), altKey: k.modifiers.includes("option"), shiftKey: k.modifiers.includes("shift") } };
    }
  }
  return null;
}

test("a declared shortcut runs its action through the same path as a click, a gesture included, and counts once", (t) => {
  setConsentPeriod(true, "shortcut-test");
  takePluginCounts();
  const { fired, scope } = surface(t);
  const copy = action("Copy", "cmd+shift+e", "h-copy");
  scope().register("panel", 0, bindingsOf([copy, action("Other", "cmd+k", "h-other")]));
  assert.equal(scope().keys.length, 4);
  assert.equal(scope().press({ key: "E", metaKey: true, shiftKey: true }), true);
  assert.deepEqual(fired, [{ handler: "h-copy", args: [], options: undefined }], "no gesture opt-out, so the press is a gesture like a click");
  assert.equal(takePluginCounts().plugin_action_shortcuts, 1);
  assert.equal(scope().press({ key: "e", metaKey: true }), false, "a key nothing declared passes on");
  assert.equal(scope().press({ key: "E", metaKey: true, shiftKey: true, altKey: true }), false);
  assert.equal(fired.length, 1);
});

test("the count takes the sharing period of the key press", (t) => {
  setConsentPeriod(false, null);
  takePluginCounts();
  const { fired, scope } = surface(t);
  scope().register("panel", 0, bindingsOf([action("Copy", "cmd+shift+e")]));
  scope().press({ key: "E", metaKey: true, shiftKey: true });
  assert.equal(fired.length, 1, "the action still runs with sharing off");
  assert.equal(takePluginCounts().plugin_action_shortcuts, 0);
});

test("the selected List item's action wins over the list's, a new selection takes over, and unmounting drops the keys", (t) => {
  setConsentPeriod(false, null);
  const { fired, reported, scope } = surface(t);
  scope().register("detail", 2, bindingsOf([action("Detail copy", "cmd+shift+e", "detail")]));
  scope().register("list", 0, bindingsOf([action("Row 1 copy", "cmd+shift+e", "row1"), action("List copy", "cmd+shift+e", "list")]));
  scope().press({ key: "E", metaKey: true, shiftKey: true });
  scope().register("list", 0, bindingsOf([action("Row 2 copy", "cmd+shift+e", "row2"), action("List copy", "cmd+shift+e", "list")]));
  scope().press({ key: "E", metaKey: true, shiftKey: true });
  scope().register("list", 0, null);
  scope().press({ key: "E", metaKey: true, shiftKey: true });
  assert.deepEqual(fired.map((f) => f.handler), ["row1", "row2", "detail"]);
  scope().register("detail", 0, null);
  assert.equal(scope().keys.length, 0);
  assert.equal(reported.at(-1), null, "the host hears there's nothing left to catch");
  assert.ok(reported.some((r) => r && r.keys.length === 2), "the host heard the keys while there were some");
});

test("a key Ardia's own command holds is never caught, shown or run", (t) => {
  const held = ardiaHeldLetter();
  if (!held) return t.skip("no Ardia command holds a cmd+letter a plugin could otherwise use");
  assert.equal(heldByArdia(held.shortcut), true, held.text);
  const { fired, scope } = surface(t);
  const mine = action("Mine", held.text);
  scope().register("panel", 0, bindingsOf([mine]));
  assert.equal(scope().keys.length, 0);
  assert.equal(scope().press(held.event), false);
  assert.equal(fired.length, 0);
  assert.equal(panelShortcuts([mine]).has(mine), false);
});

test("menus and buttons show the shortcut that wins, in Ardia's glyphs", () => {
  const copy = action("Copy", "cmd+shift+e");
  const twin = action("Twin", "cmd+shift+e");
  const shown = panelShortcuts([copy, twin, action("None")]);
  assert.equal(shortcutHint(shown.get(copy)), "⇧⌘E");
  assert.equal(shown.has(twin), false);
  assert.deepEqual(menuKeyOf(shown.get(copy)), { key: "e", modifiers: ["shift", "command"] });
  assert.deepEqual(menuKeyOf(undefined), {});
});

test("rebinding the Ardia command that held a key hands it to a mounted surface without a remount", async (t) => {
  const resolved = resolvedShortcuts(useBrowser.getState());
  let found = null;
  for (const [id, keys] of resolved.bindings) {
    for (const k of keys) {
      if (!/^[a-z]$/.test(k.key) || !k.modifiers.includes("command") || k.modifiers.length !== 1) continue;
      const s = pluginShortcutOf(`cmd+${k.key}`);
      if (s && heldByArdia(s)) found ??= { id, key: k.key, shortcut: s };
    }
  }
  if (!found) return t.skip("no rebindable Ardia command holds a cmd+letter");
  const before = useBrowser.getState().settings.shortcuts;
  t.after(() => useBrowser.setState((s) => ({ settings: { ...s.settings, shortcuts: before } })));
  const { scope, mounted } = surface(t);
  scope().register("panel", 0, bindingsOf([action("Mine", `cmd+${found.key}`)]));
  assert.equal(scope().keys.length, 0, "held by Ardia while bound");
  useBrowser.setState((s) => ({ settings: { ...s.settings, shortcuts: { ...s.settings.shortcuts, [found.id]: ["9", "command", "option", "control", "shift"] } } }));
  await mounted.flush?.();
  await new Promise((resolve) => setImmediate(resolve));
  if (heldByArdia(found.shortcut)) return t.skip(`${found.id} is fixed and can't be rebound`);
  assert.ok(scope().keys.some((k) => k.key === found.key && k.metaKey), "the freed key reaches the surface");
});
