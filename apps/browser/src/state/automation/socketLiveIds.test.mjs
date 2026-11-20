import assert from "node:assert/strict";
import { after, test } from "node:test";
const { S, freshWindow, tick } = await import("./fixtures/socketHarness.mjs");
const { useLive } = await import("../live/store.ts");
const { LINE_BYTE_LIMIT } = await import("./socketWire.ts");
const stub = await import("../../test-native/index.ts");

after(() => S().updateSettings({ cliControl: false }));

const bytes = (line) => Buffer.byteLength(line, "utf8") + 1;
const LONG_ID = "é".repeat(128);

async function rawLine(id, method, params) {
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 83, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  for (let i = 0; i < 400 && !stub.controlSocket.replies.slice(before).some((r) => r.connection === 83); i++) await tick();
  return stub.controlSocket.replies.slice(before).find((r) => r.connection === 83).line;
}

const folder = (id, profileId, name) => ({
  id,
  profileId,
  kind: "pullRequests",
  name,
  icon: null,
  color: null,
  collapsed: false,
  sources: ["github"],
  filters: { authored: true, reviewRequests: true },
  groupStacks: false,
  showCompleted: false,
  hiddenRepos: [],
  showNewRepos: true,
  createdAt: 1,
});

function folders(profileId, count, nameLength, lastLength) {
  const list = Array.from({ length: count }, (_, i) => folder(`lf-${i}`, profileId, "n".repeat(i === count - 1 ? lastLength : nameLength)));
  useLive.setState({ folders: Object.fromEntries(list.map((f) => [f.id, f])), folderOrder: list.map((f) => f.id), items: {}, hidden: {}, unread: {}, completed: {}, status: {} });
}

test("a live.list reply of 1,048,564 bytes stays under 1 MiB with a 256-byte id, and keeps that id", async () => {
  await freshWindow();
  const profileId = S().settings.defaultProfileId;
  const count = 150;
  folders(profileId, count, 5000, 5000);
  const base = bytes(await rawLine(1, "live.list"));
  folders(profileId, count, 5000, 5000 + (1_048_564 - base));
  const short = await rawLine(1, "live.list");
  assert.equal(bytes(short), 1_048_564, "the short-id reply is at the edge");
  assert.ok(Array.isArray(JSON.parse(short).result.folders));
  const line = await rawLine(LONG_ID, "live.list");
  assert.ok(bytes(line) <= LINE_BYTE_LIMIT, `${bytes(line)} bytes`);
  assert.equal(JSON.parse(line).id, LONG_ID);
  useLive.setState({ folders: {}, folderOrder: [] });
});

test("a maximal live.items page with a 256-byte id stays under 1 MiB and keeps the id and its nextOffset", async () => {
  await freshWindow();
  const profileId = S().settings.defaultProfileId;
  folders(profileId, 1, 10, 10);
  const pr = (i) => ({ id: `i${i}`, source: "github", url: `https://github.com/o/r/pull/${i}`, title: "t".repeat(200 * 1024), subtitle: "", icon: null, updatedAt: i, section: "authored", pr: { number: i, repo: "o/r", headRef: "b", baseRef: "main" } });
  useLive.setState((s) => ({ items: { ...s.items, "lf-0": Array.from({ length: 40 }, (_, i) => pr(i)) } }));
  const line = await rawLine(LONG_ID, "live.items", { folder: "lf-0", limit: 1000 });
  const reply = JSON.parse(line);
  assert.ok(bytes(line) <= LINE_BYTE_LIMIT, `${bytes(line)} bytes`);
  assert.equal(reply.id, LONG_ID);
  assert.ok(reply.result.items.length >= 1, JSON.stringify(reply).slice(0, 300));
  assert.equal(typeof reply.result.nextOffset, "number");
  useLive.setState({ folders: {}, folderOrder: [], items: {} });
});
