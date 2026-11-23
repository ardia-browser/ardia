import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
globalThis.require = createRequire(import.meta.url);
globalThis.__DEV__ = false;

const CHROME_DEFAULT = { folder: "/Users/someone/Downloads", askWhereToSave: false, managed: false };
const LOAD_MS = 15;
let engine;
let loads;
let writes;
let reads;

const answer = (verb, profile, args) => {
  if (verb !== "settings" && verb !== "setSettings") return null;
  const current = engine.get(profile) ?? CHROME_DEFAULT;
  if (verb === "settings") {
    reads.push(profile);
    return current;
  }
  if (current.managed) throw Object.assign(new Error("downloads are set by policy"), { code: "ERR_ENGINE" });
  const next = { ...current, ...args };
  engine.set(profile, next);
  writes.push(profile);
  return next;
};

globalThis.acTestNativeModules = {
  ArdiaDownloads: {
    call: (verb, profile, json) => {
      if (!loads.has(profile)) loads.set(profile, profile ? sleep(LOAD_MS) : Promise.resolve());
      return loads.get(profile).then(() => JSON.stringify(answer(verb, profile, JSON.parse(json))));
    },
    addListener: () => ({ remove() {} }),
  },
  ArdiaImport: {
    addListener: () => ({ remove() {} }),
    cancelImport() {},
    forgetUnlockedKeys() {},
    isBrowserUnlocked: () => true,
    listExtensions: async () => "[]",
    importData: async (_job, browserId, profileId) =>
      JSON.stringify({ browserId, profileId, history: [], historyCount: 0, tabs: [], tabGroups: [], credentials: [], cookieCount: 0, addressCount: 0, cardCount: 0, spaces: [], favorites: [], favicons: [], failed: [], warnings: [] }),
  },
};

const stub = await import("../../test-native/index.ts");
globalThis.fetch = async () => ({ status: 200 });
const client = await import("../telemetry/client.ts");
const usage = await import("../telemetry/usage.ts");
const { takeDownloadFolderCounts } = await import("../telemetry/downloadFolderCounts.ts");
const { useBrowser } = await import("../browser/store.ts");
const { engineProfile } = await import("../browser/model.ts");
const { engineProfiles } = await import("../profiles/engineProfiles.ts");
const { setDownloadsFor, setSeparateDownloadFolders, downloadSettings, separateIfFoldersDiffer } = await import("../settings/paneData.ts");
const { addLinkedProfile } = await import("../sync/profileLinks.ts");
const { patchImport } = await import("../import/flow.ts");
const { runImport } = await import("../import/runImport.ts");
const { createProfile } = await import("../profiles/actions.ts");
const { cached, load } = await import("../settings/resources.ts");
const { DOWNLOAD_METHODS } = await import("../automation/socketDownloads.ts");

const S = () => useBrowser.getState();
const engineOf = (id) => engineProfile(S(), id);
const automation = (name) => DOWNLOAD_METHODS.find((method) => method.name === name);
const socketCall = { stillServing() {} };
const shareTwo = async () => {
  const work = createProfile({ name: "Work" });
  await settled();
  return work;
};
const threeApart = async () => {
  const made = ["Work", "Side"].map((name) => createProfile({ name }));
  await settled();
  S().updateSettings({ separateDownloadFolders: true });
  for (const id of made) await setDownloadsFor({ folder: `/Users/someone/${S().profiles[id].name}`, askWhereToSave: false }, [engineOf(id)]);
  writes = [];
  return made;
};
const holdRead = (profile) => {
  const held = Promise.withResolvers();
  loads.set(profile, held.promise);
  return held;
};
const settled = () => sleep(LOAD_MS * 4);
const savesTo = async (id) => {
  await settled();
  const { folder, askWhereToSave } = engine.get(engineOf(id)) ?? CHROME_DEFAULT;
  return { folder, askWhereToSave };
};
const SHARED = { folder: "/Users/someone/Shared Downloads", askWhereToSave: true };
const UNTOUCHED = { folder: CHROME_DEFAULT.folder, askWhereToSave: false };

after(() => client.setSharing(false, "settings"));

beforeEach(async () => {
  engine = new Map();
  loads = new Map();
  writes = [];
  reads = [];
  S().hydrate({});
  assert.equal(S().settings.separateDownloadFolders, false);
  await setDownloadsFor(SHARED, engineProfiles(S()));
  writes = [];
  takeDownloadFolderCounts();
});

test("a new profile saves to the folder every profile shares, and asks as they do", async () => {
  const work = createProfile({ name: "Work" });
  assert.deepEqual(await savesTo(work), SHARED);
});

