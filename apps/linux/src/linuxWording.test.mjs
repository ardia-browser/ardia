import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LINUX_WORDING, linuxWording, rewordForLinux } from "../linuxWording.ts";
import { CREDENTIAL_WORDING, credentialWording, rewordCredentials } from "../credentialWording.ts";
import { CALENDAR_WORDING, calendarWording, rewordCalendar } from "../calendarWording.ts";
import { SYNC_WORDING, rewordSync, syncWording } from "../syncWording.ts";
import { WEB_ENGINE_SETTINGS, unavailableSettingIds } from "./hostCapabilities.ts";
import { linuxShortcutText } from "../shortcutText.ts";
import { PLATFORM_FEATURES as LINUX_FEATURES } from "../../browser/src/lib/platformFeatures.linux.ts";
import { PLATFORM_TERMS as LINUX_TERMS } from "../../browser/src/lib/platformTerms.linux.ts";

const shared = (path) => fileURLToPath(new URL(`../../browser/src/${path}`, import.meta.url));
const read = (path) => readFileSync(shared(path), "utf8");
const strings = (code) => [...code.matchAll(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((match) => match[0]);
const whole = (code) => [code];
const PIPELINE = [rewordCredentials, rewordForLinux, rewordCalendar, rewordSync];
const linuxCopy = (path) => {
  const source = read(path);
  const start = path.startsWith("components/") && !path.endsWith("/settings/searchMatch.ts") ? linuxShortcutText(source) : source;
  return withLinuxTerms(PIPELINE.reduce((code, reword) => reword(shared(path), code) ?? code, start));
};
const withLinuxTerms = (code) => code.replace(/\$?\{PLATFORM_TERMS\.(\w+)\}/g, (_match, key) => {
  assert.equal(typeof LINUX_TERMS[key], "string", `platformTerms.linux.ts has no ${key}`);
  return LINUX_TERMS[key];
});

const MODULES = [
  { name: "calendar", list: CALENDAR_WORDING, reword: rewordCalendar, plugin: calendarWording, pick: whole, macos: /System Settings|Privacy & Security|x-apple|Calendar app/, surfaces: CALENDAR_WORDING.map((entry) => entry.file), probe: "components/settings/panes/CalendarSection.tsx" },
  { name: "credential", list: CREDENTIAL_WORDING, reword: rewordCredentials, plugin: credentialWording, pick: whole, macos: /\bMac\b|macOS|Keychain|Touch ID|Applications folder|\{PLATFORM_TERMS\.\w+\}/, surfaces: ["components/settings/panes/ProfilePasswords.tsx", "components/settings/panes/ProfileAutofill.tsx"], probe: "components/settings/panes/ProfilePasswords.tsx" },
  { name: "sync", list: SYNC_WORDING, reword: rewordSync, plugin: syncWording, pick: whole, macos: /\bMacs?\b|iCloud Drive|iCloud Settings|in Finder|iPhone|Universal Clipboard|Keychain|x-apple\.|\bUsers\b|\{PLATFORM_TERMS\.\w+\}/, surfaces: ["components/settings/panes/SyncSection.tsx", "components/settings/panes/SyncSheets.tsx"], probe: "components/settings/panes/SyncSection.tsx" },
  {
    name: "linux", list: LINUX_WORDING, reword: rewordForLinux, plugin: linuxWording, pick: strings, macos: /\bMacs?\b|macOS|iCloud|Keychain|keychain|Tahoe|\{PLATFORM_TERMS\.\w+\}/, probe: "components/onboarding/LookStep.tsx",
    surfaces: ["state/extensions/actions.ts", "components/onboarding/SourceStep.tsx", "components/onboarding/LookStep.tsx", "components/settings/panes/General.tsx", "state/telemetry/copy.ts", "components/import/steps/ChooseStep.tsx", "components/import/steps/SafariStep.tsx", "state/import/runImport.ts", "components/onboarding/previews/MockWindow.tsx", "components/onboarding/previews/scenes/LookScenes.tsx", "state/commands/appCommands.ts", "state/report/details.ts", "components/report/ReportPreview.tsx"],
  },
];

const section = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
const EXPECTED = [
  ["components/settings/panes/CalendarSection.tsx", ["<Button title=\"Try Again\" onPress={() => void connectCalendar()} />", "Ardia reads your calendars through Evolution Data Server, which isn't running", "Evolution Data Server refused to share your calendars"], []],
  ["components/settings/panes/ProfilePasswords.tsx", ["system password"], []],
  ["components/settings/panes/SyncSection.tsx", ["End-to-end encrypted through a synced folder you choose.", "like one that Syncthing, Nextcloud or Dropbox keeps in sync", "title: \"Open Sync Folder\""], ["Linking.openURL", "Open iCloud Settings"]],
  ["components/settings/panes/SyncSheets.tsx", ["title={`Add to This Computer`}", "system keyring", "return folder.path.replace(/^\\/home\\/[^/]+(?=\\/|$)/, \"~\");", "<Button title=\"Save as Text…\" kind=\"primary\" onPress={() => void save(\"text\")} />", "<Button title=\"Copy Words\" onPress={() => void copyRecoveryPhrase()} />"], ["recoveryKitPreview(", "copyRecoveryKit()", "shareRecoveryKit()", "save(\"pdf\")", "title=\"Other Options\""]],
  ["lib/themeLook.ts", ["export const MONO_FAMILY = \"monospace\";"], ["export const MONO_FAMILY = \"Menlo\";"]],
  ["state/sync/syncDoc.ts", ["never removes them from this computer"], []],
  ["components/settings/panes/SyncSection.tsx", ["(This Computer)", "Just this computer so far", "Add them to this computer."], []],
  ["components/settings/panes/SyncSheets.tsx", ["This Computer Is Syncing", "Add them to this computer to sync", "Everything on this computer stays as it is."], []],
  ["state/sync/engine.ts", ["keep syncing on this device", "Couldn't save the sync key in your keyring."], []],
  ["components/onboarding/SourceStep.tsx", ["Found on this computer"], []],
  ["state/import/runImport.ts", ["system keyring"], []],
  ["state/extensions/actions.ts", ["`The extension's folder stays on your computer.`"], ["stays on your ${PLATFORM_TERMS.computer}"]],
  ["state/live/engine.ts", ["case \"keyringLocked\":\n      return `Unlock your keyring to refresh ${name}`;", "case \"keyringUnavailable\":\n      return `Start your keyring to refresh ${name}`;", "case \"signedOut\":\n      return `Sign back in to ${name}`;"], []],
  ["components/settings/panes/General.tsx", ["label: \"Quitting with Ctrl+Shift+Q\""], ["Quitting with ${keyText(\"⌘Q\")}"]],
  ["components/settings/rows/shortcutRows.ts", ["title: `Ctrl-clicking links creates tab groups`"], []],
  ["components/settings/rows/profileRows.ts", ["description: \"Showing a saved card number asks for your system password.\"", "\"keyring\""], ["\"keychain\""]],
  ["components/settings/panes/ProfileAutofill.tsx", ["encrypted by Chromium with a key from your system keyring", "\"Its saved number is deleted too.\""], []],
  ["components/settings/panes/Shortcuts.tsx", ["title: `Shift-click`", "title: `Alt-click`", "title: `Alt+Shift-click`", "`Alt-click (Peek moves to Shift-click)`", "`Alt-click (split view moves to Alt+Shift-click)`", "`Alt-click opens a split now: choosing it here moves split view back to Alt+Shift-click.`"], []],
  ["components/onboarding/LayoutSteps.tsx", ["title: `Shift-click`"], []],
  ["components/settings/rows/appearanceRows.ts", ["Below the toolbar. Ctrl+Shift+B toggles it.", "no toolbar. Ctrl+Super+M toggles it."], ["⇧⌘B", "⌃⌘M"]],
  ["components/settings/panes/Advanced.tsx", ["or in power saver mode"], ["${PLATFORM_TERMS.lowPowerMode}"]],
  ["components/downloads/Downloads.tsx", ["tooltip=\"Show in Folder\""], ["Show in ${PLATFORM_TERMS.fileManager}"]],
  ["components/pages/DownloadsPage.tsx", ["title=\"Show in Folder\""], ["Show in ${PLATFORM_TERMS.fileManager}"]],
  ["state/downloads/downloadMenu.ts", ["title: \"Show in Folder\""], ["Show in ${PLATFORM_TERMS.fileManager}"]],
  ["state/bookmarks/exportHtml.ts", ["title: \"Show in Folder\""], ["Show in ${PLATFORM_TERMS.fileManager}"]],
  ["state/browser/actions.ts", ["stay installed on this computer, turned off."], ["on this ${PLATFORM_TERMS.computer}"]],
  ["state/onboarding/tour.ts", ["Ctrl+S hides the sidebar.", "press Super+Shift+=.", "Settings (Ctrl+,)."], ["menu bar", "⌘"]],
  ["state/presets/setupCode.ts", ["Appearance follows your desktop", "Ctrl+T opens the command bar"], ["your ${PLATFORM_TERMS.computer}", "⌘T"]],
  ["state/releaseNotes/releaseNotes.ts", ["from any page with Ctrl+L."], ["⌘L"]],
  ["state/sync/scopeAdapters.ts", ["`This Computer`"], ["This ${PLATFORM_TERMS.computerTitle}"]],
  ["components/import/steps/ChooseStep.tsx", ["were found on this computer."], []],
  ["state/telemetry/copy.ts", ["Ctrl+Tab switcher", "Alt+Enter in the command bar", "from the taskbar or at launch", "the crash dump Chromium's crash handler keeps on this computer", "the signal that ended it", "reached Ardia's page script, summed up once an hour. Never the notification's text"], ["Dock", "Touch ID", "⌘", "⌥", "⌃", "from this app's crash report", "code-signing kill", "writable memory regions", "the error code the system gave"]],
  ["state/report/details.ts", ["`Linux ${app.osVersion}`, app.model"], ["`${PLATFORM_TERMS.os} ${app.osVersion}`"]],
  ["components/report/ReportPreview.tsx", ["Exactly what leaves your computer when you press Send."], ["leaves your ${PLATFORM_TERMS.computer}"]],
  ["components/report/ReportSheet.tsx", ["Contact and details stay private.", "share errors and usage for 14 days"], ["Recordings, contact and details stay private.", "share crash reports and usage"]],
  ["components/report/AttachedRow.tsx", ["title: \"Usage and errors, last 7 days\""], ["Usage, errors and crashes, last 7 days"]],
  ["components/tabstrip/NewTabButton.tsx", ["Alt-click to open in Split View"], ["${keyText(\"⌥\")}-click"]],
];

test("every listed replacement matches its shared source exactly once", () => {
  for (const { name, list } of MODULES) {
    for (const { file, replacements } of list) {
      const source = read(file);
      for (const [from] of replacements) assert.equal(source.split(from).length, 2, `${name}: ${file} has ${source.split(from).length - 1} of ${JSON.stringify(from.slice(0, 60))}`);
    }
  }
});

test("every listed surface had macOS copy and loses it after the Linux pipeline", () => {
  for (const { name, macos, pick, surfaces } of MODULES) {
    for (const path of surfaces) {
      assert.ok(pick(read(path)).some((text) => macos.test(text)), `${name}: ${path} has no macOS copy left to reword`);
      assert.deepEqual(pick(linuxCopy(path)).flatMap((text) => text.match(macos) ?? []), [], `${name}: ${path}`);
    }
  }
});

test("the reworded copy says what Linux does and drops what it can't do", () => {
  for (const [path, has, lacks] of EXPECTED) {
    const copy = linuxCopy(path);
    for (const text of has) assert.ok(copy.includes(text), `${path} lacks ${text}`);
    for (const text of lacks) assert.ok(read(path).includes(text) && !copy.includes(text), `${path} keeps ${text}`);
  }
});

test("search rows describing reworded panes read as Linux too", () => {
  const general = linuxCopy("components/settings/rows/generalRows.ts");
  const rows = read("components/settings/rows/generalRows.ts");
  assert.match(section(rows, "        sync: {", "section: \"Updates\""), /\bmacs\b|icloud/);
  assert.doesNotMatch(section(general, "        sync: {", "section: \"Updates\""), /\bMacs?\b|icloud/i);
  const profile = read("components/settings/rows/profileRows.ts");
  assert.match(section(profile, "section: \"Passwords and autofill\"", "savedCards: {"), /keychain|PLATFORM_TERMS\.deviceUnlock/);
  assert.doesNotMatch(section(linuxCopy("components/settings/rows/profileRows.ts"), "section: \"Passwords and autofill\"", "savedCards: {"), /Touch ID|keychain|Keychain|\bMac\b/);
});

test("open-tab sync telemetry describes this computer on Linux", () => {
  const copy = linuxCopy("state/telemetry/copy.ts");
  assert.match(copy, /how many tab changes this computer sent,/);
  assert.doesNotMatch(copy, /\bMacs?\b/);
});

test("a shared copy change fails with 'no longer contains', and unlisted files pass through", () => {
  for (const { name, reword, probe } of MODULES) {
    assert.throws(() => reword(shared(probe), "export const nothing = 1;"), /no longer contains/, name);
    assert.equal(reword(shared("components/settings/panes/Checklist.tsx"), "const x = 'Mac';"), null, name);
  }
});

test("a production build fails when a listed file was loaded but never reworded", () => {
  const context = { error(message) { throw new Error(message); } };
  for (const { name, list, plugin } of MODULES) {
    const run = (command, files, modules = files.map(shared), error) => {
      const instance = plugin();
      instance.configResolved({ command });
      for (const file of files) instance.transform.call(context, read(file), shared(file));
      return () => instance.buildEnd.call({ ...context, getModuleIds: () => [...modules].values() }, error);
    };
    const all = list.map((entry) => entry.file);
    const dropped = all.at(-1);
    assert.doesNotThrow(run("build", all), name);
    assert.throws(run("build", all.slice(0, -1), all.map(shared)), (error) => error.message.includes("never reworded") && error.message.includes(dropped), name);
    assert.doesNotThrow(run("serve", [], all.map(shared)), name);
    assert.doesNotThrow(run("build", [], [shared("components/site/SiteControls.tsx")]), name);
    assert.doesNotThrow(run("build", [], all.map(shared), new Error("earlier failure")), name);
  }
});

const componentFiles = (dir) => readdirSync(new URL(`../../browser/src/${dir}`, import.meta.url), { recursive: true })
  .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
  .map((file) => `${dir}/${file}`);

test("shortcut glyphs become Linux key names without stray '+-' click modifiers", () => {
  assert.equal(linuxShortcutText(`"⇧⌘S" "⌘Z" "⌥⌘I" "⌃⇧Tab"`), `"Ctrl+Shift+S" "Ctrl+Z" "Ctrl+Alt+I" "Super+Shift+Tab"`);
  const stray = componentFiles("components").filter((path) => (linuxCopy(path).match(/\+-[a-z]/g) ?? []).length > (read(path).match(/\+-[a-z]/g) ?? []).length);
  assert.deepEqual(stray, []);
});

test("onboarding names no Mac, macOS or Dock on Linux, and the Web engine rows are not offered without WebKit", () => {
  const words = /\bMacs?\b|macOS|\bDock\b|iCloud|Keychain/;
  const leftover = componentFiles("components/onboarding")
    .flatMap((path) => strings(linuxCopy(path)).filter((text) => words.test(text)).map((text) => `${path}: ${text}`));
  assert.deepEqual(leftover, []);
  const hidden = unavailableSettingIds({ webkit: false }, [...WEB_ENGINE_SETTINGS]);
  assert.ok(WEB_ENGINE_SETTINGS.every((id) => hidden.has(id)));
});

test("the Linux platform layer finds browsers through the import list and says computer, not Mac", async () => {
  const { sourceTiles } = await import("../../browser/src/components/onboarding/sourceTiles.ts");
  const listed = new Set(["chrome", "firefox"]);
  const tiles = sourceTiles((candidate) => listed.has(candidate.importId ?? candidate.id), LINUX_FEATURES);
  assert.deepEqual(tiles.filter((tile) => tile.found).map((tile) => tile.id), ["chrome", "firefox"]);
  assert.ok(tiles.every((tile) => tile.app === null && tile.id !== "safari" && tile.id !== "dia"));
  assert.equal(LINUX_FEATURES.calendar && LINUX_FEATURES.sync && !LINUX_FEATURES.webKit && !LINUX_FEATURES.dock, true);
  assert.deepEqual(Object.values(LINUX_TERMS).filter((value) => typeof value === "string" && /\bMacs?\b|macOS|iCloud|Keychain|Finder/.test(value)), []);
  const vite = readFileSync(new URL("../vite.shared.ts", import.meta.url), "utf8");
  assert.match(vite, /extensions: \["\.linux\.tsx", "\.linux\.ts", "\.web\.tsx"/);
});

test("Linux's What's Sent, after its source wording, says nothing about freezes", () => {
  const said = strings(linuxCopy("state/telemetry/copy.ts")).join("\n");
  for (const freeze of ["stopped responding for a quarter of a second", "freezes for 0.4 seconds or more", "program addresses", "the last 20 times Ardia froze", "Copy Last Freeze"]) assert.ok(!said.includes(freeze), freeze);
  assert.ok(said.includes("How many times a page stopped responding"), "page hangs are counted on Linux too");
  assert.equal(LINUX_FEATURES.freezeWatch, false);
});
