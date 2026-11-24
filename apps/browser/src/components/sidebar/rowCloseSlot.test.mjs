import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { mount } from "../../test-hooks.mjs";
const { View } = await import("react-native");
const { useBrowser } = await import("../../state/browser/store.ts");
const { rowHoverCell } = await import("./hoverController.ts");
const { RowCloseSlot } = await import("./RowHoverParts.tsx");
const { RowCloseButton } = await import("./RowCloseButton.tsx");
const { iconButton } = await import("../ui/tokens.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };
const SPINNER = createElement(View, { testID: "spinner" });

function hoveredRow() {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  S().setFocusedWindow(w);
  const tabId = S().newTab(w, { url: "https://b.example/", background: true });
  const cell = rowHoverCell(w);
  cell.set(true);
  return { w, tabId, cell };
}

function closeButtonPath(node, path = []) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = closeButtonPath(node[i], [...path, i]);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const here = [...path, `${typeof node.type === "string" ? node.type : node.type?.displayName ?? node.type?.name ?? String(node.type)}#${node.key ?? ""}`];
  if (node.type === RowCloseButton) return { path: here.join(" > "), button: node };
  return closeButtonPath(node.props?.children, here);
}

function closeButtonAt(tree) {
  const found = closeButtonPath(tree);
  assert.ok(found, "a hovered row shows its close button");
  return found;
}

test("a spinner or unread count coming or going under the pointer keeps the same close button mounted, and its press still closes the tab", (t) => {
  const { tabId, cell } = hoveredRow();
  const slot = mount((props) => RowCloseSlot.type(props), { props: { cell, tabId, renaming: false, children: null } });
  t.after(() => slot.unmount());

  const plain = closeButtonAt(slot.value);
  const pressedBefore = plain.button.props.onPress;
  const withStatus = closeButtonAt(slot.rerender({ cell, tabId, renaming: false, children: SPINNER }));
  const plainAgain = closeButtonAt(slot.rerender({ cell, tabId, renaming: false, children: null }));

  for (const now of [withStatus, plainAgain]) assert.equal(now.path, plain.path, "the close button keeps its type, key and place under the same parents, so React keeps the same instance");

  pressedBefore({ nativeEvent: {} });
  assert.equal(S().tabs[tabId], undefined, "the press that began before the status changed closes the tab");
});

test("over a status the slot keeps the status's width, hides it under the button, and gives it back when the pointer leaves", (t) => {
  const { tabId, cell } = hoveredRow();
  const slot = mount((props) => RowCloseSlot.type(props), { props: { cell, tabId, renaming: false, children: SPINNER } });
  t.after(() => slot.unmount());
  const [frame, button] = slot.value.props.children;
  assert.deepEqual(button.props.style, { marginLeft: -iconButton.s.box }, "over a status the button covers the slot's trailing box");
  assert.equal(frame.props.style.minWidth, iconButton.s.box, "the slot is at least as wide as the close button");
  assert.equal(frame.props.children.props.style.opacity, 0);
  assert.equal(frame.props.children.props.pointerEvents, "none");

  cell.set(false);
  const [rest, gone] = slot.rerender().props.children;
  assert.equal(gone, null);
  assert.equal(rest.props.style.minWidth, undefined);
  assert.equal(rest.props.children.props.style.opacity, undefined);
  assert.equal(rest.props.children.props.pointerEvents, "box-none");
});