test("a profile that arrives by sync gets the shared folder", async () => {
  const doc = { scopes: {}, profiles: {}, setupAt: null, joining: false };
  const work = addLinkedProfile(doc, "remote-work", { n: "Work", c: "red", i: null }, null);
  assert.deepEqual(await savesTo(work), SHARED);
});

test("a profile made by an import gets the shared folder", async () => {
  const profile = (id, name) => ({ id, name, path: `/chrome/${id}`, isDefault: id === "Default", available: ["history"], spaces: [] });
  const source = { id: "chrome", name: "Chrome", family: "chromium", requiresExport: false, needsKeychain: false, profiles: [profile("Default", "Default"), profile("Profile 1", "Imported")] };
  patchImport({ source, sourceProfiles: ["Default", "Profile 1"], spaces: [], target: "default", kinds: new Set(["history"]) });
  await runImport(new Set(["history"]));
  const imported = S().profileOrder.find((id) => S().profiles[id].name === "Imported");
  assert.ok(imported, "the import made a profile");
  assert.deepEqual(await savesTo(imported), SHARED);
});

test("several profiles made at once all get the shared folder", async () => {
  const made = ["One", "Two", "Three"].map((name) => createProfile({ name }));
  await separateIfFoldersDiffer(engineProfiles(S()), () => true);
  assert.equal(S().settings.separateDownloadFolders, false);
  for (const id of made) assert.deepEqual(await savesTo(id), SHARED);
});

test("the shared folder is the default profile's, whichever profile that is", async () => {
  const work = createProfile({ name: "Work" });
  await settled();
  const own = { folder: "/Users/someone/Work Downloads", askWhereToSave: false };
  await setDownloadsFor(own, [engineOf(work)]);
  S().setDefaultProfile(work);
  assert.deepEqual(await savesTo(createProfile({ name: "Side" })), own);
});

test("the shared folder follows a default profile that was itself just made", async () => {
  S().setDefaultProfile(createProfile({ name: "Work" }));
  assert.deepEqual(await savesTo(createProfile({ name: "Side" })), SHARED);
});

test("with a folder for each profile, a new profile keeps Chrome's", async () => {
  S().updateSettings({ separateDownloadFolders: true });
  const work = createProfile({ name: "Work" });
  assert.deepEqual(await savesTo(work), UNTOUCHED);
  assert.deepEqual(writes, []);
});

test("turning on a folder for each profile before the copy lands leaves the new profile alone", async () => {
  const work = createProfile({ name: "Work" });
  S().updateSettings({ separateDownloadFolders: true });
  assert.deepEqual(await savesTo(work), UNTOUCHED);
});

test("a folder chosen while the new profile loads wins over the one it was made with", async () => {
  const work = createProfile({ name: "Work" });
  await sleep(1);
  const chosen = { folder: "/Users/someone/Chosen", askWhereToSave: false };
  await setDownloadsFor(chosen, engineProfiles(S()));
  assert.deepEqual(await savesTo(work), chosen);
});

test("a folder chosen in the same moment a profile is made wins", async () => {
  const work = createProfile({ name: "Work" });
  await Promise.resolve();
  const chosen = { folder: "/Users/someone/Chosen", askWhereToSave: false };
  await setDownloadsFor(chosen, engineProfiles(S()));
  assert.deepEqual(await savesTo(work), chosen);
});

test("automation reads the shared folder right after making a profile", async () => {
  const work = createProfile({ name: "Work" });
  const read = await automation("downloads.settings").run({ profile: work }, socketCall);
  assert.deepEqual({ folder: read.folder, askWhereToSave: read.askWhereToSave }, SHARED);
});

test("a folder automation sets right after making a profile is kept", async () => {
  const work = createProfile({ name: "Work" });
  await automation("downloads.setSettings").run({ profile: work, folder: "/Users/someone/Scripted" }, socketCall);
  assert.equal((await savesTo(work)).folder, "/Users/someone/Scripted");
});

test("a profile that shares another's data is never written to", async () => {
  createProfile({ name: "Shares", shareWith: "default" });
  await settled();
  assert.deepEqual(writes, []);
});

test("a profile deleted before the copy lands is never loaded for it", async () => {
  const work = createProfile({ name: "Work" });
  const workEngine = engineOf(work);
  S().deleteProfile(work);
  await settled();
  assert.equal(loads.has(workEngine), false);
});

test("a folder set by policy isn't copied as a choice", async () => {
  engine.set("", { ...CHROME_DEFAULT, ...SHARED, managed: true });
  const work = createProfile({ name: "Work" });
  await settled();
  assert.equal(loads.has(engineOf(work)), false);
});

