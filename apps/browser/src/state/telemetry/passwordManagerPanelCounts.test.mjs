import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
await import("../../test-native/index.ts");
const { notePasswordPanel, takePasswordManagerCounts } = await import("./passwordManagerCounts.ts");

const panelCounts = (counts) => Object.fromEntries(Object.entries(counts).filter(([field, n]) => field.startsWith("password_manager_panel_") && n));

test("a refused panel counts under its opener and under its reason, an opened one only under its opener", () => {
  takePasswordManagerCounts();
  notePasswordPanel("badge", true);
  notePasswordPanel("badge", false, "noPanel");
  notePasswordPanel("menu", false, "notFocused");
  notePasswordPanel("menu", false, "notFocused");
  notePasswordPanel("badge", false);
  assert.deepEqual(panelCounts(takePasswordManagerCounts()), {
    password_manager_panel_opens_badge: 1,
    password_manager_panel_refused_badge: 2,
    password_manager_panel_refused_menu: 2,
    password_manager_panel_refusal_no_panel: 1,
    password_manager_panel_refusal_not_focused: 2,
  });
});

test("every refusal reason has its own field, sent as zero when nothing happened", () => {
  const fields = Object.keys(takePasswordManagerCounts()).filter((field) => field.startsWith("password_manager_panel_refusal_"));
  assert.deepEqual(fields.sort(), [
    "password_manager_panel_refusal_hidden",
    "password_manager_panel_refusal_no_panel",
    "password_manager_panel_refusal_not_editing",
    "password_manager_panel_refusal_not_focused",
    "password_manager_panel_refusal_not_key",
    "password_manager_panel_refusal_refused",
    "password_manager_panel_refusal_throttled",
    "password_manager_panel_refusal_unavailable",
  ]);
});
