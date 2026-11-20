import assert from "node:assert/strict";
import { test } from "node:test";
import { mount } from "../../test-hooks.mjs";

const requests = [];
globalThis.acTestNativeModules = {
  ArdiaProfiles: {
    call(name, profile, json) {
      assert.equal(name, "clearBrowsingData");
      return new Promise((resolve, reject) => requests.push({ profile, args: JSON.parse(json), resolve, reject }));
    },
  },
};

const { useBrowser } = await import("../../state/browser/store.ts");
const { useFavicons, EMPTY_ICONS } = await import("../../state/favicons/favicons.ts");
const { takeHistoryRemovalCounts } = await import("../../state/telemetry/historyRemovalCounts.ts");
const { ClearDataDialog } = await import("./ClearDataDialog.tsx");
const { Dialog } = await import("../ui/index.ts");
const { setConsentPeriod } = await import("../../state/telemetry/consentPeriod.ts");
setConsentPeriod(true, "clear-data-test");
const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodes = (node) => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const button = (h, title) => nodes(h.value).find((node) => node.props?.title === title);
const message = (h) => nodes(h.value).some((node) => node.props?.children === "Some browsing data could not be cleared. Please try again.");

function dialog(profileId = "default", iconKey = "") {
  S().hydrate({});
  requests.length = 0;
  takeHistoryRemovalCounts();
  const recent = { url: "https://recent.example/", title: "Recent", lastVisit: Date.now(), visits: 1, favicon: null };
  const old = { url: "https://old.example/", title: "Old", lastVisit: Date.now() - 7_200_000, visits: 1, favicon: null };
  useBrowser.setState({ history: { "": { list: [recent, old], floor: -Infinity, ready: true } } });
  const icons = { pages: {}, srcs: {}, appearances: {} };
  useFavicons.setState({ profiles: { [iconKey]: icons } });
  let closes = 0;
  const h = mount(() => ClearDataDialog({ profileId, onClose: () => closes++ }));
  return { h, recent, old, icons, closes: () => closes };
}

test("the production dialog routes Escape while idle and during a pending clear", async () => {
  for (const pending of [false, true]) {
    const { h, closes } = dialog();
    let surface;
    let keys;
    try {
      if (pending) button(h, "Clear Data").props.onPress();
      surface = mount(() => Dialog(h.value.props));
      const content = surface.value.props.children[1].props.children;
      assert.equal(typeof content.type, "function", "the dialog installs its keyboard handler");
      keys = mount(() => content.type(content.props));
      assert.ok(keys.value.props.keyDownEvents.some((event) => event.key === "Escape"));
      keys.value.props.onKeyDown({ nativeEvent: { key: "Escape" } });
      assert.equal(closes(), 1);
      if (pending) {
        requests[0].resolve("null");
        await tick();
        assert.equal(closes(), 1, "the pending completion does not close a second time");
      }
    } finally {
      keys?.unmount();
      surface?.unmount();
      h.unmount();
    }
  }
});

test("clearing waits for native success, then removes the cleared range from History, and ignores a second press", async () => {
  const { h, recent, old, icons, closes } = dialog();
  try {
    const clear = button(h, "Clear Data").props.onPress;
    clear();
    clear();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].profile, "");
    assert.deepEqual(requests[0].args.types, ["history", "siteData", "cache"]);
    assert.deepEqual(S().history[""].list, [recent, old]);
    assert.equal(useFavicons.getState().profiles[""], icons);
    assert.equal(closes(), 0);
    assert.equal(button(h, "Clear Data").props.disabled, true);
    assert.ok(nodes(h.value).filter((node) => node.props?.onChange).every((node) => node.props.disabled));
    const arrival = { ...recent, url: "https://new-visit.example/", title: "New visit", lastVisit: Date.now() + 1 };
    useBrowser.setState({ history: { "": { ...S().history[""], list: [arrival, recent, old] } } });
    requests[0].resolve("null");
    await tick();
    assert.deepEqual(S().history[""].list, [arrival, old]);
    assert.equal(useFavicons.getState().profiles[""], EMPTY_ICONS);
    assert.equal(closes(), 1);
    assert.equal(takeHistoryRemovalCounts().browsing_data_clears, 1);
  } finally {
    requests[0]?.resolve("null");
    await tick();
    h.unmount();
  }
});

