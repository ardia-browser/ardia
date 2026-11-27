import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import { UPDATE_PREFERENCES } from "./hostUpdates.ts";
import { setConsentPeriod } from "../../../../browser/src/state/telemetry/consentPeriod.ts";
import { takeUpdateCounts } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { useToasts } from "../../../../browser/src/state/app/toasts.ts";
import { mount } from "../../../../browser/src/test-hooks.mjs";

const entry = new URL("./linuxUpdates.ts", import.meta.url).href;
const fakes = new Map([
  ["../../shims/shellBase", "export const refreshDocument = async () => {};"],
  ["../../../../browser/src/platform/app", "export const systemInfo = () => ({ appVersion: '0.2.45' });"],
  ["../../../../browser/src/platform/clipboard", "export const copyText = (text) => globalThis.__linuxUpdateTest.copied.push(text); export const copyAddress = (url) => globalThis.__linuxUpdateTest.copied.push(url);"],
  ["../../../../browser/src/platform/dialogs", "export const confirm = async (options) => (globalThis.__linuxUpdateTest.dialogs.push(options), { confirmed: false });"],
  ["../../../../browser/src/platform/documents", "export const readDocument = (name) => globalThis.__linuxUpdateTest.docs.get(name) ?? null; export const saveDocument = async (name, contents) => void globalThis.__linuxUpdateTest.docs.set(name, contents);"],
  ["../../../../browser/src/state/browser/actions", "export const openUrls = (urls) => globalThis.__linuxUpdateTest.opened.push(...urls);"],
  ["../../../../browser/src/state/settings/settingsWindows", "export const openUrlFromSettings = (url) => globalThis.__linuxUpdateTest.opened.push(url);"],
]);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return context.parentURL === entry && fakes.has(specifier)
      ? { url: `data:text/javascript,${encodeURIComponent(fakes.get(specifier))}`, shortCircuit: true }
      : next(specifier, context);
  },
});
const { linuxUpdaterFor } = await import("./linuxUpdates.ts");
hooks.deregister();
const { SplitToast } = await import("../../../../browser/src/components/split/SplitChrome.tsx");

function harness({ kind, phase = "idle", windowId = "main", docs = new Map(), version = "0.2.46", claimed = new Set(), fresh = true, claimFailures = 0 } = {}) {
  const state = { docs, opened: [], copied: [], dialogs: [], version };
  globalThis.__linuxUpdateTest = state;
  if (fresh) {
    useToasts.setState({ toasts: {} });
    setConsentPeriod(true, "linux-update-toast-test");
    takeUpdateCounts();
  }
  const host = {
    bootstrap: { windowId, capabilities: ["ArdiaUpdates.releases", ...(kind ? SELF_UPDATE_METHODS : [])] },
    invoke: async (method, request) => {
      if (method === "ArdiaUpdates.status") return { kind, phase, version, reason: "network", run: phase === "idle" ? 0 : 1 };
      if (method === "ArdiaUpdates.claimOutcome") {
        if (claimFailures-- > 0) throw new Error("claimOutcome failed");
        const [run] = request.args;
        if (claimed.has(run)) return false;
        claimed.add(run);
        return true;
      }
      assert.equal(method, "ArdiaUpdates.releases");
      return { status: 200, body: JSON.stringify([{ tag_name: `v${state.version}`, html_url: `https://github.com/ardia-browser/ardia/releases/tag/v${state.version}`, assets: [{ name: `Ardia-${state.version}-linux-x64.tar.xz` }] }]) };
    },
  };
  return { ...state, state, updater: linuxUpdaterFor(host) };
}

function toast(t) {
  const mounted = mount(() => SplitToast.type({ windowId: "main" }));
  t.after(() => mounted.unmount());
  return mounted;
}

