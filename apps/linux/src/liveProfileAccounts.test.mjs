import assert from "node:assert/strict";
import { after, test } from "node:test";
import { failedSaves } from "../../browser/src/test-native/index.ts";
import { LiveError } from "../../browser/src/state/live/types.ts";

const { useBrowser } = await import("../../browser/src/state/browser/store.ts");
const { live, setAccount, setLegacyAccount } = await import("../../browser/src/state/live/store.ts");
const { takeLiveFolderCounts } = await import("../../browser/src/state/telemetry/liveFolders.ts");
const telemetry = await import("../../browser/src/state/telemetry/client.ts");
telemetry.setSharing(true, "settings");
after(() => telemetry.setSharing(false, "settings"));
const { linuxLiveSources } = await import("./liveSources.ts");

const personal = useBrowser.getState().createProfile({ name: "Personal" });
const work = useBrowser.getState().createProfile({ name: "Work" });
const everyone = () => Object.keys(useBrowser.getState().profiles);

const viewers = { "personal-token": "LuisUrrutia", "work-token": "luis-urrutia-flute" };

function nativeService() {
  const items = new Map();
  const refusals = new Set();
  const failedDeletes = new Set();
  const fetched = [];
  const locked = () => Object.assign(new Error("Unlock your keyring"), { code: "ERR_LIVE_KEYRING_LOCKED" });
  const key = (source, profileId) => `${source}:${profileId}`;
  const remove = async (name) => {
    if (failedDeletes.has(name)) throw locked();
    items.delete(name);
  };
  const client = {
    available: () => true,
    async request(source, profileId) {
      const token = items.get(key(source, profileId));
      if (!token) throw new LiveError("notConfigured", "Not signed in");
      fetched.push([profileId, token]);
      return { data: { authored: { nodes: [] }, review: { nodes: [] }, direct: { nodes: [] } } };
    },
    async connect(source, profileId, fields) {
      if (refusals.has(key(source, profileId))) throw locked();
      items.set(key(source, profileId), fields.token);
      return { data: { viewer: { login: viewers[fields.token] ?? "someone", name: null, avatarUrl: "" } } };
    },
    disconnect: (source, profileId) => remove(key(source, profileId)),
    async legacyExists(source) {
      return items.has(source);
    },
    async adoptLegacy(source, profileId) {
      const legacy = items.get(source);
      if (!legacy) return "missing";
      const existing = items.get(key(source, profileId));
      if (existing) return existing === legacy ? "same" : "differs";
      if (refusals.has(key(source, profileId))) throw locked();
      items.set(key(source, profileId), legacy);
      return "copied";
    },
    forgetLegacy: (source) => remove(source),
  };
  return { items, refusals, failedDeletes, fetched, client };
}

const legacyAccount = (login) => ({ login, name: null, avatar: null, connectedAt: 1 });
const folderIn = (profileId) => ({ id: `f-${profileId}`, profileId, kind: "pullRequests", sources: ["github"], filters: { authored: true, reviewRequests: true } });

function reset() {
  for (const id of Object.keys(live().accounts)) for (const source of Object.keys(live().accounts[id])) setAccount(id, source, null);
  for (const source of Object.keys(live().legacyAccounts)) setLegacyAccount(source, null);
  takeLiveFolderCounts();
}

test("the account saved before profiles had their own moves to every profile natively, and only a fully copied one loses its old item", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  native.items.set("github", "personal-token");
  native.items.set("notion", "notion-token");
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  setLegacyAccount("notion", legacyAccount("Acme"));
  native.refusals.add(`notion:${work}`);

  await linux.adoptLegacyAccounts(everyone());

  for (const id of everyone()) assert.equal(native.items.get(`github:${id}`), "personal-token");
  assert.equal(native.items.has("github"), false);
  assert.equal(live().legacyAccounts.github, undefined);
  for (const id of everyone()) assert.equal(live().accounts[id].github.login, "LuisUrrutia");
  assert.equal(native.items.get("notion"), "notion-token", "the old item stays while a profile is still owed it");
  assert.deepEqual(live().legacyAccounts.notion.owedTo, [work]);
  assert.equal(live().accounts[work].notion, undefined);
  const counts = takeLiveFolderCounts();
  assert.equal(counts.live_legacy_account_copies, everyone().length * 2 - 1);
  assert.equal(counts.live_legacy_account_copy_refusals, 1);

  native.refusals.clear();
  await linux.legacyAccountsFor({ ...folderIn(work), kind: "documents", sources: ["notion"] });
  assert.equal(native.items.get(`notion:${work}`), "notion-token");
  assert.equal(native.items.has("notion"), false);
  assert.deepEqual(live().legacyAccounts, {});
});

test("a disconnect from a profile still owed the old account takes it off the list, so the next try doesn't copy it back", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  native.items.set("github", "personal-token");
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  native.refusals.add(`github:${work}`);
  await linux.adoptLegacyAccounts(everyone());
  assert.deepEqual(live().legacyAccounts.github.owedTo, [work]);
  native.items.set(`github:${work}`, "stale");
  await linux.disconnect(work, "github");
  assert.deepEqual(live().legacyAccounts.github.owedTo, []);
  native.refusals.clear();
  await linux.retryOwedLegacyAccounts();
  assert.equal(native.items.has(`github:${work}`), false);
  assert.equal(native.items.has("github"), false);
  assert.equal(live().legacyAccounts.github, undefined);
});

