import assert from "node:assert/strict";
import test from "node:test";
import { heldModifiers } from "./clickModifiers.ts";
import { alternateShown, claimMenuEscape, hasSymbolColumn, menuButtonPresses, menuShown, menuSwatch, pickMenuItem, shownMenu, showMenu } from "./menus.tsx";
import { notingPageFocus } from "./pageFocus.ts";
import { linuxShellMethod } from "./shellMethods.ts";

const pageTakesFocus = () => notingPageFocus({}).onPageFocus();

test("a page taking focus closes an open menu with no choice, and stops listening once it is closed", async () => {
  const items = [{ id: "copy", title: "Copy Link" }];
  const first = showMenu(items, undefined, { x: 10, y: 10 });
  assert.equal(menuShown(), true);
  pageTakesFocus();
  assert.equal(await first, null);
  assert.equal(menuShown(), false);
  const second = showMenu(items, undefined, { x: 10, y: 10 });
  const replaced = showMenu(items, undefined, { x: 20, y: 20 });
  assert.equal(await second, null);
  assert.equal(menuShown(), true);
  pageTakesFocus();
  assert.equal(await replaced, null);
  assert.equal(menuShown(), false);
  pageTakesFocus();
  assert.equal(menuShown(), false);
});

test("an alternate menu item shows while Alt, Linux's Option, is held, and a Command alternate while Ctrl is", () => {
  const keys = (e) => heldModifiers({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...e });
  const copy = { id: "copy", title: "Copy 3 Links", modifiers: [] };
  const markdown = { id: "copyMd", title: "Copy 3 Links as Markdown", modifiers: ["option"], alternate: true };
  assert.equal(alternateShown(copy, markdown, keys({})), false);
  assert.equal(alternateShown(copy, markdown, keys({ altKey: true })), true);
  assert.equal(alternateShown(copy, markdown, keys({ ctrlKey: true })), false);
  const keyed = { id: "copy", title: "Copy Link", key: "c", modifiers: ["command", "shift"] };
  const keyedMarkdown = { id: "copyMd", title: "Copy Link as Markdown", key: "c", modifiers: ["command", "shift", "option"], alternate: true };
  assert.equal(alternateShown(keyed, keyedMarkdown, keys({ altKey: true })), true);
  assert.equal(alternateShown(keyed, keyedMarkdown, keys({ ctrlKey: true, shiftKey: true })), false);
  const profile = { id: "work", title: "Work", key: "2", modifiers: ["control"] };
  const profileWindow = { id: "workWindow", title: "Work ↗", modifiers: ["command"], alternate: true };
  assert.equal(alternateShown(profile, profileWindow, keys({ ctrlKey: true })), true);
  assert.equal(alternateShown(profile, profileWindow, keys({ altKey: true })), false);
});

test("the app menu button toggles its menu from the keyboard as it does from the pointer", async () => {
  const items = [{ id: "copy", title: "Copy Link" }];
  let opened = 0;
  const presses = menuButtonPresses(() => { opened++; void showMenu(items, undefined, { x: 0, y: 0 }); });
  presses.click();
  assert.equal(opened, 1);
  assert.equal(menuShown(), true);
  presses.click();
  assert.equal(opened, 1, "Enter or Space on the button closes the open menu instead of opening it again");
  assert.equal(menuShown(), false);
  presses.click();
  assert.equal(opened, 2);
  presses.pointerDown();
  pageTakesFocus();
  presses.click();
  assert.equal(opened, 2, "a click whose press closed the menu doesn't reopen it");
  assert.equal(menuShown(), false);
  presses.pointerDown();
  presses.click();
  assert.equal(opened, 3);
  pageTakesFocus();
});

test("a menu keeps a symbol column as soon as one of its rows has a symbol, so rows without one line up", () => {
  assert.equal(hasSymbolColumn([{ id: "newTab", title: "New Tab in Group", symbol: "plus.app" }, { id: "nest", title: "New Nested Group" }]), true);
  assert.equal(hasSymbolColumn([{ id: "a", title: "A" }, { separator: true }, { id: "b", title: "B" }]), false);
  assert.equal(hasSymbolColumn([]), false);
});

test("a keep-open row redraws the menu from main's callback and keeps it open, and any other row closes it with that choice", async () => {
  const repos = (shown) => [{ id: "repos", title: "Repositories", children: [{ id: "repo:a", title: "a", checked: shown, keepOpen: true }] }, { id: "refresh", title: "Refresh" }];
  const picked = [];
  const choice = showMenu(repos(true), (id) => { picked.push(id); return repos(false); });
  let settled = false;
  void choice.then(() => { settled = true; });
  pickMenuItem("repo:a", true);
  await new Promise(setImmediate);
  assert.deepEqual(picked, ["repo:a"]);
  assert.equal(menuShown(), true);
  assert.equal(settled, false);
  assert.deepEqual(shownMenu().items, repos(false));
  pickMenuItem("refresh");
  assert.equal(await choice, "refresh");
  assert.equal(menuShown(), false);
  assert.deepEqual(picked, ["repo:a"]);
});

