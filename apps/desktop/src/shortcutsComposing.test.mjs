import assert from "node:assert/strict";
import test from "node:test";

test("a desktop shortcut key the input method is composing goes to the input method, not to a browser command", async () => {
  const listeners = new Map();
  globalThis.window ??= {};
  Object.assign(globalThis.window, { addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]), removeEventListener: () => {} });
  globalThis.document ??= {};
  globalThis.document.activeElement ??= null;
  globalThis.document.addEventListener ??= () => {};
  const { requireNativeModule } = await import("./shims/expo-modules-core.ts");
  const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
  const { recordShortcut, startLinuxShortcuts } = await import("./shortcutsRuntime.ts");
  const { keyboardCombo, linuxBindings } = await import("./shortcuts.ts");
  useBrowser.getState().hydrate({});
  await startLinuxShortcuts({ bootstrap: { windowId: "main" }, invoke: async () => {}, onEvent: () => () => {} });
  const commands = [];
  const sub = requireNativeModule("ArdiaShell").addListener("onCommand", (event) => commands.push(event.command));
  const plain = linuxBindings().find((b) => b.modifiers === 0 && b.keyCode >= 112 && b.keyCode <= 123 && !b.notInText);
  assert.ok(plain, "a bare function-key shortcut exists to press");
  const code = `F${plain.keyCode - 111}`;
  const press = (extra) => {
    const event = { key: code, code, keyCode: plain.keyCode, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, prevented: false, ...extra };
    event.preventDefault = () => { event.prevented = true; };
    event.stopImmediatePropagation = () => {};
    for (const listener of listeners.get("keydown") ?? []) listener(event);
    return event;
  };
  assert.equal(keyboardCombo(press({})).keyCode, plain.keyCode, "positive control: the bare key is the binding's");
  commands.length = 0;
  try {
    assert.equal(press({ isComposing: true }).prevented, false);
    assert.equal(press({ key: "Process", keyCode: 229 }).prevented, false);
    assert.deepEqual(commands, [], "nothing runs while composing");
    assert.equal(press({}).prevented, true);
    assert.deepEqual(commands, [plain.command], "the same key outside composition runs its shortcut");
    let recorded = "pending";
    const recording = recordShortcut().then((combo) => (recorded = combo));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(press({ key: "Process", keyCode: 229 }).prevented, false, "the recorder leaves a composing key to the input method");
    assert.equal(press({ key: "Escape", code: "Escape", keyCode: 27, isComposing: true }).prevented, false, "Escape that cancels a composition doesn't cancel recording");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(recorded, "pending");
    assert.equal(press({}).prevented, true);
    await recording;
    assert.notEqual(recorded, "pending", "the next real key ends the recording");
  } finally {
    sub.remove();
  }
});
