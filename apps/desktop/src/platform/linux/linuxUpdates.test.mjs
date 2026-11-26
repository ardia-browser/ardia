import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { SELF_UPDATE_METHODS } from "../../hostCapabilities.ts";
import { takeUpdateCounts } from "../../../../browser/src/state/telemetry/updateCounts.ts";
import { setConsentPeriod } from "../../../../browser/src/state/telemetry/consentPeriod.ts";

const ui = { confirms: [], toasts: [], opened: [], copied: [], settingsOpens: true, manager: null, markerReads: 0, docs: new Map() };
globalThis.__linuxUpdatesUi = ui;

const stub = (source) => `data:text/javascript,${encodeURIComponent(`const ui = globalThis.__linuxUpdatesUi;\n${source}`)}`;
const STUBS = {
  "../../session.ts": stub(`export const isLinuxUtility = (id) => id === "settings";`),
  "../../shims/shellBase": stub(`export const refreshDocument = async () => {};`),
  "../../../../browser/src/platform/app": stub(`export const systemInfo = () => ({ appVersion: "0.2.45" });`),
  "../../../../browser/src/platform/clipboard": stub(`export const copyText = (text) => void ui.copied.push(["text", text]); export const copyAddress = (url) => void ui.copied.push(["address", url]);`),
  "../../../../browser/src/platform/dialogs": stub(`export const confirm = async (options) => (ui.confirms.push(options), { confirmed: true });`),
  "../../../../browser/src/platform/documents": stub(`export const readDocument = (name) => ui.docs.get(name) ?? null; export const saveDocument = async (name, contents) => void ui.docs.set(name, contents);`),
  "../../../../browser/src/state/app/toasts": stub(`export const showToast = (windowId, title, message, options) => void ui.toasts.push({ windowId, title, message, options });`),
  "../../../../browser/src/state/browser/actions": stub(`export const openUrls = (urls) => void ui.opened.push(...urls);`),
  "../../../../browser/src/state/settings/settingsWindows": stub(`export const openUrlFromSettings = (url) => (ui.settingsOpens && ui.opened.push(url), ui.settingsOpens);`),
};

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/platform/linux/linuxUpdates.ts") && specifier === "chrome://ardia/package-manager.js") {
      ui.markerReads += 1;
      if (ui.manager === null) throw new Error("chrome://ardia/package-manager.js: 404");
      return { url: `data:text/javascript,export default ${encodeURIComponent(JSON.stringify(ui.manager))};`, shortCircuit: true };
    }
    if (context.parentURL?.endsWith("/platform/linux/linuxUpdates.ts") && STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
    return next(specifier, context);
  },
});

const { linuxUpdaterFor } = await import("./linuxUpdates.ts");

setConsentPeriod(true, "linux-updates-test");

const RELEASE_PAGE = "https://github.com/ardia-browser/ardia/releases/tag/v0.2.46";
const RELEASES = JSON.stringify([{ tag_name: "v0.2.46", html_url: RELEASE_PAGE, prerelease: false, draft: false, assets: [{ name: "Ardia-0.2.46-linux-x64.tar.xz" }] }]);
const managedHost = (windowId = "main") => ({
  bootstrap: { windowId, launchConfig: { configDirectory: "/home/u/.config/ardia/config" }, capabilities: ["ArdiaUpdates.releases", ...SELF_UPDATE_METHODS] },
  invoke: async (method) => {
    if (method === "ArdiaUpdates.status") return { phase: "idle", version: null, reason: null, kind: "managed", run: 0 };
    assert.equal(method, "ArdiaUpdates.releases");
    return { status: 200, body: RELEASES };
  },
});

const reset = (manager) => {
  Object.assign(ui, { confirms: [], toasts: [], opened: [], copied: [], settingsOpens: true, manager, markerReads: 0 });
  ui.docs.clear();
  takeUpdateCounts();
};

const RELEASE_PAGE_MANAGERS = [
  ["an Arch", "pacman", /This Arch package was built from its source package, and ardia-bin isn't on the AUR yet: download the new ardia-bin source package from its release page and build it with makepkg -si\./, /^Build the new ardia-bin package from its release page\.$/],
  ["rpm", "rpm", /installed from a downloaded file, so dnf and zypper have no repository to update it from: install the new \.rpm from its release page/, /^Install the new \.rpm from its release page\.$/],
  ["flatpak", "flatpak", /installed from a \.flatpak file, which flatpak update can't update: install the new \.flatpak from its release page/, /^Install the new \.flatpak from its release page\.$/],
  ["an unmarked package", null, /Another package manager installed Ardia, so update it there, or download the new version from its release page/, /^Update it with your package manager, or download it from its release page\.$/],
  ["an unknown marker", "dpkg", /Another package manager installed Ardia/, /^Update it with your package manager/],
];

for (const [label, manager, dialog, toast] of RELEASE_PAGE_MANAGERS) {
  test(`Check for Updates on ${label} install opens the release page and copies nothing`, async () => {
    reset(manager);
    await linuxUpdaterFor(managedHost()).methods.checkForUpdates();
    assert.equal(ui.confirms.length, 1);
    assert.deepEqual([ui.confirms[0].confirmTitle, ui.confirms[0].cancelTitle], ["Open Release Page", "Later"]);
    assert.match(ui.confirms[0].message, dialog);
    assert.doesNotMatch(ui.confirms[0].message, /yay|flatpak update dev\.ardia\.Ardia/);
    assert.deepEqual([ui.opened, ui.copied], [[RELEASE_PAGE], []]);
    const counts = takeUpdateCounts();
    assert.deepEqual([counts.update_release_page_opens, ui.toasts], [1, []]);
  });

  test(`the automatic offer on ${label} install says what to do, and its View opens the release page`, async () => {
    reset(manager);
    await linuxUpdaterFor(managedHost()).check(false);
    assert.equal(ui.toasts.length, 1);
    assert.match(ui.toasts[0].message, toast);
    assert.deepEqual([ui.toasts[0].options.action.title, ui.toasts[0].options.secondary.title], ["View", "Later"]);
    ui.toasts[0].options.action.run();
    assert.deepEqual([ui.opened, ui.copied], [[RELEASE_PAGE], []]);
    assert.equal(takeUpdateCounts().update_release_page_opens, 1);
  });
}

test("the marker is read once per window", async () => {
  reset("rpm");
  const updater = linuxUpdaterFor(managedHost());
  await updater.methods.checkForUpdates();
  await updater.methods.checkForUpdates();
  assert.equal(ui.markerReads, 1);
});

test("from Settings with no regular window to open it in, Ardia says so and offers the link to copy, and counts no visit", async () => {
  reset("flatpak");
  ui.settingsOpens = false;
  await linuxUpdaterFor(managedHost("settings")).methods.checkForUpdates();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.confirms.length, 2);
  assert.equal(ui.confirms[1].title, "Ardia couldn't open the release page");
  assert.match(ui.confirms[1].message, new RegExp(RELEASE_PAGE.replaceAll(".", "\\.")));
  assert.deepEqual([ui.confirms[1].confirmTitle, ui.confirms[1].cancelTitle], ["Copy Link", "OK"]);
  assert.deepEqual([ui.opened, ui.copied], [[], [["address", RELEASE_PAGE]]]);
  assert.equal(takeUpdateCounts().update_release_page_opens, 0);
});
