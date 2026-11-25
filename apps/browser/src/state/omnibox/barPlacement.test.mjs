import assert from "node:assert/strict";
import { test } from "node:test";
const { keyBarPlacement, isCentred, commandKeyPlacement, addressFieldShown, clickBarPlacement, placementCard, placementFromCard, centredBarLeft } = await import("./barPlacement.ts");
const { openBarFromAddress, openEmptySidebarField } = await import("./barState.ts");
const { commandBarPlacementLabel } = await import("../telemetry/track.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { activeTabId } = await import("../browser/model.ts");
globalThis.fetch ??= async () => ({ status: 503 });

test("⌘L opens at the field when one is on screen, as a click does", () => {
  assert.equal(keyBarPlacement({ setting: "field", small: false, fieldShown: true }), "field");
});

test("⌘L falls back to the centre when no field is on screen", () => {
  assert.equal(keyBarPlacement({ setting: "field", small: false, fieldShown: false }), "centredNoField");
  assert.ok(isCentred("centredNoField"));
});

test("the In the centre setting still sends ⌘L to the centre", () => {
  assert.equal(keyBarPlacement({ setting: "centred", small: false, fieldShown: true }), "centred");
  assert.equal(keyBarPlacement({ setting: "centred", small: false, fieldShown: false }), "centred");
});

test("Little Ardia keeps its own dropdown", () => {
  assert.equal(keyBarPlacement({ setting: "centred", small: true, fieldShown: false }), "field");
});

const S = () => useBrowser.getState();
const pageWindow = (settings) => {
  S().hydrate({});
  S().updateSettings(settings);
  return S().createWindow({ url: "https://example.com/" });
};

test("with In the centre, a click on the address still opens at the field", () => {
  const w = pageWindow({ commandBarPlacement: "centred" });
  S().openPanel(w, "https://example.com/");
  assert.equal(S().windowUi[w].panel.placement, "field");
  assert.equal(commandBarPlacementLabel(S().windowUi[w].panel), "field");
});

test("In the centre, also on click sends a click on the address to the centre, as ⌘L, except in Little Ardia", () => {
  assert.equal(keyBarPlacement({ setting: "centredOnClick", small: false, fieldShown: true }), "centred");
  assert.equal(keyBarPlacement({ setting: "centredOnClick", small: true, fieldShown: true }), "field");
  let w = pageWindow({ commandBarPlacement: "centredOnClick" });
  assert.equal(commandKeyPlacement(S(), w), "centred");
  openBarFromAddress(w, "https://example.com/");
  assert.equal(S().windowUi[w].panel.placement, "centred");
  assert.equal(S().windowUi[w].panel.initialText, "https://example.com/");
  w = pageWindow({ commandBarPlacement: "centredOnClick", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false });
  openEmptySidebarField(w);
  assert.equal(S().windowUi[w].panel.placement, "centred");
  assert.equal(clickBarPlacement({ settings: { commandBarPlacement: "centredOnClick" }, windows: { little: { kind: "small" } } }, "little"), "field");
});

test("onboarding's two cards show In the centre for the click choice too, and picking it again keeps the click part", () => {
  assert.equal(placementCard("field"), "field");
  assert.equal(placementCard("centred"), "centred");
  assert.equal(placementCard("centredOnClick"), "centred");
  assert.equal(placementFromCard("centred", "centredOnClick"), "centredOnClick");
  assert.equal(placementFromCard("field", "centredOnClick"), "field");
  assert.equal(placementFromCard("centred", "field"), "centred");
  assert.equal(placementFromCard("centred", "centred"), "centred");
});

test("with At the address or In the centre, a click on the address opens at the field", () => {
  for (const commandBarPlacement of ["field", "centred"]) {
    const w = pageWindow({ commandBarPlacement });
    openBarFromAddress(w, "https://example.com/");
    assert.equal(S().windowUi[w].panel.placement, "field", commandBarPlacement);
  }
});

test("⌘L in each layout", () => {
  let w = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  assert.equal(commandKeyPlacement(S(), w), "field");
  w = pageWindow({ commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false });
  assert.equal(commandKeyPlacement(S(), w), "field");
  w = pageWindow({ commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: true });
  assert.equal(addressFieldShown(S(), w), false);
  assert.equal(commandKeyPlacement(S(), w), "centredNoField");
  w = pageWindow({ commandBarPlacement: "centred", addressBar: "toolbar" });
  assert.equal(commandKeyPlacement(S(), w), "centred");
});

test("⌘L on a page puts that presentation on the panel", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const w = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  runCommand({ command: "focusCommandBar", arg: null, windowId: w });
  assert.equal(S().windowUi[w].panel.open, true);
  assert.equal(S().windowUi[w].panel.placement, "field");
  assert.equal(S().windowUi[w].panel.initialText, "https://example.com/");
});

