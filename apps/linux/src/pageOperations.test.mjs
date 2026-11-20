import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pageOperations, pageOperationsHeader } from "../scripts/page-operations.mjs";
import { CLOSE_DOCUMENT_PICTURE_IN_PICTURE, PICTURE_IN_PICTURE_STATE, UNSAVED_WORK, WEB_STORE_REQUEST, hostPageScript } from "./hostPageScripts.ts";
import { useBrowser } from "../../browser/src/state/browser/store.ts";
import { webviews } from "../../browser/src/platform/webviews.ts";
import { updateLive } from "../../browser/src/state/tabs/actions.ts";
import { copyLinkToSelection, copyPageUrl, jumpToSelection, replaceInField } from "../../browser/src/state/site/selection.ts";
import { runCommand } from "../../browser/src/state/commands/commands.ts";
import { closeReader, readerState, startReader, toggleReader } from "../../browser/src/state/reader/reader.ts";
import { READER_FONTS, READER_SIZES } from "../../browser/src/state/reader/tokens.ts";
import { pickerCall } from "../../browser/src/state/site/elementPicker.ts";
import { PICKER_TAKE, linuxPickerStart, pickOnLinuxPage, pickerStartPoint } from "./elementPickerHost.ts";

const TABLE = new URL("../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_page_operations.h", import.meta.url);
const EVALUATION = new URL("../../../engine/ardiacore-linux/src/ardia/linux/ac_linux_page_evaluation.h", import.meta.url);
const READER_OPERATIONS = ["readerCheck", "readerState", "readerHide", "readerToggle", "readerOpen", "readerSetLook"];

function recordingView(answers = {}) {
  const scripts = [];
  const view = new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === "evaluate") return async (script) => {
        scripts.push(script);
        for (const [prefix, answer] of Object.entries(answers)) if (script.startsWith(prefix)) return answer;
        return null;
      };
      return async () => null;
    },
  });
  return { view, scripts };
}