test("a refused copy doesn't stop the next profile's", async () => {
  const work = createProfile({ name: "Work" });
  engine.set(engineOf(work), { ...CHROME_DEFAULT, managed: true });
  const side = createProfile({ name: "Side" });
  assert.deepEqual(await savesTo(side), SHARED);
});

test("opening General after a new profile keeps Separate folder for each profile off and unchosen", async () => {
  createProfile({ name: "Work" });
  await separateIfFoldersDiffer(engineProfiles(S()), () => true);
  assert.equal(S().settings.separateDownloadFolders, false);
  assert.equal(S().settingsMeta.chosen.includes("separateDownloadFolders"), false);
});

test("folders set apart on purpose still turn Separate folder for each profile on, only while General shows", async () => {
  const work = createProfile({ name: "Work" });
  await settled();
  await setDownloadsFor({ folder: "/Users/someone/Work Downloads" }, [engineOf(work)]);
  await separateIfFoldersDiffer(engineProfiles(S()), () => false);
  assert.equal(S().settings.separateDownloadFolders, false);
  await separateIfFoldersDiffer(engineProfiles(S()), () => true);
  assert.equal(S().settings.separateDownloadFolders, true);
});

async function oneOfEach() {
  const work = createProfile({ name: "Work" });
  await settled();
  const refused = createProfile({ name: "Refused" });
  engine.set(engineOf(refused), { ...CHROME_DEFAULT, managed: true });
  await settled();
  await separateIfFoldersDiffer([engineOf(work), engineOf(refused)], () => true);
}

test("a copy, a failed copy and the switch turning on by itself are sent in usage_counts while sharing is on", async () => {
  client.setSharing(true, "onboarding");
  await oneOfEach();
  usage.emitWindowUsage(client.consentToken());
  await client.saveQueueNow();
  const sent = JSON.parse(stub.docs.get("telemetry-queue.json") ?? '{"events":[]}').events.filter((e) => e.event === "usage_counts").at(-1)?.properties;
  assert.equal(sent?.new_profile_downloads_shared, 1);
  assert.equal(sent?.new_profile_downloads_share_failed, 1);
  assert.equal(sent?.download_folders_found_separate, 1);
});

test("none of them is counted with sharing off", async () => {
  client.setSharing(false, "settings");
  await oneOfEach();
  assert.ok(Object.values(takeDownloadFolderCounts()).every((n) => n === 0));
});

test("a copy that began before sharing went on isn't counted", async () => {
  client.setSharing(false, "settings");
  createProfile({ name: "Work" });
  client.setSharing(true, "onboarding");
  await settled();
  assert.equal(takeDownloadFolderCounts().new_profile_downloads_shared, 0);
});

test("deleting the default profile before the copy reads it copies from the profile that became the default", async () => {
  await shareTwo();
  const side = createProfile({ name: "Side" });
  S().deleteProfile("default");
  assert.deepEqual(await savesTo(side), SHARED);
});

test("deleting the default profile while the copy reads it copies from the profile that became the default", async () => {
  await shareTwo();
  const held = holdRead("");
  const side = createProfile({ name: "Side" });
  await sleep(1);
  S().deleteProfile("default");
  engine.delete("");
  held.resolve();
  assert.deepEqual(await savesTo(side), SHARED);
});

test("a deleted source that no longer answers isn't a failed copy", async () => {
  await shareTwo();
  const held = holdRead("");
  const side = createProfile({ name: "Side" });
  await sleep(1);
  S().deleteProfile("default");
  held.reject(Object.assign(new Error("profile not loaded"), { code: "ERR_ENGINE" }));
  assert.deepEqual(await savesTo(side), SHARED);
});

test("deleting the only other profile while the copy reads it keeps what was read", async () => {
  const held = holdRead("");
  const work = createProfile({ name: "Work" });
  await sleep(1);
  S().deleteProfile("default");
  held.resolve();
  assert.deepEqual(await savesTo(work), SHARED);
});

test("what was read isn't applied once the switch is on", async () => {
  const held = holdRead("");
  const work = createProfile({ name: "Work" });
  await sleep(1);
  S().deleteProfile("default");
  S().updateSettings({ separateDownloadFolders: true });
  held.resolve();
  assert.deepEqual(await savesTo(work), UNTOUCHED);
});

test("what was read isn't applied to a profile deleted meanwhile", async () => {
  const held = holdRead("");
  const work = createProfile({ name: "Work" });
  const workEngine = engineOf(work);
  await sleep(1);
  S().deleteProfile(work);
  held.resolve();
  await settled();
  assert.equal(loads.has(workEngine), false);
});

test("Settings never caches what a new default profile had before the copy landed", async () => {
  const work = createProfile({ name: "Work" });
  S().setDefaultProfile(work);
  await load(downloadSettings, [engineOf(work)]);
  await settled();
  const { folder, askWhereToSave } = cached(downloadSettings, [engineOf(work)]);
  assert.deepEqual({ folder, askWhereToSave }, SHARED);
});

