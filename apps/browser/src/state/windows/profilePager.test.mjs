import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { mount } = await import("../../test-hooks.mjs");
const { LEAVING_PAGE_STAYS_MS, pagerFor, useOffsetKeptAway, usePageInReach } = await import("./profilePager.ts");

const S = () => useBrowser.getState();

test("a window that exists keeps one pager; a missing window gets a throwaway that isn't kept", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  assert.equal(pagerFor(w), pagerFor(w));
  assert.notEqual(pagerFor("w-gone"), pagerFor("w-gone"));
});

test("the pages in reach are the shown profile and the ones beside it, and they move with a switch", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const first = S().windows[w].profileId;
  const [b, c, d, e] = ["B", "C", "D", "E"].map((name) => S().createProfile({ name }));
  const reach = () => (pagerFor(w).state.getState().pages ?? []).map((p) => p.id);
  assert.deepEqual(reach(), [first, b]);
  S().switchProfile(w, d);
  assert.deepEqual(reach(), [c, d, e]);
  S().switchProfile(w, e);
  assert.deepEqual(reach(), [d, e]);
});

test("a page that leaves reach keeps the scroll offset it left with until it is back, whatever its scroll view reports meanwhile", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.example/" });
  const first = S().windows[w].profileId;
  const [, far] = ["B", "C", "D"].map((name) => S().createProfile({ name }));
  S().switchProfile(w, far);
  let scrolled = 240;
  const page = mount(({ current }) => {
    const inReach = usePageInReach(w, far, current);
    return { inReach, kept: useOffsetKeptAway(inReach, () => scrolled) };
  }, { props: { current: true } });
  t.after(() => page.unmount());
  assert.deepEqual(page.value, { inReach: true, kept: 0 });
  S().switchProfile(w, first);
  page.rerender({ current: false });
  assert.deepEqual(page.value, { inReach: true, kept: 0 }, "a page sliding away keeps its rows for a moment");
  t.mock.timers.tick(LEAVING_PAGE_STAYS_MS);
  assert.deepEqual(page.value, { inReach: false, kept: 240 });
  scrolled = 0;
  page.rerender({ current: false });
  assert.equal(page.value.kept, 240, "the offset it left with, not the one its emptied scroll view reports");
  S().switchProfile(w, far);
  page.rerender({ current: true });
  assert.deepEqual(page.value, { inReach: true, kept: 0 });
});
