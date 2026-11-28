import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
import { switcherIcons, switcherCellWidth } from "./ProfileIcons.tsx";
import { useBrowser } from "../../state/browser/store.ts";
import { markDrag, noDragMarks } from "../../state/sidebar/dragMarks.ts";
import { pagerFor } from "../../state/windows/profilePager.ts";

const nodeRequire = createRequire(import.meta.url);
globalThis.require = (id) =>
  id === "react-native/Libraries/Animated/useAnimatedProps" ? { default: (props) => [props, () => {}] } : nodeRequire(id);
const { ProfileDots } = await import("./ProfileDots.tsx");

const emojis = ["😀", "🐈", "🐕", "🌲", "🌻", "🌈", "🚀", "🎵", "🎨", "📚"];
const widthOf = (icons) => icons.reduce((width, icon) => width + switcherCellWidth(icon), 0);

test("overflow retains the active emoji with nine dots (#1949)", () => {
  for (let active = 0; active < emojis.length; active++) {
    const icons = switcherIcons(emojis, 180, active);
    assert.deepEqual(icons, emojis.map((icon, i) => i === active ? icon : null));
    assert.equal(widthOf(icons), 134);
  }
});

test("all-fit, disabled, symbols, no icon and compact width boundaries", () => {
  const icons = ["symbol:house.fill", "🚀", null];
  assert.deepEqual(switcherIcons(icons, 64, 1), icons);
  assert.deepEqual(switcherIcons([null, null, null], 100, 1), [null, null, null]);
  assert.deepEqual(switcherIcons(icons, 63, 0), [icons[0], null, null]);
  assert.deepEqual(switcherIcons(icons, 50, 1), [null, icons[1], null]);
  assert.deepEqual(switcherIcons(icons, 49, 1), [null, null, null]);
  assert.deepEqual(switcherIcons(icons, 63, 2), [null, null, null]);
  assert.deepEqual(switcherIcons(icons, 63, -1), [null, null, null]);
  assert.deepEqual(switcherIcons([], 0, -1), []);
});

test("production row uses its window selection and available room beside Downloads", (t) => {
  const s = () => useBrowser.getState();
  const ids = emojis.map((_, i) => `profile-${i}`);
  s().hydrate({ profiles: Object.fromEntries(ids.map((id, i) => [id, { id, name: id, icon: emojis[i], color: "plum", createdAt: i }])), profileOrder: ids });
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
  for (const id of ids) s().updateProfile(id, { switcherDot: true });
  assert.ok(marks().every((p) => p.icon === null));
});

for (const [width, startBesideDownloads, endBesideDownloads] of [[220, true, true], [219, false, true], [190, true, false]]) {
  test(`hover-switch keeps compact targets fixed (Downloads: ${startBesideDownloads} → ${endBesideDownloads})`, (t) => {
    const s = () => useBrowser.getState();
    const ids = emojis.map((_, i) => `drag-profile-${i}`);
    const target = 4;
    s().hydrate({ profiles: Object.fromEntries(ids.map((id, i) => [id, { id, name: id, icon: i === target && startBesideDownloads === endBesideDownloads ? null : emojis[i], color: "plum", createdAt: i }])), profileOrder: ids });
    const windowId = s().createWindow({ profileId: ids[0] });
    const row = mount((besideDownloads) => ProfileDots({ windowId, width, besideDownloads }), { props: startBesideDownloads });
    t.after(() => {
      row.unmount();
      markDrag(noDragMarks, { sources: new Set() });
    });

    const marks = () => row.value.props.children.props.children.map((child) => child.props);
    const cells = () => marks().map((p) => p.cell);
    const frames = () => {
      const sizes = cells();
      let left = (width + row.value.props.style.paddingLeft - sizes.reduce((sum, size) => sum + size, 0)) / 2;
      return sizes.map((size) => {
        const frame = [left, left + size];
        left += size;
        return frame;
      });
    };
    const before = frames();
    const pointer = (before[target][0] + before[target][1]) / 2;
    const pointedProfile = () => frames().findIndex(([left, right]) => pointer >= left && pointer < right);
    assert.equal(pointedProfile(), target);
    markDrag(noDragMarks, { sources: new Set(["tab"]) });
    assert.deepEqual(frames(), before);
    s().switchProfile(windowId, ids[target]);
    row.rerender(endBesideDownloads);
    assert.equal(marks()[target].icon, endBesideDownloads ? null : emojis[target]);
    assert.equal(pointedProfile(), target);
    assert.deepEqual(frames(), before);
    s().switchProfile(windowId, ids[7]);
    const finalIcon = endBesideDownloads && width === 219 ? null : emojis[7];
    assert.equal(marks()[7].icon, finalIcon);
    assert.deepEqual(frames(), before);
    markDrag(noDragMarks, { sources: new Set() });
    assert.equal(cells()[0], 12);
    assert.equal(cells()[7], switcherCellWidth(finalIcon));
  });
}