for (const kind of [undefined, "managed"]) {
  test(`${kind ?? "manual"} updates can be dismissed without opening a page or dialog, including after relaunch`, async (t) => {
    const { updater, state } = harness({ kind });
    await updater.check(false);
    const shown = toast(t);
    assert.equal(shown.value.props.secondary, "Later");
    shown.value.props.onSecondary();
    shown.rerender();
    assert.equal(shown.value, null);
    assert.equal(useToasts.getState().toasts.main, null);
    assert.deepEqual(state.opened, []);
    assert.deepEqual(state.dialogs, []);
    assert.deepEqual(state.copied, []);
    assert.equal(takeUpdateCounts().update_notices_dismissed, 1);
    await updater.check(false);
    assert.equal(useToasts.getState().toasts.main, null, "the same version stays dismissed");
    const next = harness({ kind, docs: state.docs });
    await next.updater.check(false);
    assert.equal(useToasts.getState().toasts.main, undefined, "relaunch does not offer the same version");
    next.state.version = "0.2.47";
    await next.updater.check(false);
    assert.equal(useToasts.getState().toasts.main.title, "Ardia 0.2.47 is available");
  });
}

test("View still opens the offered release page and closes the toast", async (t) => {
  const { updater, opened } = harness();
  await updater.check(false);
  const shown = toast(t);
  assert.equal(shown.value.props.action, "View");
  shown.value.props.onAction();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.deepEqual(opened, ["https://github.com/ardia-browser/ardia/releases/tag/v0.2.46"]);
  const counts = takeUpdateCounts();
  assert.equal(counts.update_release_page_opens, 1);
  assert.equal(counts.update_notices_dismissed ?? 0, 0);
});

test("a failed automatic update's release-page notice can be dismissed", async (t) => {
  const { updater, opened, docs } = harness({ kind: "deb", phase: "failed" });
  await updater.watch();
  await updater.watch();
  const shown = toast(t);
  assert.equal(shown.value.props.secondary, "Later");
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.deepEqual(opened, []);
  assert.equal(JSON.parse(docs.get(UPDATE_PREFERENCES)).failed, "0.2.46");
  assert.equal(takeUpdateCounts().update_notices_dismissed, 1);
});

test("dismissals count only while telemetry sharing is on", async (t) => {
  const { updater } = harness();
  await updater.check(false);
  const shown = toast(t);
  setConsentPeriod(false, null);
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.equal(takeUpdateCounts().update_notices_dismissed ?? 0, 0);
});

test("utility windows do not create update notices", async () => {
  const { updater } = harness({ windowId: "settings" });
  await updater.check(false);
  assert.deepEqual(useToasts.getState().toasts, {});
});

test("an offer to install an update can be dismissed without installing it", async (t) => {
  const docs = new Map([[UPDATE_PREFERENCES, JSON.stringify({ automaticDownloads: false })]]);
  const { updater, state } = harness({ kind: "deb", docs });
  await updater.check(false);
  const shown = toast(t);
  assert.equal(shown.value.props.action, "Update");
  assert.equal(shown.value.props.secondary, "Later");
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  assert.equal(useToasts.getState().toasts.main, null);
  assert.deepEqual(state.opened, []);
  const counts = takeUpdateCounts();
  assert.equal(counts.update_notices_dismissed, 1);
  assert.equal(counts.update_downloads_started, 0);
  await updater.check(false);
  assert.equal(useToasts.getState().toasts.main, null, "the same version stays dismissed");
});

test("a finished update's restart notice can be dismissed without restarting", async (t) => {
  const { updater } = harness({ kind: "deb", phase: "ready" });
  await updater.watch();
  await updater.watch();
  const shown = toast(t);
  assert.equal(shown.value.props.action, "Restart");
  assert.equal(shown.value.props.secondary, "Later");
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  const counts = takeUpdateCounts();
  assert.equal(counts.update_notices_dismissed, 1);
  assert.equal(counts.update_restarts, 0);
  assert.equal(await updater.menuItem(), "restart", "the app menu still offers the restart");
});

