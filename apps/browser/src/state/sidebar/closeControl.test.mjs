import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const stubs = {
  "../browser/actions": "export const closeGroup = async () => {};",
  "./clearTabs": "export const middleClickTab = () => {};",
};
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/sidebar/closeControl.ts") || !(specifier in stubs)) return next(specifier, context);
    return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
  },
});

const { useBrowser } = await import("../browser/store.ts");
const { groupCloseControl, pressGroupClose, pressTabClose, tabCloseControl } = await import("./closeControl.ts");

const S = () => useBrowser.getState();
const hasPage = (id) => !!(S().tabs[id].page.nav || S().tabs[id].page.adopt);

function pinnedGroupInTwoWindows() {
  S().hydrate({});
  const a = S().createWindow({ url: "https://a.com/" });
  const [first] = S().windows[a].tabIds;
  const second = S().newTab(a, { url: "https://b.com/", background: true });
  S().newTab(a, { url: "https://x.com/" });
  const g = S().groupTabs([first, second], { name: "P" });
  S().updateGroup(g, { pinned: true });
  const b = S().createWindow({ url: "https://y.com/" });
  const copy = Object.values(S().groups).find((x) => x.name === "P" && x.windowId === b);
  return { g, copy: copy.id, first, second };
}

test("a pinned group's copy in another window offers − while the pages it shares are loaded, and − unloads them", () => {
  const { g, copy, first, second } = pinnedGroupInTwoWindows();
  assert.ok(hasPage(first) && hasPage(second));
  assert.equal(groupCloseControl(S(), g).icon, "minus");
  assert.equal(groupCloseControl(S(), copy)?.icon, "minus");
  pressGroupClose(copy);
  assert.ok(!hasPage(first) && !hasPage(second));
  assert.equal(groupCloseControl(S(), g), null);
  assert.equal(groupCloseControl(S(), copy), null);
});

test("a pinned tab's copy in another window shows − and unloads the page it shares", () => {
  const { copy, first } = pinnedGroupInTwoWindows();
  const mirror = S().groups[copy].tabIds.find((id) => S().tabs[id].pinKey === first || S().tabs[first].pinKey === id);
  assert.ok(mirror);
  assert.equal(tabCloseControl(S(), mirror).icon, "minus");
  pressTabClose(mirror);
  assert.ok(!hasPage(first));
});

for (const keep of [false, true]) {
  for (const inFront of [true, false]) {
    test(`− on a pinned row split with a Top App unloads the split (Keep Top Apps running ${keep ? "on" : "off"}, split ${inFront ? "in front" : "in the background"})`, () => {
      S().hydrate({});
      const w = S().createWindow({ url: "https://app.com/" });
      const [app] = S().windows[w].tabIds;
      const row = S().newTab(w, { url: "https://row.com/" });
      const other = S().newTab(w, { url: "https://other.com/" });
      S().pinTabs([app], true);
      S().pinTabs([row], true, true);
      S().createSplit([app, row]);
      S().updateSettings({ keepTopAppsRunning: keep });
      S().activate(inFront ? row : other);
      assert.equal(tabCloseControl(S(), row).icon, "minus");
      pressTabClose(row);
      assert.equal(S().tabs[row].page.kind, "asleep");
      assert.equal(S().tabs[app].page.kind, "asleep");
      assert.equal(S().windows[w].activeTabIds[S().windows[w].profileId], other);
      S().updateSettings({ keepTopAppsRunning: false });
    });
  }
}

test("− on a pinned group unloads a member split with a Top App while Keep Top Apps running is on", () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://app.com/" });
  const [app] = S().windows[w].tabIds;
  const member = S().newTab(w, { url: "https://member.com/" });
  const second = S().newTab(w, { url: "https://second.com/" });
  S().newTab(w, { url: "https://other.com/" });
  S().pinTabs([app], true);
  const g = S().groupTabs([member, second], { name: "P" });
  S().updateGroup(g, { pinned: true });
  S().createSplit([app, member]);
  S().updateSettings({ keepTopAppsRunning: true });
  assert.equal(groupCloseControl(S(), g)?.icon, "minus");
  pressGroupClose(g);
  assert.equal(S().tabs[member].page.kind, "asleep");
  assert.equal(S().tabs[second].page.kind, "asleep");
  S().updateSettings({ keepTopAppsRunning: false });
});
