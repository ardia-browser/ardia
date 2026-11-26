import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { useBrowser } = await import("../../state/browser/store.ts");
const { openTileLetters } = await import("../../state/pins/tileLetters.ts");
const { useSidebarUi } = await import("../../state/sidebar/sidebarUi.ts");
const { TileLettersPanel, lettersHint } = await import("./TileLetters.tsx");

const S = () => useBrowser.getState();

function walk(node, keep, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, keep, out);
    return out;
  }
  if (keep(node)) out.push(node);
  walk(node.props?.children, keep, out);
  return out;
}

async function openPanel(t) {
  S().hydrate({});
  const w = S().createWindow({ url: "https://mail.example/" });
  const id = S().windows[w].tabIds[0];
  S().pinTabs([id], true);
  await openTileLetters(w, id);
  const target = useSidebarUi.getState().tileLetters;
  const panel = mount((props) => TileLettersPanel(props), { props: { target } });
  t.after(() => panel.unmount());
  walk(panel.value, (n) => typeof n.props?.onLayout === "function" && n.props.accessibilityLabel === "Cancel")[0].props.onLayout({ nativeEvent: { layout: { width: 800, height: 600 } } });
  const field = () => walk(panel.value, (n) => typeof n.props?.onChangeText === "function")[0];
  const done = () => walk(panel.value, (n) => n.props?.title === "Done")[0];
  return { id, field, done };
}

test("the letters field keeps IME composition as typed, and Done saves the composed letter (#3609)", async (t) => {
  const { id, field, done } = await openPanel(t);
  for (const step of ["n", "ni", "nih", "niha", "nihao", "你"]) {
    field().props.onChangeText(step);
    assert.equal(field().props.value, step, `composition step ${step} is left alone`);
  }
  done().props.onPress();
  assert.equal(S().tabs[id].tileLetters, "你");
});

test("the field keeps whatever is typed; the hint shows what the tile will show, and Done saves only that", async (t) => {
  const { id, field, done } = await openPanel(t);
  field().props.onChangeText("abc");
  assert.equal(field().props.value, "abc", "no truncation while typing");
  assert.equal(lettersHint("abc", "M"), "The tile shows “AB”.");
  assert.match(lettersHint("", "M"), /“M”/);
  done().props.onPress();
  assert.equal(S().tabs[id].tileLetters, "AB");
});