test("a profile already holding another connection keeps it and is no longer owed the old one", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  native.items.set("github", "personal-token");
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  await linux.connectGithub(work, "work-token");
  native.items.set(`github:${personal}`, "unsaved-token");
  await linux.adoptLegacyAccounts(everyone());
  assert.equal(native.items.get(`github:${work}`), "work-token");
  assert.equal(live().accounts[work].github.login, "luis-urrutia-flute");
  assert.deepEqual(live().legacyAccounts.github.owedTo, [personal], "an unrecorded item that isn't the old one stays owed");
  assert.equal(native.items.get("github"), "personal-token");
});

test("the old item stays when live.json can't land on disk, and a later try still deletes it", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  native.items.set("github", "personal-token");
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  failedSaves.on = true;
  try {
    await linux.adoptLegacyAccounts(everyone());
  } finally {
    failedSaves.on = false;
  }
  assert.equal(native.items.get("github"), "personal-token");
  assert.deepEqual(live().legacyAccounts.github.owedTo, everyone());
  await linux.adoptLegacyAccounts(everyone());
  assert.equal(native.items.has("github"), false);
  assert.equal(live().legacyAccounts.github, undefined);
});

test("each profile fetches with its own native credential, and a profile with none reports the source as not connected", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  await linux.connectGithub(personal, "personal-token");
  await linux.connectGithub(work, "work-token");
  await linux.SOURCES.github.fetch(folderIn(work));
  await linux.SOURCES.github.fetch(folderIn(personal));
  assert.deepEqual(native.fetched, [[work, "work-token"], [personal, "personal-token"]]);
  await assert.rejects(linux.SOURCES.github.fetch(folderIn("default")), (error) => error.kind === "notConfigured");
  const counts = takeLiveFolderCounts();
  assert.equal(counts.live_account_connects, 2);
  assert.equal(counts.live_account_connects_beside_another_profile, 1);
  assert.ok(!JSON.stringify(live()).includes("work-token"), "no token reaches the shared state");
});

test("a connection that finishes after its profile was deleted leaves no account or native item behind", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  const doomed = useBrowser.getState().createProfile({ name: "Doomed" });
  const connect = native.client.connect;
  native.client.connect = async (...args) => {
    const reply = await connect(...args);
    useBrowser.getState().deleteProfile(doomed);
    return reply;
  };
  await linux.connectGithub(doomed, "work-token");
  assert.equal(native.items.has(`github:${doomed}`), false);
  assert.equal(live().accounts[doomed]?.github, undefined);
  await assert.rejects(linux.connectGithub(doomed, "work-token"), /deleted/);
});

test("a deleted profile keeps its accounts until every native item is gone, so a later pass can retry", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  const leaving = useBrowser.getState().createProfile({ name: "Leaving" });
  await linux.connectGithub(leaving, "work-token");
  useBrowser.getState().deleteProfile(leaving);
  native.failedDeletes.add(`notion:${leaving}`);
  await linux.forgetProfileAccounts(leaving);
  assert.equal(native.items.has(`github:${leaving}`), false);
  assert.ok(live().accounts[leaving], "a refused delete keeps the record for the next pass");
  native.failedDeletes.clear();
  linux.forgetMissingProfiles();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(live().accounts[leaving], undefined);
});

test("once the saved document arrives after the engine started, missing profiles are forgotten and the old account moves", async () => {
  reset();
  const native = nativeService();
  let arrive;
  const loaded = new Promise((resolve) => (arrive = resolve));
  const linux = linuxLiveSources(native.client, { loaded });
  linux.forgetMissingProfiles();
  native.items.set("github", "personal-token");
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  native.items.set("notion:gone-profile", "orphan");
  setAccount("gone-profile", "notion", legacyAccount("Acme"));
  arrive();
  for (let i = 0; i < 50 && (live().legacyAccounts.github || live().accounts["gone-profile"]); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(live().legacyAccounts.github, undefined);
  assert.equal(native.items.has("notion:gone-profile"), false);
  assert.equal(live().accounts["gone-profile"], undefined);
  for (const id of everyone()) assert.equal(native.items.get(`github:${id}`), "personal-token");
});

test("account work for one profile waits on the cross-window lock of that profile and source only", async () => {
  reset();
  const native = nativeService();
  const names = [];
  const locks = { request: (name, work) => (names.push(name), work()) };
  const linux = linuxLiveSources(native.client, { locks });
  await linux.connectGithub(work, "work-token");
  await linux.disconnect(work, "github");
  native.items.set("github", "personal-token");
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  await linux.adoptLegacyAccounts([work]);
  assert.deepEqual(names, [`ardia.linux.live.github:${work}`, `ardia.linux.live.github:${work}`, "ardia.linux.live.adoption", `ardia.linux.live.github:${work}`]);
});

test("a window whose view of the old account is stale drops the record once its item is gone instead of owing it again", async () => {
  reset();
  const native = nativeService();
  const linux = linuxLiveSources(native.client);
  setLegacyAccount("github", legacyAccount("LuisUrrutia"));
  await linux.adoptLegacyAccounts(everyone());
  assert.equal(live().legacyAccounts.github, undefined);
  setLegacyAccount("notion", legacyAccount("Acme"));
  native.client.legacyExists = async () => {
    throw Object.assign(new Error("Unlock your keyring"), { code: "ERR_LIVE_KEYRING_LOCKED" });
  };
  await linux.adoptLegacyAccounts(everyone());
  assert.deepEqual(live().legacyAccounts.notion.owedTo, everyone(), "an unreadable item pins who is owed it and waits");
});
