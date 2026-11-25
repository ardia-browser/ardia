import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { notingPageFocus, watchPageFocus } from "./pageFocus.ts";

test("a page taking focus tells every watcher before the page's own focus handler runs", () => {
  const calls = [];
  const stopA = watchPageFocus(() => calls.push("a"));
  const stopB = watchPageFocus(() => calls.push("b"));
  const props = notingPageFocus({ tabId: "t1", onPageFocus: () => calls.push("page") });
  props.onPageFocus();
  assert.deepEqual(calls, ["a", "b", "page"]);
  stopA();
  props.onPageFocus();
  assert.deepEqual(calls, ["a", "b", "page", "b", "page"]);
  stopB();
  notingPageFocus({})?.onPageFocus();
  assert.equal(calls.length, 5);
});

test("a focus watcher that throws doesn't keep the other watchers or the page's own focus handler from running", () => {
  const calls = [];
  const reported = [];
  const original = console.error;
  console.error = (...args) => reported.push(args);
  const stopA = watchPageFocus(() => { throw new Error("watcher failed"); });
  const stopB = watchPageFocus(() => calls.push("b"));
  try {
    notingPageFocus({ onPageFocus: () => calls.push("page") }).onPageFocus();
  } finally {
    console.error = original;
    stopA();
    stopB();
  }
  assert.deepEqual(calls, ["b", "page"]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0][1].message, "watcher failed");
});

test("focusIfUnfocused gives the page the keyboard unless a shell field has it, and answers whether it did", async () => {
  const { focusPageIfShellUnfocused, watchPageFocusRequests } = await import("./pageFocus.ts");
  const field = { matches: (selector) => selector.includes("input") };
  const body = { matches: () => false };
  const requests = [];
  const stop = watchPageFocusRequests(() => requests.push("request"));
  const focused = [];
  const focusPage = () => (focused.push("page"), Promise.resolve());
  assert.equal(await focusPageIfShellUnfocused(focusPage, field), false);
  assert.deepEqual(focused, []);
  assert.equal(await focusPageIfShellUnfocused(focusPage, body), true);
  assert.equal(await focusPageIfShellUnfocused(focusPage, null), true);
  assert.deepEqual(focused, ["page", "page"]);
  assert.deepEqual(requests, ["request", "request"]);
  assert.equal(await focusPageIfShellUnfocused(() => Promise.reject(new Error("Ardia tab is not mounted")), body), false, "a failed focus answers false instead of rejecting");
  stop();
});

test("a shell text field focused while a page holds the keyboard asks a page to hand the keyboard to the shell", async () => {
  const { canYieldKeyboard, handKeyboardToShell } = await import("./pageFocus.ts");
  const calls = [];
  const field = { matches: (selector) => selector.includes("input"), isConnected: true };
  const refusing = { command: (command) => (calls.push(`refused ${command}`), Promise.reject(new Error("unknown command"))) };
  const yielding = { command: (command, args) => (calls.push(`${command} ${args.length}`), Promise.resolve()) };
  const stopRefusing = canYieldKeyboard(refusing);
  const stopYielding = canYieldKeyboard(yielding);
  assert.equal(await handKeyboardToShell(field, () => false, () => field), true);
  assert.deepEqual(calls, ["refused blur", "blur 0"], "a page that can't yield (Linux has no blur yet) is skipped");
  calls.length = 0;
  assert.equal(await handKeyboardToShell(field, () => true, () => field), false);
  assert.deepEqual(calls, [], "a shell that already has the keyboard asks no page");
  assert.equal(await handKeyboardToShell({ matches: () => false, isConnected: true }, () => false, () => null), false);
  assert.deepEqual(calls, [], "only a text field takes the keyboard from a page");
  stopRefusing();
  stopYielding();
  assert.equal(await handKeyboardToShell(field, () => false, () => field), true);
  assert.deepEqual(calls, [], "an unmounted page is never asked");
});

