import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
globalThis.require ??= (id) => ({ asset: id });
const { View } = await import("react-native");
const { PreviewFade, useSplitPreview } = await import("./SplitPreview.tsx");

const contentType = (preview) => PreviewFade({ preview, children: null }).type;

test("a row that never arms a split preview keeps its content in a plain View, so launch mounts no Animated wrapper per row", (t) => {
  const row = mount(({ side }) => useSplitPreview(side, 1), { props: { side: null } });
  t.after(() => row.unmount());
  assert.equal(row.value.fades, false);
  assert.equal(row.value.values, null);
  assert.equal(contentType(row.value), View);
});

test("once a row arms a split preview its content fades and keeps the animated wrapper, so it never remounts mid-drag", (t) => {
  const row = mount(({ side }) => useSplitPreview(side, 1), { props: { side: null } });
  t.after(() => row.unmount());
  row.rerender({ side: "left" });
  assert.equal(row.value.fades, true);
  assert.ok(row.value.values, "the armed row has preview values to fade with");
  assert.notEqual(contentType(row.value), View);
  row.rerender({ side: null });
  assert.equal(row.value.fades, true, "disarming keeps the wrapper instead of remounting the row's content");
  assert.notEqual(contentType(row.value), View);
});

test("a split already at the pane limit never previews, so it keeps the plain View", (t) => {
  const row = mount(({ side }) => useSplitPreview(side, 99), { props: { side: "right" } });
  t.after(() => row.unmount());
  assert.equal(row.value.fades, false);
  assert.equal(contentType(row.value), View);
});
