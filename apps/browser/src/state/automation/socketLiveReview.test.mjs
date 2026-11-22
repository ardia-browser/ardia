import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { startAutomation } = await import("./controlSocket.ts");
const { SOURCES } = await import("../live/sources.ts");
const { live, setAccount, useLive } = await import("../live/store.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
let nextId = 0;

function send(method, params) {
  const id = ++nextId;
  const before = stub.controlSocket.replies.length;
  stub.emitControlRequest({ connection: 23, generation: stub.controlSocket.generation, line: JSON.stringify({ id, method, ...(params ? { params } : {}) }) });
  return (async () => {
    for (let i = 0; i < 400; i++) {
      const reply = stub.controlSocket.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
      if (reply) return reply;
      await tick();
    }
    throw new Error(`no reply to ${method}`);
  })();
}
const ok = async (method, params) => {
  const reply = await send(method, params);
  assert.ok(!reply.error, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const until = async (check) => {
  for (let i = 0; i < 400 && !check(); i++) await tick();
  assert.ok(check(), "it settled");
};
const settle = async () => {
  for (let i = 0; i < 40; i++) await tick();
};
const gated = () => {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  return { gate, open: () => open() };
};
const pr = (id, number) => ({ id, source: "github", url: `https://github.com/o/r/pull/${number}`, title: `PR ${number}`, subtitle: "", icon: null, updatedAt: number, section: "authored", pr: { number, repo: "o/r", headRef: `b${number}`, baseRef: "main" } });

async function controlOn() {
  S().updateSettings({ cliControl: true });
  startAutomation();
  for (let i = 0; i < 5 && !stub.controlSocket.running; i++) await tick();
  await tick();
}

async function withGithub(fetch, body) {
  S().hydrate({});
  await controlOn();
  S().createWindow({ url: "https://a.example/" });
  const saved = SOURCES.github.fetch;
  SOURCES.github.fetch = fetch;
  setAccount("github", { login: "me", name: null, avatar: null, connectedAt: 1 });
  try {
    const made = await ok("live.create", { kind: "pullRequests" });
    await until(() => live().status[made.id]?.state !== "initializing" && live().status[made.id]?.state !== "updating");
    await body(made.id);
    await controlOn();
    await ok("live.remove", { folder: made.id });
  } finally {
    SOURCES.github.fetch = saved;
    setAccount("github", null);
  }
}

test("a fresh live.refresh after control went off and on never joins the revoked pass; it fetches for itself", async () => {
  let calls = 0;
  const held = gated();
  await withGithub(async () => (++calls === 2 ? (await held.gate, [pr("stale", 2)]) : calls === 1 ? [pr("early", 1)] : [pr("fresh", 3)]), async (folder) => {
    const first = send("live.refresh", { folder });
    await until(() => calls === 2);
    S().updateSettings({ cliControl: false });
    await settle();
    await controlOn();
    const second = send("live.refresh", { folder });
    await settle();
    held.open();
    await first;
    const reply = await second;
    assert.ok(!reply.error, JSON.stringify(reply.error));
    assert.equal(calls, 3, "the second refresh fetched for itself");
    assert.deepEqual(live().items[folder].map((it) => it.id), ["fresh"]);
  });
});

test("a queued refresh checks control before it fetches", async () => {
  let calls = 0;
  const held = gated();
  await withGithub(async () => (++calls === 2 ? (await held.gate, [pr("held", 2)]) : [pr("any", calls)]), async (folder) => {
    const refreshing = send("live.refresh", { folder });
    await until(() => calls === 2);
    assert.ok(!(await send("live.update", { folder, filters: { authored: false } })).error);
    S().updateSettings({ cliControl: false });
    await settle();
    held.open();
    await refreshing;
    await settle();
    assert.equal(calls, 2, "nothing was fetched once control was off");
  });
});

test("live.items lists an item once while its completion animates, and pages before building rows", async () => {
  await withGithub(async () => [pr("a", 1), pr("b", 2)], async (folder) => {
    await ok("live.refresh", { folder });
    const a = live().items[folder].find((it) => it.id === "a");
    useLive.setState((s) => ({ completed: { ...s.completed, [folder]: [{ item: a, state: "merged", at: 1 }] } }));
    const all = await ok("live.items", { folder });
    assert.deepEqual(all.items.map((r) => [r.item.id, r.shown]).sort(), [["a", "completed"], ["b", "listed"]]);
    assert.equal(all.total, 2);

    let built = 0;
    const done = ["x", "y", "z"].map((id, i) => ({ item: pr(id, 10 + i), get state() { built++; return "merged"; }, at: 1 }));
    useLive.setState((s) => ({ completed: { ...s.completed, [folder]: done } }));
    const first = await ok("live.items", { folder, limit: 1 });
    assert.equal(first.total, 5);
    assert.equal(built, 0, "no completed row was built for a page that doesn't show one");
  });
});

test("a follow-up pass queued by a settings change keeps the socket's guard and never commits once control is off", async () => {
  let calls = 0;
  const held = gated();
  const late = gated();
  await withGithub(async () => (++calls === 2 ? (await held.gate, [pr("held", 2)]) : calls === 3 ? (await late.gate, [pr("late", 3)]) : [pr("any", calls)]), async (folder) => {
    const refreshing = send("live.refresh", { folder });
    await until(() => calls === 2);
    assert.ok(!(await send("live.update", { folder, filters: { reviewRequests: false } })).error);
    held.open();
    await until(() => calls === 3);
    S().updateSettings({ cliControl: false });
    await settle();
    late.open();
    await refreshing.catch(() => undefined);
    await settle();
    assert.ok(!live().items[folder].some((it) => it.id === "late"), "the follow-up's results never landed after control went off");
  });
});

test("live.items pages past a single item too big for a line", async () => {
  await withGithub(async () => [pr("a", 1), pr("b", 2)], async (folder) => {
    await ok("live.refresh", { folder });
    const huge = { ...pr("huge", 9), pr: { number: 9, repo: "o/r", headRef: "x".repeat(2 * 1024 * 1024), baseRef: "main" } };
    useLive.setState((s) => ({ items: { ...s.items, [folder]: [huge, ...s.items[folder]] } }));
    const first = await ok("live.items", { folder });
    assert.equal(first.items[0].item.id, "huge");
    assert.equal(first.items[0].item.oversized, true);
    assert.equal(first.total, 3);
    assert.deepEqual(first.items.map((r) => r.item.id), live().items[folder].map((it) => it.id));
    assert.equal(first.nextOffset, null);
  });
});

test("a pass whose guard was revoked claims no refresh: neither the follow-up nor a fresh request after control went off", async () => {
  const { liveRefreshClaims } = await import("../live/store.ts");
  const { refreshFolderWhile } = await import("../live/engine.ts");
  const real = liveRefreshClaims.begin;
  const claims = [];
  liveRefreshClaims.begin = (folderId) => (claims.push(folderId), Promise.resolve({ generation: claims.length }));
  let calls = 0;
  const held = gated();
  try {
    await withGithub(async () => (++calls === 2 ? (await held.gate, [pr("held", 2)]) : [pr("any", calls)]), async (folder) => {
      const refreshing = send("live.refresh", { folder });
      await until(() => calls === 2);
      assert.ok(!(await send("live.update", { folder, filters: { reviewRequests: false } })).error);
      const before = claims.length;
      S().updateSettings({ cliControl: false });
      await settle();
      held.open();
      await refreshing.catch(() => undefined);
      await settle();
      await refreshFolderWhile(folder, false, () => false);
      assert.equal(claims.length, before, "no claim after control went off");
      assert.equal(calls, 2, "nothing fetched");
    });
  } finally {
    liveRefreshClaims.begin = real;
  }
});

test("a refresh that control left mid-fetch says the hidden items were already shown again", async () => {
  let calls = 0;
  const held = gated();
  await withGithub(async () => (++calls === 2 ? (await held.gate, [pr("held", 2)]) : [pr("any", calls)]), async (folder) => {
    const refreshing = send("live.refresh", { folder });
    await until(() => calls === 2);
    S().updateSettings({ cliControl: false });
    await settle();
    held.open();
    const reply = await refreshing;
    assert.match(reply.error?.message ?? "", /hidden items were already shown again/, JSON.stringify(reply));
  });
});

test("a live folder made by a client that hung up right after the answer still fills", async () => {
  const held = gated();
  S().hydrate({});
  await controlOn();
  S().createWindow({ url: "https://a.example/" });
  const { fetch } = SOURCES.github;
  SOURCES.github.fetch = async () => (await held.gate, [pr("first", 1)]);
  setAccount("github", { login: "me", name: null, avatar: null, connectedAt: 1 });
  try {
    const made = await ok("live.create", { kind: "pullRequests" });
    stub.emitControlClose(23);
    await settle();
    held.open();
    await until(() => live().items[made.id]?.length === 1);
    assert.deepEqual(live().items[made.id].map((it) => it.id), ["first"]);
    await ok("live.remove", { folder: made.id });
  } finally {
    SOURCES.github.fetch = fetch;
    setAccount("github", null);
  }
});
