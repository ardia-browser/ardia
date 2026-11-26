import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import { takeUpdateCounts } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { setConsentPeriod } from "../../../../browser/src/state/telemetry/consentPeriod.ts";

const ui = { confirms: [], toasts: [], opened: [], copied: [], settingsOpens: true, docs: new Map() };
globalThis.__linuxUpdatesUi = ui;

const stub = (source) => `data:text/javascript,${encodeURIComponent(`const ui = globalThis.__linuxUpdatesUi;\n${source}`)}`;
const STUBS = {
  "../../session.ts": stub(`export const isLinuxUtility = (id) => id === "settings";`),
  "../../shims/shellBase": stub(`export const refreshDocument = async () => {};`),
  "../../../../browser/src/platform/app": stub(`export const systemInfo = () => ({ appVersion: "0.2.45" });`),
  "../../../../browser/src/platform/clipboard": stub(`export const copyText = (text) => void ui.copied.push(text); export const copyAddress = (url) => void ui.copied.push(url);`),
  "../../../../browser/src/platform/dialogs": stub(`export const confirm = async (options) => (ui.confirms.push(options), { confirmed: true });`),
  "../../../../browser/src/platform/documents": stub(`export const readDocument = (name) => ui.docs.get(name) ?? null; export const saveDocument = async (name, contents) => void ui.docs.set(name, contents);`),
  "../../../../browser/src/state/app/toasts": stub(`export const showToast = (windowId, title, message, options) => void ui.toasts.push({ windowId, title, message, options });`),
  "../../../../browser/src/state/browser/actions": stub(`export const openUrls = (urls) => void ui.opened.push(...urls);`),
  "../../../../browser/src/state/settings/settingsWindows": stub(`export const openUrlFromSettings = (url) => (ui.settingsOpens && ui.opened.push(url), ui.settingsOpens);`),
};

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/platform/linux/linuxUpdates.ts") && STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});

const { linuxUpdaterFor } = await import("./linuxUpdates.ts");

setConsentPeriod(true, "linux-updates-test");

const RELEASE_PAGE = "https://github.com/ardia-browser/ardia/releases/tag/v0.2.46";
const RELEASES = JSON.stringify([{ tag_name: "v0.2.46", html_url: RELEASE_PAGE, prerelease: false, draft: false, assets: [{ name: "Ardia-0.2.46-linux-x64.tar.xz" }] }]);
const FLATPAK_DATA = "/home/u/.var/app/dev.ardia.Ardia/config/ardia/config";
const PACKAGE_DATA = "/home/u/.config/ardia/config";

const managedHost = (configDirectory, windowId = "main") => ({
  bootstrap: { windowId, launchConfig: { configDirectory }, capabilities: ["ArdiaUpdates.releases", ...SELF_UPDATE_METHODS] },
  invoke: async (method) => {
    if (method === "ArdiaUpdates.status") return { phase: "idle", version: null, reason: null, kind: "managed", run: 0 };
    assert.equal(method, "ArdiaUpdates.releases");
    return { status: 200, body: RELEASES };
  },
});

const reset = () => {
  Object.assign(ui, { confirms: [], toasts: [], opened: [], copied: [], settingsOpens: true });
  ui.docs.clear();
  takeUpdateCounts();
};

for (const [manager, configDirectory] of [["Flatpak", FLATPAK_DATA], ["package", PACKAGE_DATA]]) {
  test(`Check for Updates on a ${manager} install opens the release page and copies nothing`, async () => {
    reset();
    await linuxUpdaterFor(managedHost(configDirectory)).methods.checkForUpdates();
    assert.equal(ui.confirms.length, 1);
    assert.deepEqual([ui.confirms[0].confirmTitle, ui.confirms[0].cancelTitle], ["Open Release Page", "Later"]);
    assert.doesNotMatch(ui.confirms[0].message, /flatpak update dev\.ardia\.Ardia/);
    assert.deepEqual([ui.opened, ui.copied], [[RELEASE_PAGE], []]);
    assert.equal(takeUpdateCounts().update_release_page_opens, 1);
  });

  test(`the automatic ${manager} offer's View opens the release page and copies nothing`, async () => {
    reset();
    await linuxUpdaterFor(managedHost(configDirectory)).check(false);
    assert.equal(ui.toasts.length, 1);
    assert.doesNotMatch(ui.toasts[0].message, /flatpak update/);
    assert.equal(ui.toasts[0].options.action.title, "View");
    assert.equal(ui.toasts[0].options.secondary.title, "Later");
    ui.toasts[0].options.action.run();
    assert.deepEqual([ui.opened, ui.copied], [[RELEASE_PAGE], []]);
    assert.equal(takeUpdateCounts().update_release_page_opens, 1);
  });
}

test("a Flatpak's dialog says flatpak update can't update a bundle installed from a file", async () => {
  reset();
  await linuxUpdaterFor(managedHost(FLATPAK_DATA)).methods.checkForUpdates();
  assert.match(ui.confirms[0].message, /installed from a \.flatpak file, which flatpak update can't update/);
  assert.match(ui.confirms[0].message, /install the new \.flatpak from its release page/);
});

test("from Settings with no regular window to open it in, Ardia says so and offers the link to copy, and counts no visit", async () => {
  reset();
  ui.settingsOpens = false;
  await linuxUpdaterFor(managedHost(FLATPAK_DATA, "settings")).methods.checkForUpdates();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.confirms.length, 2);
  assert.equal(ui.confirms[1].title, "Ardia couldn't open the release page");
  assert.match(ui.confirms[1].message, new RegExp(RELEASE_PAGE.replaceAll(".", "\\.")));
  assert.deepEqual([ui.confirms[1].confirmTitle, ui.confirms[1].cancelTitle], ["Copy Link", "OK"]);
  assert.deepEqual([ui.opened, ui.copied], [[], [RELEASE_PAGE]]);
  assert.equal(takeUpdateCounts().update_release_page_opens, 0);
});
