import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { projectLiveIntent } from "./liveDocumentIntent.ts";

const platform = new URL("../../browser/src/platform/livePersistence.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    return resolved.url === platform ? { url: new URL("./livePersistence.ts", import.meta.url).href, shortCircuit: true } : resolved;
  },
});
const listeners = new Set();
let payload = { folders: {}, folderOrder: [], items: {}, known: {}, unread: {}, hidden: {}, completed: {}, expandedStacks: {}, accounts: {}, config: {}, calendar: { showPreview: true, showTimeToNext: true, hiddenCalendarIds: [] }, meetingGroups: {}, dismissedAlerts: [], version: 1 };
let revision = 0, watermark = 0;
let failCommit = false;
let refuse = () => false;
const snapshot = () => ({ document: "live.json", scope: "native", epoch: "epoch", clientId: "native-client", revision, watermark, payload, incarnations: Object.fromEntries(Object.keys(payload.folders).map((id) => [id, `folder:${id}`])), generations: {} });
globalThis.window = { __ardiaHost: {
  bootstrap: { windowId: "main", profileId: "default" },
  onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  async call(name, profile, json) {
    const args = JSON.parse(json);
    if (name === "documents.watch") return JSON.stringify(snapshot());
    if (name === "documents.flush") return JSON.stringify(snapshot());
    assert.equal(name, "documents.commit");
    if (failCommit) throw new Error("Storage unavailable");
    if (args.operations.some(refuse)) throw Object.assign(new Error("Invalid document operations"), { code: "ERR_DOCUMENT_REQUEST" });
    payload = projectLiveIntent(payload, args.operations);
    revision++; watermark++;
    return JSON.stringify({ status: "committed", requestId: args.requestId, snapshot: snapshot() });
  },
} };
const { live, setLive, createFolder, removeFolder, setRepoHidden, updateCalendarSettings, dismissNowBadge, setAccount, setLegacyAccount, removeProfileAccounts, saveLiveDurably } = await import("../../browser/src/state/live/store.ts");
const { liveDocumentLoaded, liveDurability } = await import("./livePersistence.ts");
const { flushLinuxDocuments } = await import("./documentFlush.ts");

test("Linux binding uses the canonical shared store, suppresses write echoes and preserves transient state", async () => {
  await new Promise((resolve) => setImmediate(resolve));
  setLive({ status: { f: { state: "updating" } }, completing: { f: ["item"] }, showAll: { f: true } });
  payload = { ...payload, calendar: { ...payload.calendar, showPreview: false } };
  revision++;
  for (const listener of listeners) listener("ArdiaDocuments", "documents", { name: "documents.changed", data: { snapshot: snapshot(), clientId: "peer", requestId: "peer:1" } });
  assert.equal(live().calendar.showPreview, false);
  assert.equal(live().status.f.state, "updating");
  assert.deepEqual(live().completing.f, ["item"]);
  assert.equal(live().showAll.f, true);
  assert.equal(watermark, 0);
  updateCalendarSettings({ showTimeToNext: false });
  await flushLinuxDocuments();
  assert.equal(watermark, 1);
  assert.equal(payload.calendar.showTimeToNext, false);
  const oldNow = Date.now;
  Date.now = () => 1;
  try {
    const ids = Array.from({ length: 30 }, () => createFolder("logical", "documents", []));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^lf-[a-f0-9-]{36}$/.test(id)));
    await flushLinuxDocuments();
  } finally { Date.now = oldNow; }
});

test("Linux binding persists dismissed Now badges and the countdown lead through canonical intents", async () => {
  await new Promise((resolve) => setImmediate(resolve));
  const now = 1_700_000_000_000;
  updateCalendarSettings({ countdownLead: 15 });
  dismissNowBadge({ occurrence: "calendar/uid@1700000000", end: now + 600_000 }, now);
  await flushLinuxDocuments();
  assert.equal(payload.calendar.countdownLead, 15);
  assert.deepEqual(payload.dismissedNow, { "calendar/uid@1700000000": now + 600_000 });
  dismissNowBadge({ occurrence: "calendar/uid@1700003600", end: now + 4_200_000 }, now + 700_000);
  await flushLinuxDocuments();
  assert.deepEqual(payload.dismissedNow, { "calendar/uid@1700003600": now + 4_200_000 });
  payload = { ...payload, dismissedNow: { "peer/uid@1": now + 9_000_000 }, calendar: { ...payload.calendar, countdownLead: 30 } };
  revision++;
  for (const listener of listeners) listener("ArdiaDocuments", "documents", { name: "documents.changed", data: { snapshot: snapshot(), clientId: "peer", requestId: "peer:2" } });
  assert.deepEqual(live().dismissedNow, { "peer/uid@1": now + 9_000_000 });
  assert.equal(live().calendar.countdownLead, 30);
});

