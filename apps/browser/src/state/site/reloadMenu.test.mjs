import assert from "node:assert/strict";
import { test } from "node:test";
const { reloadMenuItems, siteOrigin, clearSiteDataAfterConfirm, siteDataOutcome, siteDataFailed } = await import("./reloadMenu.ts");
const { useBrowser } = await import("../browser/store.ts");
const { webviews } = await import("../../platform/webviews.ts");
const { shellNativeModules } = await import("../../test-native/shell.ts");
const { ardiaCoreNativeModules } = await import("../../test-native/ardiacore.ts");

const G = { control: "⌃", option: "⌥", shift: "⇧", command: "⌘" };
const keys = (i) => (i.key ? ["control", "option", "shift", "command"].filter((m) => i.modifiers?.includes(m)).map((m) => G[m]).join("") + i.key.toUpperCase() : "");
const render = (items, depth = 0) =>
  items.flatMap((i) => [
    "  ".repeat(depth) + (i.separator ? "---" : [i.checked ? "✓" : "", i.title, keys(i), i.symbol ? `[${i.symbol}]` : "", i.swatch ? "(swatch)" : "", i.enabled === false ? "(off)" : "", i.children ? "›" : ""].filter(Boolean).join(" ")),
    ...(i.children ? render(i.children, depth + 1) : []),
  ]);

test("the reload button's menu: Reload and Hard Reload with their keys, the site's ad blocker as a checkmark, then Clear Cookies and Site Data…", () => {
  assert.deepEqual(render(reloadMenuItems({ blocker: "on" })), [
    "Reload ⌘R [arrow.clockwise]",
    "Hard Reload ⇧⌘R [arrow.triangle.2.circlepath]",
    "---",
    "✓ Block Ads & Trackers [hand.raised]",
    "---",
    "Clear Cookies and Site Data… [trash]",
  ]);
  assert.deepEqual(render(reloadMenuItems({ blocker: "off" }))[3], "Block Ads & Trackers [hand.raised]");
  assert.deepEqual(render(reloadMenuItems({ blocker: "offInSettings" }))[3], "Block Ads & Trackers [hand.raised]");
  assert.deepEqual(render(reloadMenuItems({ blocker: "unavailable" }))[3], "Block Ads & Trackers [hand.raised] (off)");
});

test("only web pages have a site to configure", () => {
  assert.equal(siteOrigin("https://a.com/x?y"), "https://a.com");
  assert.equal(siteOrigin("ardia://newtab"), null);
  assert.equal(siteOrigin("not a url"), null);
});

const S = () => useBrowser.getState();

function pendingClear(engine) {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const w = S().createWindow({ url: "https://a.com/x", profileId: work });
  const id = S().windows[w].tabIds[0];
  if (engine) S().updateTab(id, { engine });
  const view = { cleared: 0, reloaded: 0 };
  webviews.set(id, { clearSiteData: async () => (view.cleared++, { cookies: 2, storage: true }), reload: async () => void view.reloaded++ });
  const recording = (module, calls) => {
    const call = module.call;
    module.call = (verb, profile, json) => (calls.push({ verb, profile, ...JSON.parse(json) }), call(verb, profile, json));
    return () => (module.call = call);
  };
  const engineCalls = [];
  const restore = [recording(ardiaCoreNativeModules.ArdiaSites, engineCalls)];
  let answer;
  const asked = [];
  const confirm = shellNativeModules.ArdiaDialogs.confirm;
  shellNativeModules.ArdiaDialogs.confirm = (options) => (asked.push(options.title), new Promise((resolve) => (answer = (confirmed) => resolve({ confirmed, suppressed: false }))));
  const done = clearSiteDataAfterConfirm(S().tabs[id], "https://a.com");
  const finish = async (confirmed) => {
    answer(confirmed);
    const result = await done;
    restore.forEach((undo) => undo());
    shellNativeModules.ArdiaDialogs.confirm = confirm;
    webviews.delete(id);
    return result;
  };
  return { id, work, view, engineCalls, asked, finish };
}

const clears = (calls) => calls.filter((c) => c.verb === "clearData").map((c) => [c.origin, c.engine]).sort();

for (const engine of [undefined, "webkit"])
  test(`Clear Cookies and Site Data clears the site the confirmation named in both engines, also when the tab moved on meanwhile (${engine ?? "chromium"} tab)`, async () => {
    const stay = pendingClear(engine);
    assert.deepEqual(stay.asked, ["Clear cookies and site data for a.com?"]);
    assert.equal(await stay.finish(true), 0);
    assert.deepEqual(clears(stay.engineCalls), [["https://a.com", "chromium"], ["https://a.com", "webkit"]]);
    assert.ok(stay.engineCalls.filter((c) => c.verb === "clearData").every((c) => c.profile === stay.work));
    assert.equal(stay.view.cleared, 0, "not the view's own clear, which reads the page's host when native runs it");
    assert.equal(stay.view.reloaded, 1, "the page reloads without its data");

    const moved = pendingClear(engine);
    S().updateTab(moved.id, { url: "https://b.com/", title: "B" }, {});
    await moved.finish(true);
    assert.deepEqual(clears(moved.engineCalls), [["https://a.com", "chromium"], ["https://a.com", "webkit"]], "a.com, never b.com");
    assert.equal(moved.view.cleared, 0);
    assert.equal(moved.view.reloaded, 0, "and b.com isn't reloaded");

    const declined = pendingClear(engine);
    assert.equal(await declined.finish(false), null);
    assert.deepEqual(declined.engineCalls, []);
  });

test("the outcome says what was cleared, what wasn't, and never claims a clear that failed", () => {
  assert.equal(siteDataOutcome({ cookies: 3, storage: true }), "Cleared 3 cookies and site data");
  assert.equal(siteDataOutcome({ cookies: 1, storage: true }), "Cleared 1 cookie and site data");
  assert.equal(siteDataOutcome({ cookies: 0, storage: true }), "Cleared site data");
  assert.equal(siteDataOutcome({ cookies: 3, storage: false }), "Cleared 3 cookies, but not all site data. Try again");
  assert.equal(siteDataOutcome({ cookies: 0, storage: false }), "Couldn't clear all of this site's data. Try again");
  assert.equal(siteDataOutcome({ cookies: false, storage: true }), "Cleared site data, but not its cookies. Try again");
  assert.equal(siteDataOutcome({ cookies: false, storage: false }), "Couldn't clear this site's data. Try again");
  assert.equal(siteDataOutcome("failed"), "Couldn't clear this site's data. Try again");
  assert.deepEqual([siteDataFailed("failed"), siteDataFailed({ cookies: false, storage: false }), siteDataFailed({ cookies: 0, storage: false }), siteDataFailed({ cookies: 2, storage: true })], [true, true, false, false]);
});
