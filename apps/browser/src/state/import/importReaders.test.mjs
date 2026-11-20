import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listSources } from "../../../../../packages/import/src/readers/discovery.ts";
import { joinPath, parentPath } from "../../../../../packages/import/src/readers/host.ts";
import { importProfile, Unlocks } from "../../../../../packages/import/src/readers/importer.ts";
import { arcSidebarPath } from "../../../../../packages/import/src/readers/sidebars.ts";
import { fixtureHost } from "./fixtures/importHost.mjs";
import { HOME, posixHost } from "./fixtures/posixHost.mjs";
import { fakeHost } from "./fixtures/windowsHost.mjs";

const quiet = { progress() {}, cancelled: () => false };
const SECRETS = {
  logins: { items: [{ url: "https://login.example/", username: "ada", password: "pw" }], undecryptable: 1, appBound: 2 },
  cookies: { count: 7, undecryptable: 0, appBound: 3, dropped: 0, token: "a".repeat(32) },
  autofill: { addresses: 1, cards: 2, lockedCards: 1, undecryptable: 0, appBound: 0 },
  firefoxLogins: { items: [{ url: "https://fox.example/", username: "fox", password: "pw" }], undecryptable: 0, appBound: 0 },
  firefoxCookies: { count: 4, undecryptable: 0, appBound: 0, dropped: 0, skipped: 2 },
};

const relative = (host, path) => {
  const browser = [...host.browsers].sort((a, b) => b.dataDirectory.length - a.dataDirectory.length).find((b) => path.startsWith(b.dataDirectory));
  return browser ? `${browser.id}:${path.slice(browser.dataDirectory.length).replaceAll("\\", "/")}` : `outside:${path}`;
};
const secretFilesOf = (host) => host.secretFiles.map(([call, ...paths]) => [call, ...paths.map((p) => relative(host, p))]);

const pathFree = (value) =>
  JSON.parse(JSON.stringify(value, (key, v) => (key === "path" || key === "avatarPath" ? undefined : typeof v === "string" ? v.replaceAll("\\", "/") : v)));

test("A path joins with the host's own separator", () => {
  assert.equal(joinPath("\\", "C:\\Users\\a\\", "/Google/Chrome/", "Profiles/x.default"), "C:\\Users\\a\\Google\\Chrome\\Profiles\\x.default");
  assert.equal(joinPath("/", "/home/a/", "/.config/", "google-chrome", "", "."), "/home/a/.config/google-chrome");
  assert.equal(joinPath("/", "/home/a", "odd\\name"), "/home/a/odd\\name");
  assert.equal(joinPath("/", "/", "etc"), "/etc");
  assert.equal(parentPath({ separator: "/" }, "/home/a/Arc/User Data"), "/home/a/Arc");
  assert.equal(parentPath({ separator: "/" }, "/Arc"), "/");
  assert.equal(parentPath({ separator: "\\" }, "C:\\Arc\\User Data"), "C:\\Arc");
});

test("A POSIX host finds the same browsers, profiles and kinds as the Windows host", async () => {
  const windows = await listSources(fakeHost());
  const posix = await listSources(posixHost());
  assert.deepEqual(posix.map((s) => s.id).sort(), windows.map((s) => s.id).sort());
  assert.deepEqual(pathFree(posix).sort((a, b) => a.id.localeCompare(b.id)), pathFree(windows).sort((a, b) => a.id.localeCompare(b.id)));
  const chrome = posix.find((s) => s.id === "chrome").profiles.find((p) => p.id === "Default");
  assert.equal(chrome.path, `${HOME}/Google/Chrome/Default`);
  const firefox = posix.find((s) => s.id === "firefox").profiles.find((p) => p.id === "Profiles/abcd1234.default-release");
  assert.equal(firefox.path, `${HOME}/Firefox/Profiles/abcd1234.default-release`);
});

test("Every kind of every fixture profile reads the same through a POSIX host as through the Windows host, from the same files", async () => {
  const posixSources = await listSources(posixHost());
  const windowsSources = await listSources(fakeHost());
  let compared = 0;
  for (const source of posixSources) {
    const windowsProfiles = windowsSources.find((s) => s.id === source.id).profiles;
    assert.equal(windowsProfiles.length, source.profiles.length, source.id);
    for (const [i, profile] of source.profiles.entries()) {
      const twin = windowsProfiles[i];
      assert.equal(twin.id.replaceAll("\\", "/"), profile.id, `${source.id} ${profile.id}`);
      const posixRead = posixHost(SECRETS, "Windows");
      const windowsRead = fakeHost(SECRETS);
      const [posix, windows] = await Promise.all([
        importProfile(posixRead, new Unlocks(), source.id, profile.id, profile.available, {}, quiet),
        importProfile(windowsRead, new Unlocks(), source.id, twin.id, twin.available, {}, quiet),
      ]);
      assert.deepEqual(pathFree(posix), pathFree(windows), `${source.id} ${profile.id}`);
      assert.deepEqual(secretFilesOf(posixRead), secretFilesOf(windowsRead), `${source.id} ${profile.id}`);
      compared += profile.available.length;
    }
  }
  assert.ok(compared >= 40, `compared ${compared} kinds`);
});

