import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { rootPointIn, screenPoint, windowUnder, dropTabsOutside } = await import("./windowDrop.ts");
const { useInterfaceScale } = await import("../settings/interfaceScale.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const atScale = (scale, run) => {
  useInterfaceScale.setState({ scale });
  try {
    return run();
  } finally {
    useInterfaceScale.setState({ scale: 1 });
  }
};

test("a root point leaves its window as a screen point at the window's scale, and comes back in another window's root points", () => {
  const id = S().createWindow({ url: "https://a.example/", frame: [100, 200, 1000, 800] });
  assert.deepEqual(screenPoint(S(), id, 40, 60), [140, 940]);
  atScale(1.25, () => {
    assert.deepEqual(screenPoint(S(), id, 40, 60), [150, 925]);
    assert.deepEqual(rootPointIn([100, 200, 1000, 800], [150, 925]), [40, 60]);
    assert.deepEqual(rootPointIn([600, 100, 500, 500], [850, 350]), [200, 200]);
  });
});

test("at a larger scale the window's edge is its physical width divided by the scale", () => {
  const id = S().createWindow({ url: "https://b.example/", frame: [0, 0, 1000, 800] });
  assert.equal(windowUnder(S(), id, 900, 100).outside, false);
  atScale(1.25, () => {
    assert.equal(windowUnder(S(), id, 790, 100).outside, false);
    assert.equal(windowUnder(S(), id, 801, 100).outside, true);
    assert.equal(windowUnder(S(), id, 100, 641).outside, true);
  });
});

test("a tab dropped outside opens a window whose grab offsets are root points at the scale", () => {
  const id = S().createWindow({ url: "https://c.example/", frame: [5000, 0, 1000, 800] });
  const extra = S().newTab(id, { url: "https://c.example/two" });
  let frame = null;
  atScale(1.5, () => dropTabsOutside([extra], id, 700, 100, (f) => (frame = f)));
  assert.deepEqual(frame, [5000 + 1050 - 135, 800 - 150 - 800 + 105, 1000, 800]);
});
