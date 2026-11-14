import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const React = require("react");
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

function renderButton(windowId) {
  pressables.length = 0;
  renderToStaticMarkup(React.createElement(DownloadsButton, { windowId }));
  assert.equal(pressables.length, 1);
  return pressables[0];
}

function click(button, timestamp) {
  button.onPressIn?.(pressAt(timestamp));
  button.onPressOut?.(pressAt(timestamp + 80));
  button.onPress?.(pressAt(timestamp + 80));
}

test("the Downloads button opens the panel at once after a click elsewhere closed it", () => {
  const w = oneWindow();
  const button = renderButton(w);
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
  const button = renderButton(w);
  click(button, 1000);
  button.onPressIn(pressAt(3000));
  dismissDownloadsByPress(w, pressAt(3000));
  assert.equal(isOpen(w), false);
  t.mock.timers.tick(2000);
  button.onPressOut(pressAt(5000));
  button.onPress(pressAt(5000));
  assert.equal(isOpen(w), false, "its release 2 s later doesn't reopen it");
  click(button, 5400);
  assert.equal(isOpen(w), true, "the next click opens it");
});
