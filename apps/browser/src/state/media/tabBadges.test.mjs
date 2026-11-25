import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";
const { useBrowser } = await import("../browser/store.ts");
const { patchPage } = await import("../tabs/pageState.ts");
const { useMedia } = await import("./media.ts");
const { useTabHasBadges } = await import("./tabBadges.ts");

const S = () => useBrowser.getState();
const PERSONAL = { id: "default", name: "Personal", color: "plum", icon: null, createdAt: 0 };

test("a row mounts its badges only while its own tab captures, is shared or has a Peek open, and wakes for nothing else", () => {
  S().hydrate({ profiles: { default: PERSONAL }, profileOrder: ["default"] });
  const w = S().createWindow({ url: "https://a.example/" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://b.example/", background: true });
  S().activate(a);
  useMedia.setState({ tabShares: {}, sharedTabs: {} });
  const rowA = mount(() => useTabHasBadges(a));
  const rowB = mount(() => useTabHasBadges(b));
  try {
    assert.equal(rowA.value, false);
    assert.equal(rowB.value, false);
    const quiet = rowB.renders;

    patchPage(a, { mediaAccess: { camera: true, microphone: false, screen: false } });
    assert.equal(rowA.value, true, "a camera or microphone capture");
    patchPage(a, { mediaAccess: { camera: true, microphone: true, screen: false } });
    assert.equal(rowA.value, true);
    patchPage(a, { mediaAccess: null });
    assert.equal(rowA.value, false);

    useMedia.setState({ sharedTabs: { [a]: true } });
    assert.equal(rowA.value, true, "a tab shared into a call");
    useMedia.setState({ sharedTabs: {} });
    assert.equal(rowA.value, false);

    const peek = S().openPeek(a, "https://peeked.example/");
    assert.ok(peek);
    assert.equal(rowA.value, true, "a Peek opened from the tab");
    S().closePeek(a);
    assert.equal(rowA.value, false);

    patchPage(a, { status: "loading" });
    S().updateTab(b, { title: "B" });
    assert.equal(rowB.value, false);
    assert.equal(rowB.renders, quiet, "the other row never woke");
  } finally {
    rowA.unmount();
    rowB.unmount();
    useMedia.setState({ tabShares: {}, sharedTabs: {} });
  }
});
