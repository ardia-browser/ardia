import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { switcherIcons, switcherCellWidth } from "./ProfileIcons.tsx";
import { useBrowser } from "../../state/browser/store.ts";
import { pagerFor } from "../../state/windows/profilePager.ts";

const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) =>
  id === "react-native/Libraries/Animated/useAnimatedProps" ? { default: (props) => [props, () => {}] } : nodeRequire(id);
const { ProfileDots } = await import("./ProfileDots.tsx");

const emojis = ["😀", "🐈", "🐕", "🌲", "🌻", "🌈", "🚀", "🎵", "🎨", "📚"];
const widthOf = (icons) => icons.reduce((width, icon) => width + switcherCellWidth(icon), 0);

test("overflow retains the active emoji with nine dots (#1949)", () => {
  for (let active = 0; active < emojis.length; active++) {
    const icons = switcherIcons(emojis, true, 180, active);
    assert.deepEqual(icons, emojis.map((icon, i) => i === active ? icon : null));
    assert.equal(widthOf(icons), 134);
  }
});

test("all-fit, disabled, symbols, no icon and compact width boundaries", () => {
  const icons = ["symbol:house.fill", "🚀", null];
  assert.deepEqual(switcherIcons(icons, true, 64, 1), icons);
  assert.deepEqual(switcherIcons(icons, false, 100, 1), [null, null, null]);
  assert.deepEqual(switcherIcons(icons, true, 63, 0), [icons[0], null, null]);
  assert.deepEqual(switcherIcons(icons, true, 50, 1), [null, icons[1], null]);
  assert.deepEqual(switcherIcons(icons, true, 49, 1), [null, null, null]);
  assert.deepEqual(switcherIcons(icons, true, 63, 2), [null, null, null]);
  assert.deepEqual(switcherIcons(icons, true, 63, -1), [null, null, null]);
  assert.deepEqual(switcherIcons([], true, 0, -1), []);
});

test("production row uses its window selection and available room beside Downloads", (t) => {
  const s = () => useBrowser.getState();
  const ids = emojis.map((_, i) => `profile-${i}`);
  s().hydrate({ profiles: Object.fromEntries(ids.map((id, i) => [id, { id, name: id, icon: emojis[i], color: "plum", createdAt: i }])), profileOrder: ids });
  s().updateSettings({ profileSwitcherIcons: true });
  const windowId = s().createWindow({ profileId: ids[0] });
  const row = mount((props) => ProfileDots({ windowId, ...props }), { props: { width: 280, besideDownloads: false } });
  t.after(() => row.unmount());
  const marks = () => row.value.props.children.props.children.map((child) => child.props);
  assert.deepEqual(marks().map((p) => p.icon), emojis);
  row.rerender({ width: 280, besideDownloads: true });
  assert.deepEqual(marks().map((p) => p.icon), [emojis[0], ...Array(9).fill(null)]);
  const pager = pagerFor(windowId);
  pager.pos.setValue(0.45);
  assert.equal(marks()[0].icon, emojis[0]);
  assert.ok(marks().every((p, i) => p.pos === pager.pos && p.page.slot === i));
  s().switchProfile(windowId, ids[9]);
  assert.deepEqual(marks().map((p) => p.icon), [...Array(9).fill(null), emojis[9]]);
  const otherWindow = s().createWindow({ profileId: ids[3] });
  s().setFocusedWindow(otherWindow);
  assert.equal(marks()[9].icon, emojis[9]);
  row.rerender({ width: 220, besideDownloads: true });
  assert.equal(widthOf(marks().map((p) => p.icon)), 134);
  row.rerender({ width: 219, besideDownloads: true });
  assert.ok(marks().every((p) => p.icon === null));
  row.rerender({ width: 280, besideDownloads: true });
  assert.equal(marks()[9].icon, emojis[9]);
  s().updateSettings({ profileSwitcherIcons: false });
  assert.ok(marks().every((p) => p.icon === null));
});
