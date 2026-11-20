import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser } = await import("./store.ts");
const { tabsShownIn } = await import("./model.ts");
const { watchSettings, watchTabRecord, watchWindowSettings } = await import("./keyedWatch.ts");
const { addressBarInSidebar, minimalismIn, pageFrameIn } = await import("../windows/layout.ts");
const { splitOf } = await import("../splits/splits.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();

function session() {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com/" });
  const ids = [S().windows[w].tabIds[0]];
  for (let i = 0; i < 5; i++) ids.push(S().newTab(w, { url: `https://site${i}.com/`, background: true }));
  const other = S().createWindow({ url: "https://z.com/" });
  return { w, other, ids };
}

const layoutOf = (w) => `${tabsShownIn(S(), w)}:${addressBarInSidebar(S(), w)}:${minimalismIn(S(), w)}:${pageFrameIn(S(), w)}`;

test("a window's layout reads wake its window key whenever they change", () => {
  const { w, other, ids } = session();
  const woken = new Set();
  const offs = [w, other].map((id) => watchWindowSettings(id, () => woken.add(id)));
  const run = (what, act) => {
    const before = { [w]: layoutOf(w), [other]: layoutOf(other) };
    woken.clear();
    act();
    for (const id of [w, other]) if (layoutOf(id) !== before[id]) assert.ok(woken.has(id), `${what}: window ${id} layout changed without waking`);
    return new Set(woken);
  };
  const switched = run("switch", () => S().activate(ids[2]));
  assert.ok(!switched.has(other), "a switch in one window wakes another window's layout reads");
  run("address bar", () => S().updateSettings({ addressBar: "sidebar" }));
  run("minimalism", () => S().updateSettings({ minimalismMode: true }));
  run("auto-hide", () => S().updateSettings({ autoHideTabs: true }));
  run("page frame", () => S().updateSettings({ pageFrame: 0 }));
  run("full screen", () => S().setWindowFullScreen(w, true));
  run("leave full screen", () => S().setWindowFullScreen(w, false));
  offs.forEach((off) => off());
});

test("a tab switch wakes no settings or split subscriber, and a split or a pin wakes what reads it", () => {
  const { ids } = session();
  let settings = 0;
  const offSettings = watchSettings("", () => settings++);
  let pinned = 0;
  const offPin = watchTabRecord(ids[3], () => pinned++);
  S().activate(ids[1]);
  S().activate(ids[4]);
  assert.equal(settings, 0);
  assert.equal(pinned, 0);
  S().pinTabs([ids[3]], true);
  assert.ok(pinned > 0);
  assert.ok(!splitOf(S(), ids[1]));
  S().createSplit([ids[1], ids[2]]);
  assert.ok(splitOf(S(), ids[1]));
  offSettings();
  offPin();
});

test("per-row hooks subscribe by key, not to the whole store", () => {
  const src = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(src("../media/media.ts"), /export const usePinnedWithMediaControls = \(tabId: string \| undefined\) =>\n\s*useKeyed\(watchTabRecord,/);
  assert.match(src("../windows/card.ts"), /export const useInSplit = \(tabId: string\) => useKeyed\(watchSplits,/);
  assert.match(src("../../components/sidebar/TabPressArea.tsx"), /const inSplit = useInSplit\(props\.tab\.id\);/);
  const layout = src("../windows/layout.ts");
  for (const hook of ["useMinimalism", "useAddressBarInSidebar", "usePageFrameInset"]) {
    const body = layout.slice(layout.indexOf(hook), layout.indexOf("\n}", layout.indexOf(hook)));
    assert.match(body, /useWindowSettings\(windowId,/, `${hook} reads through useWindowSettings`);
  }
  assert.match(src("../app/theme.ts"), /export function useSelectedTopApp\(\) \{\n\s*return useSettings\(/);
});

test("a tab's row flags carry its split, so the row reads no split state of its own", async () => {
  const { rowFlags, IN_SPLIT } = await import("../sidebar/rowState.ts");
  const { w, ids } = session();
  assert.equal(rowFlags(S(), w, ids[1]) & IN_SPLIT, 0);
  S().createSplit([ids[1], ids[2]]);
  assert.ok(rowFlags(S(), w, ids[1]) & IN_SPLIT);
  assert.equal(rowFlags(S(), w, ids[3]) & IN_SPLIT, 0);
});