function pinned(text) {
  const bytes = Buffer.from(text, "utf8");
  return { length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function tableRows() {
  const rows = new Map();
  for (const match of readFileSync(TABLE, "utf8").matchAll(/\{"(\w+)", (\d+), "([0-9a-f]{64})", LinuxPageOperationArgs::(\w+), ("(?:[^"\\]|\\.)*")\}/g)) {
    rows.set(match[1], { length: Number(match[2]), sha256: match[3], args: match[4], suffix: JSON.parse(match[5]) });
  }
  return rows;
}

function mountTab(url = "https://example.test/") {
  useBrowser.getState().hydrate({});
  const windowId = useBrowser.getState().createWindow({ url });
  const tabId = useBrowser.getState().windows[windowId].tabIds[0];
  return { windowId, tabId };
}

const operation = (name) => pageOperations().find((entry) => entry.name === name);

test("the pinned evaluation table matches the shared sources", () => {
  assert.equal(readFileSync(TABLE, "utf8"), pageOperationsHeader(), "ac_linux_page_operations.h is stale: run apps/linux/scripts/page-operations.mjs --write");
  const rows = tableRows();
  assert.deepEqual([...rows.keys()], pageOperations().map((entry) => entry.name));
  for (const entry of pageOperations()) {
    const row = rows.get(entry.name);
    assert.deepEqual(row, { ...pinned(entry.text), args: entry.args, suffix: entry.suffix });
  }
  for (const name of READER_OPERATIONS) assert.ok(rows.has(name), name);
  const header = readFileSync(TABLE, "utf8");
  assert.match(header, new RegExp(`kLinuxReaderLookSizes = ${READER_SIZES.length};`));
  assert.ok(header.includes(`kLinuxReaderLookFonts = {{${READER_FONTS.map((font) => JSON.stringify(font)).join(", ")}}};`));
});

test("every pinned operation with its widest arguments fits the host's code cap", () => {
  const cap = readFileSync(EVALUATION, "utf8").match(/kLinuxPageEvaluationCodeMax = (\d+) \* 1024;/);
  assert.ok(cap);
  const widestLook = JSON.stringify({ dark: false, size: READER_SIZES.length - 1, font: READER_FONTS.reduce((a, b) => (a.length >= b.length ? a : b)) });
  for (const entry of pageOperations()) {
    const widest = entry.args === "kLook" ? widestLook : entry.args === "kReplace" ? "x".repeat(2 * 6 * 4096 + 16) : "";
    assert.ok(Buffer.byteLength(entry.text + widest + entry.suffix) <= Number(cap[1]) * 1024, entry.name);
  }
});

function readerOperationOf(script) {
  for (const entry of pageOperations().filter((candidate) => READER_OPERATIONS.includes(candidate.name))) {
    if (entry.args === "kNone" && script === entry.text) return { name: entry.name };
    if (entry.args === "kLook" && script.startsWith(entry.text) && script.endsWith(entry.suffix) && script.length > entry.text.length + entry.suffix.length) {
      return { name: entry.name, look: script.slice(entry.text.length, script.length - entry.suffix.length) };
    }
  }
  return { name: null };
}

test("the reader sends exactly the pinned reader operations and a canonical look", async () => {
  const { tabId } = mountTab("https://example.test/article");
  const sent = [];
  const answers = {
    readerCheck: { active: false, readerable: true },
    readerToggle: { active: true, look: { dark: false, size: 1, font: "serif" } },
    readerSetLook: { active: true, look: { dark: false, size: 1, font: "sans" } },
    readerState: { active: true, look: { dark: false, size: 1, font: "sans" } },
    readerHide: { active: false },
  };
  webviews.set(tabId, { evaluate: async (script) => {
    const found = readerOperationOf(script);
    sent.push(found);
    return answers[found.name] ?? null;
  } });
  const stop = startReader();
  try {
    updateLive(tabId, { isLoading: true });
    updateLive(tabId, { isLoading: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(readerState(tabId).available, true);
    await toggleReader(tabId);
    assert.equal(readerState(tabId).active, true);
    useBrowser.getState().updateSettings({ readerFont: "sans" });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await closeReader(tabId);
    assert.equal(readerState(tabId).active, false);
    const names = sent.map((entry) => entry.name);
    assert.ok(!names.includes(null), JSON.stringify(names));
    for (const name of ["readerCheck", "readerToggle", "readerSetLook", "readerState", "readerHide"]) assert.ok(names.includes(name), name);
    for (const { look } of sent.filter((entry) => entry.look !== undefined)) {
      const parsed = JSON.parse(look);
      assert.deepEqual(Object.keys(parsed), ["dark", "size", "font"]);
      assert.equal(look, `{"dark":${parsed.dark},"size":${parsed.size},"font":${JSON.stringify(parsed.font)}}`);
    }
  } finally {
    stop();
    webviews.delete(tabId);
  }
});

test("the derived operation texts equal what the shared modules send at runtime", async () => {
  const { windowId, tabId } = mountTab();
  const { view, scripts } = recordingView({ [operation("hasSelection").text]: true, [operation("replaceInField").text]: { field: true, count: 1 } });
  webviews.set(tabId, view);
  try {
    await jumpToSelection(tabId);
    assert.equal(scripts.at(-1), operation("jumpToSelection").text);

    await copyPageUrl(tabId);
    assert.equal(scripts.at(-1), operation("hasSelection").text);

    await copyLinkToSelection(tabId);
    assert.equal(scripts.at(-1), operation("selectionContext").text);

    const result = await replaceInField(tabId, "a\"b", "c d", true);
    assert.deepEqual(result, { field: true, count: 1 });
    const replace = scripts.at(-1);
    assert.ok(replace.startsWith(operation("replaceInField").text));
    assert.equal(replace.slice(operation("replaceInField").text.length), `${JSON.stringify("a\"b")}, ${JSON.stringify("c d")}, true)`);

    runCommand({ command: "useSelectionForFind", arg: null, windowId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scripts.at(-1), operation("selectedText").text);
  } finally {
    webviews.delete(tabId);
  }
});

test("the page scripts Linux answers itself are accepted by the host page-script router", () => {
  for (const [method, script] of [["evaluate", PICTURE_IN_PICTURE_STATE], ["executeJavaScript", CLOSE_DOCUMENT_PICTURE_IN_PICTURE], ["evaluate", UNSAVED_WORK], ["evaluate", WEB_STORE_REQUEST]]) {
    assert.ok(hostPageScript(method, [script]), script.slice(0, 40));
  }
});

function matchOperation(script) {
  for (const entry of pageOperations()) {
    if (entry.args === "kNone" && script === entry.text) return { name: entry.name };
    if (entry.args !== "kNone" && script.startsWith(entry.text) && script.endsWith(entry.suffix) && script.length > entry.text.length + entry.suffix.length) {
      return { name: entry.name, args: script.slice(entry.text.length, script.length - entry.suffix.length) };
    }
  }
  return null;
}

test("every element picker script the shell sends on Linux is a pinned operation carrying only its argument", () => {
  const rows = tableRows();
  for (const name of ["elementPickerStart", "elementPickerTake", "elementPickerCancel", "elementPickerApply", "elementPickerUnhide"]) assert.ok(rows.has(name), name);
  assert.deepEqual(matchOperation(linuxPickerStart([10.5, 20])), { name: "elementPickerStart", args: "[10.5,20]" });
  assert.deepEqual(matchOperation(linuxPickerStart(null)), { name: "elementPickerStart", args: "null" });
  assert.deepEqual(matchOperation(PICKER_TAKE), { name: "elementPickerTake" });
  assert.deepEqual(matchOperation(pickerCall("cancel")), { name: "elementPickerCancel" });
  assert.deepEqual(matchOperation(pickerCall("apply", ["#a", "div.b"])), { name: "elementPickerApply", args: '["#a","div.b"]' });
  assert.deepEqual(matchOperation(pickerCall("unhide", ["#a"])), { name: "elementPickerUnhide", args: '["#a"]' });
  assert.equal(matchOperation(pickerCall("start", [1, 2])), null, "the shared start waits on a promise the host can't await, so the shell never sends it");
  for (const script of [linuxPickerStart([1, 2]), PICKER_TAKE]) assert.doesNotThrow(() => new Function("post", script));
});

test("the shell turns the shared picker start into a start and a poll until the pick settles", async () => {
  assert.deepEqual(pickerStartPoint(pickerCall("start", [3, 4])), { point: [3, 4] });
  assert.deepEqual(pickerStartPoint(pickerCall("start", null)), { point: null });
  for (const script of [pickerCall("cancel"), pickerCall("apply", ["#a"]), pickerCall("start", "x"), "post(1)", 5]) assert.equal(pickerStartPoint(script), null);
  const sent = [];
  const answers = [{ pending: true }, { pending: true }, { pick: { selector: "div.ad" } }];
  const evaluate = async (script) => {
    sent.push(script);
    return script === PICKER_TAKE ? answers.shift() : null;
  };
  assert.deepEqual(await pickOnLinuxPage(evaluate, [3, 4], async () => {}), { selector: "div.ad" });
  assert.deepEqual(sent, [linuxPickerStart([3, 4]), PICKER_TAKE, PICKER_TAKE, PICKER_TAKE]);
  assert.equal(await pickOnLinuxPage(async () => null, null, async () => {}), null, "a page that went away ends the pick");
});
