import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const { findNodeHandle } = await import("react-native");
const { Dialog } = await import("./Dialog.tsx");
const { DialogFocusContext, useDialogButton } = await import("./dialogFocus.ts");

const contentOf = (surface) => surface.value.props.children[1].props.children;

test("Tab on the dialog is kept from the platform, Tab in a text field is not", () => {
  const surface = mount(() => Dialog({ width: "m", onSubmit() {}, onDismiss() {}, children: "body" }));
  const content = contentOf(surface);
  const keys = mount(() => content.type(content.props));
  const press = (target, shiftKey) => {
    let prevented = 0;
    keys.value.props.onKeyDown({ nativeEvent: { key: "Tab", shiftKey, target }, preventDefault: () => prevented++ });
    return prevented;
  };
  try {
    const dialogItself = findNodeHandle(null);
    assert.equal(press(dialogItself, false), 1);
    assert.equal(press(dialogItself, true), 1);
    assert.equal(press(999, false), 0);
  } finally {
    keys.unmount();
    surface.unmount();
  }
});

test("a dialog without onSubmit keeps its buttons out of an outer dialog's Tab cycle", () => {
  const surface = mount(() => Dialog({ width: "m", onDismiss() {}, children: "body" }));
  try {
    const content = contentOf(surface);
    assert.equal(content.type, DialogFocusContext.Provider);
    assert.equal(content.props.value, null);
  } finally {
    surface.unmount();
  }
});

test("a button registers with its dialog, is skipped while disabled, and leaves on unmount", () => {
  const registered = [];
  const register = (button) => {
    registered.push(button);
    return () => registered.splice(registered.indexOf(button), 1);
  };
  const view = { current: { tag: 11 } };
  const h = mount((props) => useDialogButton(view, props.disabled), { props: { disabled: false }, contexts: [[DialogFocusContext, register]] });
  assert.equal(registered.length, 1);
  assert.equal(registered[0](), view.current);
  h.rerender({ disabled: true });
  assert.equal(registered.length, 1);
  assert.equal(registered[0](), null);
  h.unmount();
  assert.equal(registered.length, 0);
});