test("labels the presentation for telemetry", () => {
  assert.equal(commandBarPlacementLabel({ placement: "field" }), "field");
  assert.equal(commandBarPlacementLabel({}), "field");
  assert.equal(commandBarPlacementLabel({ placement: "centred" }), "centred");
  assert.equal(commandBarPlacementLabel({ placement: "centredNoField" }), "centred_no_field");
  assert.equal(commandBarPlacementLabel({ newTab: { kind: "list" }, placement: "field" }), "new_tab");
});

test("an unknown window has no field and ⌘L there goes to the centre", () => {
  const s = useBrowser.getState();
  assert.equal(addressFieldShown(s, "nope"), false);
  assert.equal(commandKeyPlacement(s, "nope"), "centredNoField");
});

test("the centred command bar centres on the window, as in Arc, and never leaves the page card", () => {
  const card = { left: 190, width: 1161 };
  assert.equal(centredBarLeft(card, 652, 1360), 354, "centred on the 1360 pt window, not on the card (444.5)");
  assert.equal(centredBarLeft({ left: 0, width: 1360 }, 652, 1360), 354, "the same spot with the sidebar hidden, so it doesn't jump");
  assert.equal(centredBarLeft({ left: 300, width: 500 }, 472, 800), 300, "a narrow card keeps the bar inside it");
  assert.equal(centredBarLeft({ left: 0, width: 900 }, 600, 1200), 300, "a right sidebar: the bar stays inside the card");
  assert.equal(centredBarLeft(card, 652, 0), 444.5, "no window width yet: the card's centre");
});

test("a second ⌘L closes the bar it opened over a page, in every layout and placement", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const layouts = [
    { commandBarPlacement: "field", addressBar: "toolbar" },
    { commandBarPlacement: "centred", addressBar: "toolbar" },
    { commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false },
    { commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: true },
  ];
  for (const settings of layouts) {
    const w = pageWindow(settings);
    runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
    assert.equal(S().windowUi[w].panel.open, true, JSON.stringify(settings));
    runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
    assert.equal(S().windowUi[w].panel.open, false, JSON.stringify(settings));
    runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
    assert.equal(S().windowUi[w].panel.open, true, JSON.stringify(settings));
  }
});

test("⌘L over ⌘T's bar on a page swaps it for the address bar instead of closing it", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const w = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  S().openPanel(w, "", { kind: "list" });
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
  assert.equal(S().windowUi[w].panel.open, true);
  assert.equal(S().windowUi[w].panel.newTab, undefined);
  assert.equal(S().windowUi[w].panel.initialText, "https://example.com/");
});

const focusLog = (ids) => {
  const focused = [];
  for (const id of ids) webviews.set(id, { focus: async () => void focused.push(id), focusIfUnfocused: async () => (focused.push(id), true) });
  return focused;
};

test("the second ⌘L gives the keyboard back to the page, in a main window and in Little Ardia", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  for (const kind of ["main", "small"]) {
    S().hydrate({});
    S().updateSettings({ commandBarPlacement: "field", addressBar: "toolbar" });
    const w = S().createWindow(kind === "small" ? { kind: "small", url: "https://example.com/" } : { url: "https://example.com/" });
    const page = activeTabId(S(), w);
    const focused = focusLog([page]);
    runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
    assert.equal(S().windowUi[w].panel.open, true, kind);
    assert.deepEqual(focused, [], `${kind}: opening the bar leaves the page alone`);
    runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
    assert.equal(S().windowUi[w].panel.open, false, kind);
    assert.deepEqual(focused, [page], `${kind}: the page has the keyboard again`);
  }
});

