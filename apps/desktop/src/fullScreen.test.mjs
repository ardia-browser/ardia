import assert from "node:assert/strict";
import test from "node:test";

const invoked = [];
globalThis.window = { __ardiaHost: {
  bootstrap: { windowId: "main", profileId: "default", capabilities: ["ArdiaShell.toggleFullScreen", "tab.edit"] },
  invoke: async (method, args) => { invoked.push([method, args]); return true; },
  call: async () => "null",
  onEvent: () => () => {},
} };
const { linuxBindings, linuxMenuShortcuts } = await import("./shortcuts.ts");
const { linuxCapabilities, unavailableCommands } = await import("./hostCapabilities.ts");
const { runAppCommand } = await import("./appServices.ts");
delete globalThis.window;

const F11 = String.fromCharCode(0xf70e);

const MAC = process.env.ARDIA_DESKTOP_MODE === "mac";
const FULL_SCREEN = MAC
  ? { key: "f", modifiers: ["function"], binding: { keyCode: 70, modifiers: 16 | 4, command: "toggleFullScreen", arg: null, notInText: false } }
  : { key: F11, modifiers: [], binding: { keyCode: 122, modifiers: 0, command: "toggleFullScreen", arg: null, notInText: false } };

test("a host that goes full screen gets the entry, its platform's shortcut (F11, or the Mac's 🌐F and ⌃⌘F) and a row in Keyboard Shortcuts", () => {
  const capabilities = linuxCapabilities();
  assert.equal(capabilities.fullScreen, true);
  assert.equal(capabilities.pageEdits, true);
  assert.equal(unavailableCommands(capabilities).has("std:toggleFullScreen:"), false);
  const row = linuxMenuShortcuts().find((item) => item.id === "std:toggleFullScreen:");
  assert.deepEqual([row.title, row.path, row.key, row.modifiers, row.remappable], ["Enter Full Screen", ["View"], FULL_SCREEN.key, FULL_SCREEN.modifiers, true]);
  assert.deepEqual(linuxBindings().find((binding) => binding.command === "toggleFullScreen"), FULL_SCREEN.binding);
  assert.deepEqual(linuxBindings({ "std:toggleFullScreen:": ["f", "command", "control"] }).find((binding) => binding.command === "toggleFullScreen").keyCode, 70, "and it can be remapped");
});

test("the command asks the host to toggle full screen for the window it came from", async () => {
  const capabilities = linuxCapabilities();
  invoked.length = 0;
  const host = { bootstrap: { windowId: "w7", profileId: "default", capabilities: [] }, invoke: async (method, args) => { invoked.push([method, args]); return true; } };
  assert.equal(runAppCommand("w7", "toggleFullScreen", capabilities, host), true);
  await new Promise(setImmediate);
  assert.deepEqual(invoked, [["ArdiaShell.toggleFullScreen", { args: ["w7"] }]]);
  invoked.length = 0;
  assert.equal(runAppCommand("w7", "toggleFullScreen", { ...capabilities, fullScreen: false }, host), true);
  await new Promise(setImmediate);
  assert.deepEqual(invoked, [], "a host without the call is never asked");
});