test("Linux binding keeps a folder's hidden repos and their pull requests through canonical intents", async () => {
  await new Promise((resolve) => setImmediate(resolve));
  const pull = { id: "pr-1", source: "github", url: "https://example.test/pr/1", title: "PR", pr: { number: 1, repo: "acme/widgets" } };
  const id = createFolder("logical", "pullRequests", ["github"]);
  setLive((s) => ({ items: { ...s.items, [id]: [pull] } }));
  await flushLinuxDocuments();
  assert.deepEqual(payload.folders[id].hiddenRepos, []);
  assert.deepEqual(payload.items[id], [pull]);

  setRepoHidden(id, "github:acme/widgets", true);
  await flushLinuxDocuments();
  assert.deepEqual(payload.folders[id].hiddenRepos, ["github:acme/widgets"]);
  assert.deepEqual(payload.items[id], []);
  assert.deepEqual(payload.repoHidden[id], [pull]);

  setRepoHidden(id, "github:acme/widgets", false);
  setLive((s) => ({ repoHidden: { ...s.repoHidden, [id]: [] } }));
  await flushLinuxDocuments();
  assert.deepEqual(payload.folders[id].hiddenRepos, []);
  assert.deepEqual(payload.repoHidden[id], []);

  payload = { ...payload, repoHidden: { ...payload.repoHidden, [id]: [pull] } };
  revision++;
  for (const listener of listeners) listener("ArdiaDocuments", "documents", { name: "documents.changed", data: { snapshot: snapshot(), clientId: "peer", requestId: "peer:3" } });
  assert.deepEqual(live().repoHidden[id], [pull]);

  removeFolder(id);
  await flushLinuxDocuments();
  assert.equal(id in payload.repoHidden, false);
});



test("Linux binding saves each profile's accounts and the old account durably, and says so when the document drops one", async () => {
  await liveDocumentLoaded;
  const octo = { login: "octo", name: null, avatar: null, connectedAt: 1 };
  setAccount("default", "github", octo);
  setAccount("work", "bitbucket", { ...octo, user: "me@work.test" });
  setLegacyAccount("github", { ...octo, owedTo: ["work"] });
  await saveLiveDurably();
  assert.deepEqual(payload.accounts, { default: { github: octo }, work: { bitbucket: { ...octo, user: "me@work.test" } } });
  assert.deepEqual(payload.legacyAccounts, { github: { ...octo, owedTo: ["work"] } });
  removeProfileAccounts("work");
  setAccount("default", "github", null);
  await saveLiveDurably();
  assert.deepEqual(payload.accounts, {});
  refuse = (op) => op.target === "legacyAccount";
  const report = console.error;
  console.error = () => {};
  try {
    setLegacyAccount("github", null);
    await assert.rejects(saveLiveDurably(), (error) => error.code === "ERR_DOCUMENT_REJECTED");
  } finally {
    console.error = report;
    refuse = () => false;
  }
  assert.deepEqual(live().legacyAccounts, { github: { ...octo, owedTo: ["work"] } }, "the store falls back to the saved old account");
  setLegacyAccount("github", null);
  await saveLiveDurably();
  assert.equal(payload.legacyAccounts.github, undefined);
});

test("a window that starts closing while the old account is being copied keeps the old item, since the copy never reached the document", async () => {
  await liveDocumentLoaded;
  const { linuxLiveSources } = await import("./liveSources.ts");
  const { quiesceLinuxDocuments, resumeLinuxDocuments } = await import("./documentFlush.ts");
  const octo = { login: "octo", name: null, avatar: null, connectedAt: 1 };
  setLegacyAccount("notion", octo);
  await saveLiveDurably();
  let finishCopy;
  const forgotten = [];
  const native = {
    available: () => true,
    legacyExists: async () => true,
    adoptLegacy: () => new Promise((resolve) => (finishCopy = () => resolve("copied"))),
    forgetLegacy: async (source) => { forgotten.push(source); },
    disconnect: async () => {},
  };
  const linux = linuxLiveSources(native, { durable: liveDurability });
  const adoption = linux.adoptLegacyAccounts(["default"]);
  for (let i = 0; i < 50 && !finishCopy; i++) await new Promise((resolve) => setImmediate(resolve));
  quiesceLinuxDocuments("closing");
  try {
    finishCopy();
    await adoption;
  } finally {
    resumeLinuxDocuments("closing");
  }
  assert.deepEqual(forgotten, [], "the old item is deleted although the document never got the copy");
  assert.equal(payload.legacyAccounts.notion?.login, "octo");
  native.adoptLegacy = async () => "same";
  await linux.adoptLegacyAccounts(["default"]);
  assert.deepEqual(forgotten, ["notion"]);
  assert.equal(payload.accounts.default.notion.login, "octo");
  assert.equal(payload.legacyAccounts.notion, undefined);
});

test("Linux save telemetry describes queued intent on failure and does not recount retries", async () => {
  const { createLivePersistence } = await import("./livePersistence.ts");
  const activity = [];
  const binding = createLivePersistence((changed, kind) => activity.push({ changed, kind }));
  let current;
  binding.start((state) => { current = state; });
  await new Promise((resolve) => setImmediate(resolve));
  const before = structuredClone(payload);
  failCommit = true;
  try {
    binding.changed(current, { ...current, calendar: { ...current.calendar, showPreview: !current.calendar.showPreview } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(payload, before);
    assert.deepEqual(activity, [{ changed: true, kind: "intent" }]);
  } finally { failCommit = false; }
  await flushLinuxDocuments();
  assert.notEqual(payload.calendar.showPreview, before.calendar.showPreview);
  assert.equal(activity.length, 1);
  binding.changed(current, current);
  assert.deepEqual(activity.at(-1), { changed: false, kind: "intent" });
});
