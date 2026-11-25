import assert from "node:assert/strict";
import test from "node:test";
import { parseChoiceChange, shownAfter } from "./telemetryChoice.ts";

const parse = (value) => parseChoiceChange(JSON.stringify(value));

test("a sharing change carries on or off, where it was made and the New Tab placement", () => {
  assert.deepEqual(parse({ kind: "sharing", on: false, source: "settings" }), { kind: "sharing", on: false, source: "settings" });
  assert.deepEqual(parse({ kind: "sharing", on: true, source: "ask", placement: { ask_place: "new_tab_corner", ask_shown_tabs: 3, extra: "x" }, extra: 1 }), { kind: "sharing", on: true, source: "ask", placement: { ask_place: "new_tab_corner", ask_shown_tabs: 3 } });
  for (const bad of [{ kind: "sharing", on: "yes", source: "settings" }, { kind: "sharing", on: true, source: "required" }, { kind: "sharing", on: true, source: "ask", placement: { ask_place: "elsewhere", ask_shown_tabs: 1 } }, { kind: "sharing", on: true, source: "ask", placement: { ask_place: "new_tab_corner", ask_shown_tabs: 1.5 } }]) {
    assert.equal(parse(bad), null, JSON.stringify(bad));
  }
});

test("the other changes keep only their own fields", () => {
  assert.deepEqual(parse({ kind: "askDismissed", on: true }), { kind: "askDismissed" });
  assert.deepEqual(parse({ kind: "watchStopped" }), { kind: "watchStopped" });
  assert.deepEqual(parse({ kind: "watchNoticeShown" }), { kind: "watchNoticeShown" });
  assert.deepEqual(parse({ kind: "watchStarted", reportId: "r-1", days: 14 }), { kind: "watchStarted", reportId: "r-1", days: 14 });
  assert.deepEqual(parse({ kind: "installId", id: "7c13ed81" }), { kind: "installId", id: "7c13ed81" });
  for (const bad of [{ kind: "watchStarted", reportId: "", days: 14 }, { kind: "watchStarted", reportId: "r", days: "14" }, { kind: "installId", id: "x".repeat(129) }, { kind: "installId" }, { kind: "forceOn" }, [], "sharing", null]) {
    assert.equal(parse(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseChoiceChange("{"), null);
  assert.equal(parseChoiceChange(undefined), null);
});

test("the asking window shows a sharing answer at once and waits for the owner on the rest", () => {
  assert.deepEqual(shownAfter({ kind: "sharing", on: false, source: "settings" }), { sharing: false, decided: true, askDone: true });
  assert.deepEqual(shownAfter({ kind: "askDismissed" }), { askDone: true });
  assert.equal(shownAfter({ kind: "watchStopped" }), null);
  assert.equal(shownAfter({ kind: "installId", id: "a" }), null);
});