test("Cancel, Esc and the backdrop still leave while a clear is pending, without closing again when it finishes", async () => {
  const { h, old, closes } = dialog();
  try {
    assert.equal(button(h, "Cancel").props.disabled, undefined);
    button(h, "Clear Data").props.onPress();
    assert.equal(typeof h.value.props.onDismiss, "function");
    button(h, "Cancel").props.onPress();
    assert.equal(closes(), 1);
    requests[0].resolve("null");
    await tick();
    assert.equal(closes(), 1);
    assert.deepEqual(S().history[""].list, [old]);
    assert.equal(useFavicons.getState().profiles[""], EMPTY_ICONS);
  } finally {
    h.unmount();
  }
  const again = dialog();
  try {
    button(again.h, "Clear Data").props.onPress();
    again.h.value.props.onDismiss();
    assert.equal(again.closes(), 1);
    requests[0].reject(Object.assign(new Error("failed"), { code: "ERR_ENGINE" }));
    await tick();
    assert.equal(again.closes(), 1);
    assert.deepEqual(S().history[""].list, [again.recent, again.old]);
    assert.equal(useFavicons.getState().profiles[""], again.icons);
    assert.equal(takeHistoryRemovalCounts().browsing_data_clear_failures, 1);
  } finally {
    again.h.unmount();
  }
});

test("an incognito window's clear asks nothing of the engine and still prunes its own favicons", async () => {
  const { h, recent, old, closes } = dialog("incognito:w1", "incognito:w1");
  try {
    button(h, "Clear Data").props.onPress();
    await tick();
    assert.equal(requests.length, 0);
    assert.equal(useFavicons.getState().profiles["incognito:w1"], EMPTY_ICONS);
    assert.deepEqual(S().history[""].list, [recent, old]);
    assert.equal(closes(), 1);
  } finally {
    h.unmount();
  }
});

test("a native failure keeps the dialog and caches, releases busy state, and allows a successful retry", async () => {
  const { h, recent, old, icons, closes } = dialog();
  try {
    button(h, "Clear Data").props.onPress();
    requests[0].reject(Object.assign(new Error("private native failure detail"), { code: "ERR_ENGINE" }));
    await tick();
    assert.equal(closes(), 0);
    assert.equal(message(h), true);
    assert.deepEqual(S().history[""].list, [recent, old]);
    assert.equal(useFavicons.getState().profiles[""], icons);
    assert.equal(button(h, "Retry").props.disabled, false);
    assert.ok(nodes(h.value).filter((node) => node.props?.onChange).every((node) => !node.props.disabled));
    assert.equal(takeHistoryRemovalCounts().browsing_data_clear_failures, 1);
    button(h, "Retry").props.onPress();
    assert.equal(message(h), false);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].args.types, requests[0].args.types);
    requests[1].resolve("null");
    await tick();
    assert.equal(closes(), 1);
    assert.deepEqual(S().history[""].list, [old]);
    assert.equal(useFavicons.getState().profiles[""], EMPTY_ICONS);
    assert.equal(takeHistoryRemovalCounts().browsing_data_clears, 1);
  } finally {
    h.unmount();
  }
});

test("site data alone uses the chosen range without pruning history or favicon caches", async () => {
  const { h, recent, old, icons, closes } = dialog();
  try {
    button(h, "Browsing history").props.onChange(false);
    nodes(h.value).find((node) => node.props?.value === "hour").props.onChange("all");
    button(h, "Clear Data").props.onPress();
    assert.deepEqual(requests[0].args, { types: ["siteData", "cache"], since: null });
    requests[0].resolve("null");
    await tick();
    assert.equal(closes(), 1);
    assert.deepEqual(S().history[""].list, [recent, old]);
    assert.equal(useFavicons.getState().profiles[""], icons);
  } finally {
    h.unmount();
  }
});

test("completion prunes the engine requested at the start even if the profile mapping changes", async () => {
  const { h, closes } = dialog();
  try {
    button(h, "Clear Data").props.onPress();
    const since = requests[0].args.since;
    assert.ok(Math.abs(since - (Date.now() - 3_600_000)) < 1000);
    useBrowser.setState({ profiles: { ...S().profiles, default: { ...S().profiles.default, dataId: "other-engine" } } });
    const other = { pages: {}, srcs: {}, appearances: {} };
    useFavicons.setState({ profiles: { ...useFavicons.getState().profiles, "other-engine": other } });
    requests[0].resolve("null");
    await tick();
    assert.equal(requests[0].profile, "");
    assert.equal(requests[0].args.since, since);
    assert.equal(useFavicons.getState().profiles[""], EMPTY_ICONS);
    assert.equal(useFavicons.getState().profiles["other-engine"], other);
    assert.equal(closes(), 1);
  } finally {
    h.unmount();
  }
});

test("deselecting both kinds does not issue a native request", () => {
  const { h, closes } = dialog();
  try {
    button(h, "Browsing history").props.onChange(false);
    button(h, "Cookies, site data and cached files").props.onChange(false);
    assert.equal(button(h, "Clear Data").props.disabled, true);
    button(h, "Clear Data").props.onPress();
    assert.equal(requests.length, 0);
    assert.equal(closes(), 0);
  } finally {
    h.unmount();
  }
});