test("automation doesn't read a profile deleted while it waited", async () => {
  const work = createProfile({ name: "Work" });
  const workEngine = engineOf(work);
  const read = automation("downloads.settings").run({ profile: work }, socketCall);
  const refused = assert.rejects(read, /There's no profile/);
  S().deleteProfile(work);
  await refused;
  assert.equal(reads.includes(workEngine), false);
});

test("automation doesn't write to a profile deleted while it waited", async () => {
  const work = createProfile({ name: "Work" });
  const workEngine = engineOf(work);
  const write = automation("downloads.setSettings").run({ profile: work, folder: "/Users/someone/Scripted" }, socketCall);
  const refused = assert.rejects(write, /There's no profile/);
  S().deleteProfile(work);
  await refused;
  assert.equal(loads.has(workEngine), false);
});

test("automation doesn't write to a profile deleted while its settings were read", async () => {
  const work = await shareTwo();
  const workEngine = engineOf(work);
  const held = holdRead(workEngine);
  writes = [];
  const write = automation("downloads.setSettings").run({ profile: work, folder: "/Users/someone/Scripted" }, socketCall);
  const refused = assert.rejects(write, /There's no profile/);
  await sleep(1);
  S().deleteProfile(work);
  held.resolve();
  await refused;
  assert.deepEqual(writes, []);
});

test("Settings doesn't write to a profile deleted while it waited", async () => {
  const work = createProfile({ name: "Work" });
  const workEngine = engineOf(work);
  const write = setDownloadsFor({ folder: "/Users/someone/Chosen" }, [workEngine]);
  S().deleteProfile(work);
  await write;
  assert.equal(loads.has(workEngine), false);
});

test("General doesn't load a profile deleted while it waited", async () => {
  const work = createProfile({ name: "Work" });
  const workEngine = engineOf(work);
  const check = separateIfFoldersDiffer(["", workEngine], () => true);
  S().deleteProfile(work);
  await check;
  assert.equal(loads.has(workEngine), false);
});

test("turning the switch off while the default profile is deleted mid-read copies the new default's folder", async () => {
  const [work, side] = await threeApart();
  const held = holdRead("");
  setSeparateDownloadFolders(false);
  await sleep(1);
  S().deleteProfile("default");
  const replaced = { folder: "/Users/someone/Work", askWhereToSave: false };
  held.resolve();
  assert.deepEqual(await savesTo(work), replaced);
  assert.deepEqual(await savesTo(side), replaced);
  assert.deepEqual(writes, [engineOf(side)]);
});

test("turning the switch off still copies when the deleted default stops answering", async () => {
  const [work, side] = await threeApart();
  const held = holdRead("");
  setSeparateDownloadFolders(false);
  await sleep(1);
  S().deleteProfile("default");
  held.reject(Object.assign(new Error("profile not loaded"), { code: "ERR_ENGINE" }));
  assert.deepEqual(await savesTo(side), { folder: "/Users/someone/Work", askWhereToSave: false });
  assert.deepEqual(await savesTo(work), { folder: "/Users/someone/Work", askWhereToSave: false });
});

test("turning the switch off follows the default through a second deletion", async () => {
  const [work, side] = await threeApart();
  const workEngine = engineOf(work);
  const firstRead = holdRead("");
  const secondRead = holdRead(workEngine);
  setSeparateDownloadFolders(false);
  await sleep(1);
  S().deleteProfile("default");
  firstRead.resolve();
  await sleep(1);
  S().deleteProfile(work);
  secondRead.resolve();
  assert.deepEqual(await savesTo(side), { folder: "/Users/someone/Side", askWhereToSave: false });
  assert.deepEqual(writes, []);
});

test("turning the switch off uses what it read when no default profile is left to read", async () => {
  const [work, side] = await threeApart();
  const held = holdRead("");
  setSeparateDownloadFolders(false);
  await sleep(1);
  useBrowser.setState((state) => {
    const { default: _, ...profiles } = state.profiles;
    return { profiles, profileOrder: [work, side] };
  });
  held.resolve();
  assert.deepEqual(await savesTo(work), SHARED);
  assert.deepEqual(await savesTo(side), SHARED);
});

test("turning the switch off and on again during a deletion writes nothing", async () => {
  await threeApart();
  const held = holdRead("");
  setSeparateDownloadFolders(false);
  await sleep(1);
  S().deleteProfile("default");
  setSeparateDownloadFolders(true);
  held.resolve();
  await settled();
  assert.deepEqual(writes, []);
});
