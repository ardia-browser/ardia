import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require("react-dom/server");
const { createElement } = require("react");
const { pressables } = await import("react-native");
const { Button } = await import("./Button.tsx");
const { toastWidth } = await import("./Toast.tsx");
const { toastLayout } = await import("./tokens.ts");
const { SplitToast } = await import("../split/SplitChrome.tsx");
const { showToast, useToasts } = await import("../../state/app/toasts.ts");
const { TOAST_ACTION_MS } = await import("../split/tokens.ts");

test("a toast's chip buttons are buttons to VoiceOver, named by their titles, and an accessibility tap presses them", () => {
  const pressed = [];
  pressables.length = 0;
  for (const title of ["Keep Running", "Sleep"]) renderToStaticMarkup(createElement(Button, { variant: "pill", tone: "chip", title, onPress: () => pressed.push(title) }));
  assert.deepEqual(pressables.map((p) => [p.accessibilityRole, p.accessibilityLabel]), [["button", "Keep Running"], ["button", "Sleep"]]);
  for (const b of pressables) b.onAccessibilityTap();
  assert.deepEqual(pressed, ["Keep Running", "Sleep"]);
  const toast = readFileSync(new URL("./Toast.tsx", import.meta.url), "utf8");
  assert.match(toast, /title=\{secondary\} onPress=\{onSecondary\}/);
  assert.match(toast, /title=\{action\} onPress=\{onAction\}/);
});

function shownToast(t, options) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  useToasts.setState({ toasts: {} });
  showToast("w", "Title", undefined, options);
  const mounted = mount(() => SplitToast.type({ windowId: "w" }));
  t.after(() => mounted.unmount());
  return mounted;
}

test("a two-button toast waits while it is pointed at or one of its buttons has keyboard focus, then gets its full time again", (t) => {
  const mounted = shownToast(t, { holdMs: 20_000, action: { title: "Sleep", run() {} }, secondary: { title: "Keep Running", run() {} } });
  const held = (on) => mounted.value.props.onHeld(on);
  held(true);
  mounted.rerender();
  t.mock.timers.tick(60_000);
  assert.equal(mounted.value.props.closing, false, "never closes while held");
  held(false);
  mounted.rerender();
  t.mock.timers.tick(19_000);
  assert.equal(mounted.value.props.closing, false);
  t.mock.timers.tick(1_000);
  assert.equal(mounted.value.props.closing, true, "closes a full hold after it was let go");
});

test("a one-button toast keeps its old timing and isn't held", (t) => {
  const mounted = shownToast(t, { action: { title: "Undo", run() {} } });
  assert.equal(mounted.value.props.onHeld, undefined);
  t.mock.timers.tick(TOAST_ACTION_MS);
  assert.equal(mounted.value.props.closing, true);
});

test("a toast never outgrows its card: in a 420 pt card both buttons keep their width and the title wraps, then truncates", () => {
  const card = 420;
  const width = toastWidth(card, true);
  assert.ok(width <= card - 2 * toastLayout.edge, `two-button toast fits a ${card} pt card (${width} pt)`);
  assert.equal(toastWidth(2000, true), toastLayout.twoActionMaxWidth, "a wide card still caps it");
  assert.equal(toastWidth(2000, false), toastLayout.maxWidth);
  assert.equal(toastWidth(null, true), toastLayout.twoActionMaxWidth, "before the card is measured");
  assert.equal(toastWidth(10, true), 0, "never negative");
  const source = readFileSync(new URL("./Toast.tsx", import.meta.url), "utf8");
  assert.match(source, /style=\{DOCK\} onLayout=\{\(e\) => setRoom\(e\.nativeEvent\.layout\.width\)\}/, "the toast measures the card it sits in");
  assert.match(source, /maxWidth: toastWidth\(room, !!secondary\)/);
  assert.match(source, /const ACTIONS = \{ flexDirection: "row", flexShrink: 0/, "the buttons never shrink");
  assert.match(source, /const TEXT = \{ flexShrink: 1 \}/, "the title gives way");
  assert.match(source, /numberOfLines=\{titleLines\}/, "a toast truncates only when it asks to");
  assert.doesNotMatch(source, /TITLE_LINES/, "no cap shared by every toast");
  assert.match(readFileSync(new URL("../split/SplitChrome.tsx", import.meta.url), "utf8"), /titleLines=\{shown\.titleLines\}/);
  assert.match(readFileSync(new URL("../../state/tabs/busyTabWatch.ts", import.meta.url), "utf8"), /titleLines: WARNING_TITLE_LINES/, "the busy-tab warning asks for two lines");
});
