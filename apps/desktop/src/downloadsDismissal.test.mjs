import assert from "node:assert/strict";
import test from "node:test";
import { startDownloadsDismissal } from "./downloadsDismissal.ts";

function harness({ typing = false, menu = false } = {}) {
  const target = new EventTarget();
  const bubble = { name: "bubble" };
  const pageWatchers = new Set();
  let clock = 0;
  const closes = [];
  const insidePresses = [];
  const stop = startDownloadsDismissal({
    target,
    inside: (node) => node === bubble,
    onInsidePress: () => insidePresses.push(clock),
    close: () => closes.push(clock),
    menuShown: () => menu,
    watchPageFocus: (listener) => {
      pageWatchers.add(listener);
      return () => pageWatchers.delete(listener);
    },
    activeElement: () => ({ matches: () => typing }),
    now: () => clock,
  });
  const fire = (type, on, extra = {}) => {
    const event = new Event(type, { cancelable: true, bubbles: true });
    Object.defineProperty(event, "target", { value: on });
    Object.assign(event, extra);
    let reached = false;
    const later = () => void (reached = true);
    target.addEventListener(type, later);
    target.dispatchEvent(event);
    target.removeEventListener(type, later);
    return { reached, prevented: event.defaultPrevented };
  };
  return { target, bubble, pageWatchers, closes, insidePresses, stop, fire, tick: (ms) => void (clock += ms) };
}

test("a press outside the bubble closes it and swallows that press, so the button under it doesn't reopen it", () => {
  const h = harness();
  const outside = { name: "sidebar button" };
  assert.equal(h.fire("pointerdown", outside).reached, false);
  assert.equal(h.closes.length, 1);
  assert.equal(h.insidePresses.length, 0);
  assert.equal(h.fire("mousedown", outside).reached, false);
  assert.equal(h.fire("pointerup", outside).reached, false);
  assert.equal(h.fire("click", outside).reached, false);
  assert.equal(h.fire("click", outside).reached, true, "only the closing press is swallowed");
  h.stop();
});

test("presses inside the bubble reach it and keep it open", () => {
  const h = harness();
  for (const type of ["pointerdown", "mousedown", "pointerup", "click"]) assert.equal(h.fire(type, h.bubble).reached, true);
  assert.equal(h.closes.length, 0);
  assert.equal(h.insidePresses.length, 1);
  h.stop();
});

test("a released press whose click never comes stops being swallowed after a moment", () => {
  const h = harness();
  h.fire("pointerdown", { name: "outside" });
  h.fire("pointerup", { name: "outside" });
  h.tick(1000);
  assert.equal(h.fire("click", { name: "elsewhere" }).reached, true);
  h.stop();
});

test("a closing press held past the moment is still swallowed when it is let go", () => {
  const h = harness();
  const outside = { name: "Clear All" };
  h.fire("pointerdown", outside);
  h.stop();
  h.tick(5000);
  for (const type of ["pointerup", "mouseup", "click"]) assert.equal(h.fire(type, outside).reached, false, type);
  assert.equal(h.fire("click", outside).reached, true, "a later click is left alone");
});

test("a closing right-click swallows its menu, and the next press is left alone though it never clicked", () => {
  const h = harness();
  const tab = { name: "a sidebar tab" };
  h.fire("pointerdown", tab, { button: 2 });
  h.stop();
  for (const type of ["mousedown", "contextmenu", "pointerup", "mouseup"]) assert.equal(h.fire(type, tab).reached, false, type);
  const control = { name: "another control" };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) assert.equal(h.fire(type, control).reached, true, `${type} of the next press`);
});

test("the page taking focus closes it, and stopping releases the page-focus watcher", () => {
  const h = harness();
  assert.equal(h.pageWatchers.size, 1);
  for (const listener of h.pageWatchers) listener();
  assert.equal(h.closes.length, 1);
  h.stop();
  assert.equal(h.pageWatchers.size, 0);
  assert.equal(h.fire("pointerdown", { name: "outside" }).reached, true, "a stopped dismissal leaves presses alone");
});

test("Escape closes it, but not while typing in a field or with a modifier", () => {
  const h = harness();
  assert.equal(h.fire("keydown", h.bubble, { key: "Escape" }).prevented, true);
  assert.equal(h.closes.length, 1);
  h.fire("keydown", h.bubble, { key: "Escape", ctrlKey: true });
  h.fire("keydown", h.bubble, { key: "a" });
  assert.equal(h.closes.length, 1);
  h.stop();
  const typing = harness({ typing: true });
  typing.fire("keydown", typing.bubble, { key: "Escape" });
  assert.equal(typing.closes.length, 0);
  typing.stop();
});

test("the closing press stays swallowed after the panel closes and its dismissal stops", () => {
  const h = harness();
  const outside = { name: "Clear All on the downloads page" };
  assert.equal(h.fire("pointerdown", outside).reached, false);
  h.stop();
  for (const type of ["mousedown", "pointerup", "mouseup", "click"]) assert.equal(h.fire(type, outside).reached, false, `${type} of the closing press`);
  assert.equal(h.fire("pointerdown", outside).reached, true, "the next press is left alone");
  assert.equal(h.fire("click", outside).reached, true);
});

test("while a menu is open, presses and Escape belong to the menu and leave the panel open", () => {
  const h = harness({ menu: true });
  const item = { name: "Open, in the row's menu" };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) assert.equal(h.fire(type, item).reached, true, type);
  assert.equal(h.fire("keydown", h.bubble, { key: "Escape" }).prevented, false);
  assert.equal(h.closes.length, 0);
  h.stop();
});

test("only the closing pointer's release starts the moment after which its press is let go", () => {
  const h = harness();
  const outside = { name: "Clear All" };
  h.fire("pointerdown", outside, { pointerId: 1 });
  h.stop();
  assert.equal(h.fire("pointerup", outside, { pointerId: 2 }).reached, false, "another pointer's release while the closing press is held");
  h.tick(5000);
  assert.equal(h.fire("pointerup", outside, { pointerId: 1 }).reached, false, "the closing pointer is still held, so its release is swallowed");
  h.tick(1000);
  assert.equal(h.fire("click", outside).reached, true, "the moment after the closing pointer's release has passed");
});

test("a right-click while the closing press is held doesn't let the held press through", () => {
  const h = harness();
  const outside = { name: "Clear All" };
  h.fire("pointerdown", outside, { pointerId: 1 });
  h.stop();
  for (const type of ["contextmenu", "auxclick"]) assert.equal(h.fire(type, outside).reached, false, `${type} of the chorded right button`);
  for (const type of ["pointerup", "mouseup", "click"]) assert.equal(h.fire(type, outside, { pointerId: 1 }).reached, false, `${type} of the closing press`);
  assert.equal(h.fire("click", outside).reached, true, "a later click is left alone");
});