test("on a blank New Tab page with the address in the sidebar, and in a blank Little Ardia, the second ⌘L closes the bar too", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  S().hydrate({});
  S().updateSettings({ commandBarPlacement: "field", addressBar: "sidebar", tabLayout: "sidebar", autoHideTabs: false, newTabOpens: "page" });
  const w = S().createWindow({});
  const blank = activeTabId(S(), w);
  assert.equal(S().tabs[blank].url, "");
  const focused = focusLog([blank]);
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
  assert.equal(S().windowUi[w].panel.open, true, "the first ⌘L opens the sidebar dropdown");
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
  assert.equal(S().windowUi[w].panel.open, false, "the second closes it");
  assert.deepEqual(focused, [], "a blank tab has no page to hand the keyboard to");
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
  assert.equal(S().windowUi[w].panel.open, true, "and the third opens it again");

  S().hydrate({});
  const little = S().createWindow({ kind: "small" });
  runCommand({ command: "focusCommandBar", arg: null, windowId: little }, { user: { consent: null } });
  assert.equal(S().windowUi[little].panel.open, true);
  runCommand({ command: "focusCommandBar", arg: null, windowId: little }, { user: { consent: null } });
  assert.equal(S().windowUi[little].panel.open, false, "a blank Little Ardia closes its bar instead of reopening it");
  assert.ok(S().windows[little], "and keeps its window");
});

test("each ⌘L dismissal is counted once, under the consent of the key press", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const client = await import("../telemetry/client.ts");
  const { takeInlineCompletionCounts } = await import("../telemetry/inlineCompletionCounts.ts");
  client.loadChoice();
  client.setSharing(true, "onboarding");
  takeInlineCompletionCounts();
  const w = pageWindow({ commandBarPlacement: "field", addressBar: "toolbar" });
  const user = { consent: client.consentToken() };
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user });
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user });
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user });
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, { user: { consent: null } });
  assert.equal(takeInlineCompletionCounts().command_bar_key_dismissals, 1, "an open is not a dismissal, and a press without consent isn't counted");
  client.setSharing(false, "settings");
});

test("automation's Open Command Bar opens and focuses the bar every time and never closes it", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const { runMethod } = await import("../automation/controlSocket.ts");
  for (const kind of ["main", "small"]) {
    S().hydrate({});
    S().updateSettings({ commandBarPlacement: "field", addressBar: "toolbar" });
    const w = S().createWindow(kind === "small" ? { kind: "small", url: "https://example.com/" } : { url: "https://example.com/" });
    runCommand({ command: "focusCommandBar", arg: null, windowId: w });
    runCommand({ command: "focusCommandBar", arg: null, windowId: w });
    assert.equal(S().windowUi[w].panel.open, true, `${kind}: a launch action or script run twice keeps the bar open`);
  }
  S().hydrate({});
  const w = S().createWindow({ url: "https://example.com/" });
  for (const n of [1, 2]) {
    const body = runMethod({ command: "focusCommandBar", windowId: w }, false);
    assert.deepEqual(body, { result: { ok: true } }, JSON.stringify(body));
    assert.equal(S().windowUi[w].panel.open, true, `the control socket's run, call ${n}`);
  }
});

test("in a blank window with New tab opens set to the command bar, ⌘L opens the new-tab bar and the next ⌘L closes it, while ⌘T's bar keeps its handoff", async () => {
  const { runCommand } = await import("../commands/commands.ts");
  const user = { user: { consent: null } };
  S().hydrate({});
  S().updateSettings({ newTabOpens: "commandBar", commandBarPlacement: "field", addressBar: "toolbar" });
  const w = S().createWindow({});
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, user);
  assert.equal(S().windowUi[w].panel.open, true);
  assert.ok(S().windowUi[w].panel.newTab, "⌘L in a blank window shows the new-tab bar");
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, user);
  assert.equal(S().windowUi[w].panel.open, false, "the second ⌘L closes it");
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, user);
  assert.equal(S().windowUi[w].panel.open, true, "the third opens it again");
  runCommand({ command: "focusCommandBar", arg: null, windowId: w });
  assert.equal(S().windowUi[w].panel.open, true, "automation never closes it");
  S().closePanel(w);
  runCommand({ command: "newTab", arg: null, windowId: w }, user);
  assert.ok(S().windowUi[w].panel.newTab, "⌘T shows its bar");
  const opened = S().windowUi[w].panel;
  runCommand({ command: "focusCommandBar", arg: null, windowId: w }, user);
  assert.equal(S().windowUi[w].panel.open, true, "⌘L over ⌘T's bar hands off instead of closing it");
  assert.notEqual(S().windowUi[w].panel, opened);
});
