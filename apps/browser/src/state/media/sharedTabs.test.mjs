import assert from "node:assert/strict";
import { test } from "node:test";
const { useMedia } = await import("./media.ts");
const { usePages } = await import("../tabs/pageState.ts");
const { tabSharedNow, watchTabShared } = await import("./sharedTabs.ts");

const page = (id, screen) => usePages.setState((p) => ({ pages: { ...p.pages, [id]: { ...p.pages[id], mediaAccess: screen ? { camera: false, microphone: false, screen: true } : null } } }));

test("a tab reads as shared only while the tab sharing it captures the screen, and only that row wakes", () => {
  const woke = { a: 0, b: 0 };
  const stopA = watchTabShared("a", () => woke.a++);
  const stopB = watchTabShared("b", () => woke.b++);
  page("other", false);
  assert.deepEqual(woke, { a: 0, b: 0 }, "a page update with no share wakes no row");
  useMedia.setState({ tabShares: { meet: { capturedTabId: "a", origin: "https://meet.example", dismissed: {} } } });
  assert.equal(tabSharedNow("a"), false);
  page("meet", true);
  assert.equal(tabSharedNow("a"), true);
  assert.deepEqual(woke, { a: 1, b: 0 });
  page("other", true);
  assert.deepEqual(woke, { a: 1, b: 0 }, "another page's change doesn't wake the shared row");
  page("meet", false);
  assert.equal(tabSharedNow("a"), false);
  assert.deepEqual(woke, { a: 2, b: 0 });
  stopA();
  stopB();
  useMedia.setState({ tabShares: {} });
});

test("with no share at all, the shared-tab watch keeps no pages-store listener", () => {
  let calls = 0;
  const subscribe = usePages.subscribe;
  usePages.subscribe = (listener) => {
    calls++;
    return subscribe(listener);
  };
  const stop = watchTabShared("a", () => {});
  usePages.subscribe = subscribe;
  assert.equal(calls, 0);
  stop();
});