test("a restart notice dismissed from Check for Updates stays closed when the watcher settles the run", async (t) => {
  const { updater } = harness({ kind: "deb", phase: "ready" });
  await updater.check(true);
  const shown = toast(t);
  assert.equal(shown.value.props.action, "Restart");
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  await updater.watch();
  await updater.watch();
  assert.equal(useToasts.getState().toasts.main, null, "the watcher does not bring the dismissed notice back");
  const counts = takeUpdateCounts();
  assert.equal(counts.update_notices_dismissed, 1);
  assert.equal(counts.update_downloads_finished, 1, "the finished update is counted once");
});

test("a restart notice dismissed in one window does not come back in the window that watches for updates", async (t) => {
  const claimed = new Set();
  const watcher = harness({ kind: "deb", phase: "ready", claimed });
  const asking = harness({ kind: "deb", phase: "ready", windowId: "other", claimed, docs: watcher.docs, fresh: false });
  await asking.updater.check(true);
  assert.equal(useToasts.getState().toasts.other.title, "Ardia 0.2.46 is ready");
  useToasts.getState().toasts.other.secondary.run();
  useToasts.setState((s) => ({ toasts: { ...s.toasts, other: null } }));
  await watcher.updater.watch();
  await watcher.updater.watch();
  assert.equal(useToasts.getState().toasts.main, undefined, "the watching window does not show the notice again");
  const counts = takeUpdateCounts();
  assert.equal(counts.update_notices_dismissed, 1);
  assert.equal(counts.update_downloads_finished, 1, "the finished update is counted once");
});

test("a restart notice dismissed while the host could not claim its run stays closed when the watcher claims it", async (t) => {
  const { updater } = harness({ kind: "deb", phase: "ready", claimFailures: 1 });
  await updater.check(true);
  const shown = toast(t);
  assert.equal(shown.value.props.action, "Restart");
  shown.value.props.onSecondary();
  shown.rerender();
  assert.equal(shown.value, null);
  await updater.watch();
  await updater.watch();
  assert.equal(useToasts.getState().toasts.main, null, "the watcher does not bring the dismissed notice back");
  const counts = takeUpdateCounts();
  assert.equal(counts.update_notices_dismissed, 1);
  assert.equal(counts.update_downloads_finished, 1, "the watcher still counts the finished update");
});

test("a restart notice dismissed in one window while the host could not claim its run stays closed in the watching window", async (t) => {
  const claimed = new Set();
  const watcher = harness({ kind: "deb", phase: "ready", claimed });
  const asking = harness({ kind: "deb", phase: "ready", windowId: "other", claimed, docs: watcher.docs, fresh: false, claimFailures: 1 });
  await asking.updater.check(true);
  assert.equal(useToasts.getState().toasts.other.title, "Ardia 0.2.46 is ready");
  useToasts.getState().toasts.other.secondary.run();
  useToasts.setState((s) => ({ toasts: { ...s.toasts, other: null } }));
  await watcher.updater.watch();
  await watcher.updater.watch();
  assert.equal(useToasts.getState().toasts.main, undefined, "the watching window does not show the notice again");
  const counts = takeUpdateCounts();
  assert.equal(counts.update_notices_dismissed, 1);
  assert.equal(counts.update_downloads_finished, 1, "the watcher still counts the finished update");
});

test("Check Now in Settings, which shows no toasts, leaves the restart notice to the watching browser window", async () => {
  const claimed = new Set();
  const watcher = harness({ kind: "deb", phase: "ready", claimed });
  const settings = harness({ kind: "deb", phase: "ready", windowId: "settings", claimed, docs: watcher.docs, fresh: false });
  await settings.updater.check(true);
  assert.equal(useToasts.getState().toasts.settings, undefined);
  await watcher.updater.watch();
  await watcher.updater.watch();
  assert.equal(useToasts.getState().toasts.main.title, "Ardia 0.2.46 is ready");
  assert.equal(takeUpdateCounts().update_downloads_finished, 1);
});