test("a keep-open row in a menu opened without main's callback closes it with that choice", async () => {
  const choice = showMenu([{ id: "repo:a", title: "a", keepOpen: true }], undefined, { x: 0, y: 0 });
  pickMenuItem("repo:a", true);
  assert.equal(await choice, "repo:a");
  assert.equal(menuShown(), false);
});

test("showMenu takes the anchor point as its second argument as well as after main's callback", async () => {
  const items = [{ id: "copy", title: "Copy Link" }];
  const atPoint = showMenu(items, { x: 30, y: 40 });
  assert.deepEqual([shownMenu().x, shownMenu().y], [30, 40]);
  pickMenuItem("copy", true);
  assert.equal(await atPoint, "copy");
  const withCallback = showMenu(items, () => items, { x: 50, y: 60 });
  assert.deepEqual([shownMenu().x, shownMenu().y], [50, 60]);
  pageTakesFocus();
  assert.equal(await withCallback, null);
});

test("Linux lists no captured page menus and has no menu bar catalog, so the control socket's menu methods answer truthfully", async () => {
  assert.deepEqual(await linuxShellMethod("openSurfaces")(), []);
  assert.equal(await linuxShellMethod("capturePageMenus")(true), undefined);
  for (const [method, args] of [["menuBar", []], ["performMenuBarItem", ["cmd:newTab", "main"]], ["dismissSurface", ["m1"]]]) {
    await assert.rejects(linuxShellMethod(method)(...args), (error) => error.code === "ERR_UNAVAILABLE", method);
  }
});

test("an open menu takes Escape in the capture phase, so the field under it (an empty split pane's search) never sees it", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./menus.tsx", import.meta.url), "utf8");
  assert.match(source, /window\.addEventListener\("keydown", key, true\)/, "the menu listens on the window before any target");
  const press = (key) => {
    const seen = { prevented: false, stopped: false, closed: 0 };
    const event = { key, preventDefault: () => (seen.prevented = true), stopPropagation: () => (seen.stopped = true), stopImmediatePropagation: () => (seen.stopped = true) };
    const claimed = claimMenuEscape(event, () => seen.closed++);
    const fieldSawIt = !seen.stopped;
    return { claimed, fieldSawIt, ...seen };
  };
  assert.deepEqual(press("Escape"), { claimed: true, fieldSawIt: false, prevented: true, stopped: true, closed: 1 });
  assert.deepEqual(press("a"), { claimed: false, fieldSawIt: true, prevented: false, stopped: false, closed: 0 });
});

test("a tab group's Color menu draws each colour's swatch as the Mac does: the dark one in a dark menu, a ring for None, in the icon column", async () => {
  const { groupColorItems } = await import("../../browser/src/state/sidebar/groupMenu.ts");
  const items = groupColorItems(null, "#d14836").map(({ value, ...item }) => ("separator" in item ? item : { ...item, id: JSON.stringify(value) }));
  assert.equal(hasSymbolColumn(items), true, "swatch rows keep the icon column, so every title lines up");
  const named = (title) => items.find((i) => i.title === title);
  assert.deepEqual(menuSwatch(named("None"), false), { fill: null });
  assert.deepEqual(menuSwatch(named("Neutral"), false), { fill: "#0000004D" });
  assert.deepEqual(menuSwatch(named("Neutral"), true), { fill: "#FFFFFF4D" });
  for (const item of items.filter((i) => !("separator" in i) && !["None", "Neutral", "Match Site Color"].includes(i.title))) {
    assert.match(menuSwatch(item, true)?.fill ?? "", /^#[0-9a-f]{6}$/i, item.title);
  }
  assert.equal(menuSwatch({ id: "copy", title: "Copy Link" }, false), null);
  assert.equal(menuSwatch({ separator: true }, false), null);
});

test("in a forced-colours (high contrast) theme every swatch keeps a solid CanvasText edge, so None's ring doesn't vanish with its box-shadow", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("./base.css", import.meta.url), "utf8");
  const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
  assert.ok(forced.length < css.length, "no forced-colors block");
  const rule = (selector) => forced.match(new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  assert.match(rule(".ardia-menu-swatch"), /border:\s*1px solid CanvasText/);
  assert.match(rule(".ardia-menu-swatch"), /forced-color-adjust:\s*none/, "the colour discs keep their colours");
  assert.match(rule(".ardia-menu-swatch.empty"), /opacity:\s*1/, "None's ring is drawn at full strength");
  assert.match(rule(".ardia-menu-swatch.empty"), /box-shadow:\s*none/, "None drops its inset shadow so forced-colors draws a single ring");
});
