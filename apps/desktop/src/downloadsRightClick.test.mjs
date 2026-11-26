import assert from "node:assert/strict";
import test from "node:test";
import { startDownloadsDismissal } from "./downloadsDismissal.ts";
import { pressOpensDownloadsMenu } from "./downloadsButtonPress.ts";
import { watchOutsidePresses } from "./outsidePress.ts";

const element = (testId) => ({ closest: (selector) => (testId && selector === `[data-testid="${testId}"]` ? {} : null) });

function openPanel() {
  const target = new EventTarget();
  const panel = element(null);
  const closes = [];
  let open = true;
  const close = (by) => () => {
    if (!open) return;
    open = false;
    closes.push(by);
  };
  const stopDismissal = startDownloadsDismissal({
    target,
    inside: (node) => node === panel,
    onInsidePress: () => {},
    close: close("window capture"),
    menuShown: () => false,
    opensItsOwnMenu: pressOpensDownloadsMenu,
    watchPageFocus: () => () => {},
    activeElement: () => null,
    now: () => 0,
  });
  const stopOutside = watchOutsidePresses({
    target,
    inside: (node) => node === panel,
    menuShown: () => false,
    ignorePress: pressOpensDownloadsMenu,
    onOutsidePress: close("outside press area"),
  });
  const press = (type, on, button) => {
    const event = new Event(type, { cancelable: true, bubbles: true });
    Object.defineProperty(event, "target", { value: on });
    Object.assign(event, { button, pointerId: 1 });
    let reached = false;
    const handler = () => void (reached = true);
    target.addEventListener(type, handler);
    target.dispatchEvent(event);
    target.removeEventListener(type, handler);
    return reached;
  };
  return { press, closes, isOpen: () => open, stop: () => (stopDismissal(), stopOutside()) };
}

test("a right-click on the Downloads button keeps its panel open through both outside-press listeners and reaches the button's menu (#1199)", () => {
  const button = element("ardia-downloads-button");
  const h = openPanel();
  assert.equal(h.press("pointerdown", button, 2), true);
  assert.equal(h.isOpen(), true, `closed by ${h.closes.join(", ")}`);
  assert.equal(h.press("mousedown", button, 2), true);
  assert.equal(h.press("contextmenu", button, 2), true, "the button's menu handler gets the right-click");
  assert.equal(h.isOpen(), true);
  h.stop();
});

test("a left press on the Downloads button and a right-click elsewhere still close the panel", () => {
  const button = element("ardia-downloads-button");
  const left = openPanel();
  assert.equal(left.press("pointerdown", button, 0), false);
  assert.equal(left.isOpen(), false);
  left.stop();
  const elsewhere = openPanel();
  elsewhere.press("pointerdown", element("ardia-sidebar"), 2);
  assert.equal(elsewhere.isOpen(), false);
  elsewhere.stop();
});

test("only a secondary press on the Downloads button or something inside it opens the button's menu", () => {
  const button = element("ardia-downloads-button");
  assert.equal(pressOpensDownloadsMenu({ target: button, button: 2 }), true);
  assert.equal(pressOpensDownloadsMenu({ target: button, button: 0 }), false);
  assert.equal(pressOpensDownloadsMenu({ target: element("ardia-sidebar"), button: 2 }), false);
  assert.equal(pressOpensDownloadsMenu({ target: null, button: 2 }), false);
});

test("another outside-press panel (such as a sidebar folder) still dismisses on a right-click on the Downloads button", () => {
  const target = new EventTarget();
  const folder = element("ardia-folder-panel");
  let dismissed = 0;
  const stop = watchOutsidePresses({
    target,
    inside: (node) => node === folder,
    menuShown: () => false,
    onOutsidePress: () => void (dismissed += 1),
  });
  const event = new Event("pointerdown", { cancelable: true, bubbles: true });
  Object.defineProperty(event, "target", { value: element("ardia-downloads-button") });
  Object.assign(event, { button: 2, pointerId: 1 });
  target.dispatchEvent(event);
  assert.equal(dismissed, 1);
  stop();
});
