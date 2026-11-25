import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mount } from "../../test-hooks.mjs";
const require = createRequire(import.meta.url);
const { renderToStaticMarkup } = require("react-dom/server");
const { pressables } = await import("react-native");
const { useBrowser } = await import("../../state/browser/store.ts");
const { dismissDownloadsByPress, setDownloadsOpen } = await import("../../state/windows/actions.ts");
const { DownloadsButton } = await import("./DownloadsButton.tsx");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const isOpen = (w) => !!S().windowUi[w]?.downloadsOpen;
const pressAt = (timestamp) => ({ nativeEvent: { timestamp } });

function oneWindow() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  setDownloadsOpen(w, false);
  return w;
}

function renderButton(windowId, t) {
  const mounted = mount(() => DownloadsButton({ windowId }));
  t.after(() => mounted.unmount());
  pressables.length = 0;
  renderToStaticMarkup(mounted.value.props.children);
  assert.equal(pressables.length, 1);
  return {
    ...pressables[0],
    capture(press) {
      assert.equal(mounted.value.props.onStartShouldSetResponderCapture?.(press) ?? false, false);
    },
  };
}

function start(button, timestamp) {
  button.capture(pressAt(timestamp));
  button.onPressIn?.(pressAt(timestamp));
}

function click(button, timestamp) {
  start(button, timestamp);
  button.onPressOut?.(pressAt(timestamp + 80));
  button.onPress?.(pressAt(timestamp + 80));
}

test("the Downloads button opens the panel at once after a click elsewhere closed it", (t) => {
  const w = oneWindow();
  const button = renderButton(w, t);
  click(button, 1000);
  assert.equal(isOpen(w), true);
  dismissDownloadsByPress(w, pressAt(2000));
  assert.equal(isOpen(w), false);
  click(button, 2150);
  assert.equal(isOpen(w), true, "a second, separate click opens it");
});

test("the press on the Downloads button that closed the open panel doesn't reopen it, even held", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const w = oneWindow();
  const button = renderButton(w, t);
  click(button, 1000);
  start(button, 3000);
  dismissDownloadsByPress(w, pressAt(3000));
  assert.equal(isOpen(w), false);
  t.mock.timers.tick(2000);
  button.onPressOut(pressAt(5000));
  button.onPress(pressAt(5000));
  assert.equal(isOpen(w), false, "its release 2 s later doesn't reopen it");
  click(button, 5400);
  assert.equal(isOpen(w), true, "the next click opens it");
});

test("leaving and re-entering the Downloads button keeps the original closing press", (t) => {
  const w = oneWindow();
  const button = renderButton(w, t);
  setDownloadsOpen(w, true);
  start(button, 3000);
  dismissDownloadsByPress(w, pressAt(3000));
  button.onPressOut(pressAt(3100));
  button.onPressIn(pressAt(3200));
  button.onPressOut(pressAt(3250));
  button.onPress(pressAt(3250));
  assert.equal(isOpen(w), false, "re-entry is part of the press that closed the panel");
  click(button, 3300);
  assert.equal(isOpen(w), true, "a new press opens it immediately");
});

test("a canceled press does not keep the following pointer or keyboard activation", (t) => {
  const w = oneWindow();
  const button = renderButton(w, t);
  for (const keyboard of [false, true]) {
    setDownloadsOpen(w, true);
    start(button, 4000);
    dismissDownloadsByPress(w, pressAt(4000));
    button.onPressOut(pressAt(4100));
    assert.equal(isOpen(w), false);
    if (keyboard) {
      const key = { nativeEvent: { key: "Enter", timestamp: 4200 } };
      button.onPressIn(key);
      button.onPress(key);
      button.onPressOut(key);
    } else click(button, 4200);
    assert.equal(isOpen(w), true, "a canceled pointer press cannot suppress a later activation");
  }
});