test("Arc's sidebar files are read from the folder that holds its User Data", async () => {
  const host = posixHost();
  assert.equal(arcSidebarPath(host), `${HOME}/Arc/StorableSidebar.json`);
  const result = await importProfile(host, new Unlocks(), "arc", "Default", ["spaces", "linkRules", "archive"], {}, quiet);
  assert.deepEqual(result.failed, []);
  assert.ok(result.spaces.length > 0 && result.arcRouting.rules.length > 0);
  assert.ok(host.calls.some(([kind, folder, path]) => kind === "readTextWithin" && folder === `${HOME}/Arc` && path === `${HOME}/Arc/StorableSidebar.json`));
});

test("Secret counts and messages name the host's platform and the source browser", async () => {
  const host = posixHost(SECRETS);
  const result = await importProfile(host, new Unlocks(), "chrome", "Default", ["passwords", "cookies", "autofill", "favorites"], {}, quiet);
  const profile = `${HOME}/Google/Chrome/Default`;
  assert.deepEqual(host.secretFiles, [
    ["unlock", `${HOME}/Google/Chrome/Local State`],
    ["logins", `${profile}/Login Data`, `${profile}/Login Data For Account`],
    ["cookies", `${profile}/Network/Cookies`],
    ["autofill", `${profile}/Web Data`],
  ]);
  assert.equal(result.credentials.length, 1);
  assert.equal(result.cookieCount, 7);
  assert.equal(result.vaultToken, "a".repeat(32));
  const messages = result.warnings.map((w) => `${w.kind}: ${w.message}`);
  assert.ok(messages.includes("passwords: 1 password couldn't be decrypted"), messages.join("\n"));
  assert.ok(messages.includes("passwords: 2 passwords use Google Chrome's app-bound encryption, which only Google Chrome can read"), messages.join("\n"));
  assert.ok(messages.some((m) => /^cookies: Skipped 3 cookies locked by Google Chrome's app-bound encryption/.test(m)), messages.join("\n"));
  assert.ok(messages.includes("autofill: 1 saved card need Google Chrome's key, which Linux couldn't unwrap"), messages.join("\n"));
  assert.ok(messages.includes("favorites: Google Chrome has no favorites to import on Linux"), messages.join("\n"));
  assert.deepEqual(result.failed, ["favorites"]);
});

const scratch = mkdtempSync(join(tmpdir(), "import-readers-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function posixTree(files) {
  const root = mkdtempSync(join(scratch, "tree-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const onDisk = (path) => (path === root || path.startsWith(`${root}/`) ? path : null);
  const browsers = [
    { id: "chrome", name: "Google Chrome", family: "chromium", dataDirectory: `${root}/chrome` },
    { id: "firefox", name: "Firefox", family: "firefox", dataDirectory: `${root}/firefox` },
  ];
  return { root, host: fixtureHost({ platform: "Linux", separator: "/", browsers, onDisk, within: () => null }) };
}

test("On a POSIX host a colon or a backslash is part of a profile's folder name, and only absolute or .. paths are refused", async () => {
  const ini = (paths) => paths.map((path, i) => `[Profile${i}]\nName=p${i}\nIsRelative=1\nPath=${path}\n`).join("\n");
  const { root, host } = posixTree({
    "chrome/Local State": JSON.stringify({ profile: { info_cache: { "Profile 1:work": { name: "Work" }, "../outside": { name: "Out" } } } }),
    "chrome/Profile 1/Preferences": "{}",
    "chrome/Profile 1:work/Preferences": "{}",
    "outside/Preferences": "{}",
    "firefox/profiles.ini": ini(["Profiles/qa\\..\\work", "Profiles/plain", "/etc/abs", "../escape"]),
    "firefox/Profiles/qa\\..\\work/places.sqlite": "",
    "firefox/Profiles/plain/places.sqlite": "",
    "escape/places.sqlite": "",
    "firefox/etc/abs/places.sqlite": "",
  });
  const sources = await listSources(host);
  const chrome = sources.find((s) => s.id === "chrome");
  assert.deepEqual(chrome.profiles.map((p) => [p.id, p.path]).sort(), [["Profile 1", `${root}/chrome/Profile 1`], ["Profile 1:work", `${root}/chrome/Profile 1:work`]]);
  const firefox = sources.find((s) => s.id === "firefox");
  assert.deepEqual(firefox.profiles.map((p) => p.path).sort(), [`${root}/firefox/Profiles/plain`, `${root}/firefox/Profiles/qa\\..\\work`]);
});
