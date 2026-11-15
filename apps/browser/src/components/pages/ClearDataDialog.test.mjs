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
const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodes = (node) => !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
const button = (h, title) => nodes(h.value).find((node) => node.props?.title === title);
const message = (h) => nodes(h.value).some((node) => node.props?.children === "Some browsing data could not be cleared. Please try again.");

function dialog() {
  S().hydrate({});
  requests.length = 0;
  takeHistoryRemovalCounts();
  const recent = { url: "https://recent.example/", title: "Recent", lastVisit: Date.now(), visits: 1, favicon: null };
  const old = { url: "https://old.example/", title: "Old", lastVisit: Date.now() - 7_200_000, visits: 1, favicon: null };
  useBrowser.setState({ history: { "": { list: [recent, old], floor: -Infinity, ready: true } } });
  const icons = { pages: {}, srcs: {}, appearances: {} };
  useFavicons.setState({ profiles: { "": icons } });
  let closes = 0;
  const h = mount(() => ClearDataDialog({ profileId: "default", onClose: () => closes++ }));
  return { h, recent, old, icons, closes: () => closes };
}

test("clearing waits for native success, leaves history to engine reports and prevents duplicate requests or dismissal", async () => {
  const { h, recent, old, icons, closes } = dialog();
  try {
    const clear = button(h, "Clear Data").props.onPress;
    const cancel = button(h, "Cancel").props.onPress;
    const dismiss = h.value.props.onDismiss;
    clear();
    clear();
    cancel();
    dismiss();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].profile, "");
    assert.deepEqual(requests[0].args.types, ["history", "siteData", "cache"]);
    assert.deepEqual(S().history[""].list, [recent, old]);
    assert.equal(useFavicons.getState().profiles[""], icons);
    assert.equal(closes(), 0);
    assert.equal(button(h, "Clear Data").props.disabled, true);
    assert.equal(button(h, "Cancel").props.disabled, true);
    assert.equal(h.value.props.onDismiss, undefined);
    assert.ok(nodes(h.value).filter((node) => node.props?.onChange).every((node) => node.props.disabled));
    const arrival = { ...recent, url: "https://new-visit.example/", title: "New visit" };
    useBrowser.setState({ history: { "": { ...S().history[""], list: [arrival, old] } } });
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
    assert.equal(button(h, "Cancel").props.disabled, false);
    assert.equal(typeof h.value.props.onDismiss, "function");
    assert.equal(takeHistoryRemovalCounts().browsing_data_clear_failures, 1);
    button(h, "Retry").props.onPress();
    assert.equal(message(h), false);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].args.types, requests[0].args.types);
    requests[1].resolve("null");
    await tick();
    assert.equal(closes(), 1);
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