test("a handoff still waiting on the page never overrides a newer focus choice, and never moves focus itself", async () => {
  const { canYieldKeyboard, handKeyboardToShell } = await import("./pageFocus.ts");
  let release;
  const pending = new Promise((resolve) => (release = resolve));
  const focused = [];
  const field = { matches: () => true, isConnected: true, focus: () => focused.push("field") };
  const other = { matches: () => true, isConnected: true, focus: () => focused.push("other") };
  let active = field;
  const stop = canYieldKeyboard({ command: () => pending });
  const stale = handKeyboardToShell(field, () => false, () => active);
  active = other;
  release();
  assert.equal(await stale, false, "the user chose another element while the page yielded");
  const older = handKeyboardToShell(field, () => false, () => field);
  const newer = handKeyboardToShell(other, () => false, () => other);
  assert.deepEqual(await Promise.all([older, newer]), [false, true], "only the newest handoff counts");
  const gone = { ...field, isConnected: false };
  assert.equal(await handKeyboardToShell(gone, () => false, () => gone), false, "a field removed meanwhile is never reported focused");
  assert.deepEqual(focused, [], "a handoff never calls focus, so it can't steal it back");
  stop();
});

test("a shell text field's own focus() hands the keyboard over, so a pane that focuses its field without a focus claim (Ctrl+\\ opening a split) still gets the typing", async () => {
  const { canYieldKeyboard, handsKeyboardOnFocus } = await import("./pageFocus.ts");
  const calls = [];
  const previous = globalThis.document;
  let focusedField = null;
  const field = { matches: (selector) => selector.includes("input"), isConnected: true, focus(options) { focusedField = field; calls.push(`dom focus ${options?.preventScroll === true}`); } };
  globalThis.document = { hasFocus: () => false, get activeElement() { return focusedField; } };
  const stop = canYieldKeyboard({ command: (command) => (calls.push(command), Promise.resolve()) });
  try {
    handsKeyboardOnFocus(field);
    handsKeyboardOnFocus(field);
    field.focus({ preventScroll: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["dom focus true", "blur"], "the field takes DOM focus first, then one page hands over the keyboard");
  } finally {
    stop();
    globalThis.document = previous;
  }
  const shim = readFileSync(new URL("./shims/react-native.tsx", import.meta.url), "utf8");
  assert.ok(shim.includes("if (node) handsKeyboardOnFocus(node);"), "every desktop TextInput hands the keyboard over on focus");
  const split = readFileSync(new URL("../../browser/src/components/split/SplitEmptyState.tsx", import.meta.url), "utf8");
  assert.ok(split.includes("input.current?.focus();"), "the empty split pane focuses its field directly, which reaches the TextInput's focus");
  const shell = readFileSync(new URL("./shims/shellBase.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("node.focus();\n    await handKeyboardToShell(node);"), "a focus claim hands the keyboard over too");
});

test("a field React already focused for autoFocus before its ref attached still hands the keyboard over, once, and not when the shell has it", async () => {
  const { canYieldKeyboard, handsKeyboardOnFocus } = await import("./pageFocus.ts");
  const previous = globalThis.document;
  const calls = [];
  let shellHasKeyboard = false;
  const field = { matches: (selector) => selector.includes("input"), isConnected: true, focus() { calls.push("dom focus"); } };
  globalThis.document = { hasFocus: () => shellHasKeyboard, get activeElement() { return field; } };
  const stop = canYieldKeyboard({ command: (command) => (calls.push(command), Promise.resolve()) });
  try {
    handsKeyboardOnFocus(field);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["blur"], "React's commitHostMount focused it before attaching the ref, so attaching hands the keyboard over");
    handsKeyboardOnFocus(field);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["blur"], "attaching the same field again starts no second handoff");
    shellHasKeyboard = true;
    const focusedWithKeyboard = { ...field, focus() { calls.push("dom focus"); } };
    globalThis.document = { hasFocus: () => shellHasKeyboard, get activeElement() { return focusedWithKeyboard; } };
    handsKeyboardOnFocus(focusedWithKeyboard);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["blur"], "a shell that already has the keyboard asks no page");
    const unfocused = { ...field, focus() { calls.push("dom focus"); } };
    shellHasKeyboard = false;
    handsKeyboardOnFocus(unfocused, () => null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["blur"], "a field that isn't focused when attached waits for its own focus()");
  } finally {
    stop();
    globalThis.document = previous;
  }
});
