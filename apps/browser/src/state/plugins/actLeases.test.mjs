import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

await import("../../test-native/index.ts");
const { useBrowser } = await import("../browser/store.ts");
const leases = await import("./actLeases.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));
const TOTALS = { granted: 0, released: 0, endedByDocument: 0, endedByDetach: 0, commandsRefused: 0, deliveriesRefused: 0, live: 0 };

const engine = {
  next: 1,
  documents: new Map(),
  granted: [],
  released: [],
  revoked: [],
  refuse: null,
  hold: null,
  releaseFails: false,
  revokeFails: false,
  document(tabId) {
    return { document: this.documents.get(tabId) ?? 100 };
  },
  grant(tabId, credential, document) {
    if (this.refuse) throw Object.assign(new Error(this.refuse), { code: "ERR_ENGINE" });
    if (document !== (this.documents.get(tabId) ?? 100)) throw Object.assign(new Error("ardia: document_changed: the tab loaded a new document since the act was approved"), { code: "ERR_ENGINE" });
    const lease = this.next++;
    this.granted.push({ tabId, credential, document, lease });
    return this.hold ? this.hold.then(() => ({ lease })) : { lease };
  },
  release(lease) {
    if (this.releaseFails) throw Object.assign(new Error("bridge gone"), { code: "ERR_ENGINE" });
    this.released.push(lease);
    return { released: true };
  },
  totals: () => TOTALS,
};

function tab(id, overrides = {}) {
  return { id, windowId: "w1", profileId: "p1", url: "https://example.com/", title: "", favicon: null, pin: null, muted: false, zoom: 1, customTitle: null, customIcon: null, pinnedUrl: null, page: { kind: "loaded", nav: { url: "https://example.com/", seq: 1 } }, openerId: null, createdAt: 0, lastActiveAt: 0, ...overrides };
}

const setTab = (t) => useBrowser.setState((s) => ({ tabs: { ...s.tabs, [t.id]: t } }));
const dropTab = (id) =>
  useBrowser.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs[id];
    return { tabs };
  });

const step = (extra = {}) => ({ kind: "act", owner: "a1", tab: "t1", credential: "plugin-1", expectedDocument: 100, ...extra });
const act = (run, extra = {}) => leases.withActLease(step(extra), run);

beforeEach(async () => {
  globalThis.acTestActLeases = engine;
  delete globalThis.acTestCliControl;
  engine.releaseFails = false;
  engine.revokeFails = false;
  await leases.stopActLeases();
  globalThis.acTestRevokePluginCredential = (id) => {
    if (engine.revokeFails) throw Object.assign(new Error("bridge gone"), { code: "ERR_ENGINE" });
    engine.revoked.push(id);
    return { revoked: true };
  };
  Object.assign(engine, { granted: [], released: [], revoked: [], refuse: null, hold: null, documents: new Map() });
  setTab(tab("t1"));
  leases.startActLeases();
});

test("an act takes a lease for the document approved on its card, runs, and answers only once the engine confirmed the release", async () => {
  const seen = [];
  const outcome = await act(async (lease) => {
    seen.push(lease?.engine, leases.liveActLeases().length);
    return "clicked";
  });
  assert.deepEqual(outcome, { ok: true, value: "clicked", cleanup: "released" });
  assert.deepEqual(engine.granted.map((g) => [g.tabId, g.credential, g.document]), [["t1", "plugin-1", 100]]);
  assert.deepEqual(seen, [engine.granted[0].lease, 1]);
  assert.deepEqual(engine.released, [engine.granted[0].lease], "released before withActLease answered");
  assert.equal(leases.liveActLeases().length, 0);
});

test("the card's document comes from the engine, captured once when the step is approved", async () => {
  engine.documents.set("t1", 7);
  assert.equal(await leases.actDocumentOf("t1", "plugin-1"), 7);
});

test("a page that loads a new document between approval and grant refuses the act, and nothing runs", async () => {
  const approved = await leases.actDocumentOf("t1", "plugin-1");
  engine.documents.set("t1", approved + 1);
  let ran = false;
  const outcome = await act(async () => {
    ran = true;
  }, { expectedDocument: approved });
  assert.equal(ran, false);
  assert.equal(outcome.ok, false);
  assert.match(outcome.refused, /document_changed/);
  assert.equal(engine.granted.length, 0);
  assert.equal(leases.liveActLeases().length, 0);
});

test("an act without a captured document never asks for a lease", async () => {
  let ran = false;
  const outcome = await act(async () => {
    ran = true;
  }, { expectedDocument: null });
  assert.equal(ran, false);
  assert.equal(outcome.ok, false);
  assert.equal(engine.granted.length, 0);
});

test("an act that throws still releases its lease before the error comes back", async () => {
  await assert.rejects(act(async () => {
    throw new Error("page script failed");
  }));
  assert.deepEqual(engine.released, [engine.granted[0].lease]);
});

test("a read never takes a lease", async () => {
  const outcome = await leases.withActLease(step({ kind: "read" }), async (lease) => lease);
  assert.deepEqual(outcome, { ok: true, value: null, cleanup: "released" });
  assert.equal(engine.granted.length, 0);
});

test("a lease keeps its id until the release is confirmed, and an unconfirmed release revokes the credential", async () => {
  engine.releaseFails = true;
  const outcome = await act(async (lease) => lease.engine);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.cleanup, "revoked");
  assert.deepEqual(engine.revoked, ["plugin-1"]);
  assert.equal(leases.liveActLeases().length, 0);
});

test("when neither the release nor the revoke answers, the lease stays listed with its id and a later release retries", async () => {
  engine.releaseFails = true;
  engine.revokeFails = true;
  const outcome = await act(async () => "ran");
  assert.equal(outcome.cleanup, "unconfirmed");
  const [kept] = leases.liveActLeases();
  assert.equal(kept.engine, engine.granted[0].lease);
  engine.releaseFails = false;
  assert.equal(await leases.releaseActLease(kept), "released");
  assert.deepEqual(engine.released, [engine.granted[0].lease]);
  assert.equal(leases.liveActLeases().length, 0);
});

test("a cleanup that revokes the credential while the act still runs is the answer every caller gets", async () => {
  let finish;
  const pending = act(() => new Promise((resolve) => (finish = resolve)));
  await settle();
  const [lease] = leases.liveActLeases();
  engine.releaseFails = true;
  const concurrent = leases.releaseActLease(lease, "stopped");
  finish("ran");
  const [outcome, other] = await Promise.all([pending, concurrent]);
  assert.equal(other, "revoked");
  assert.equal(outcome.ok, true);
  assert.equal(outcome.cleanup, "revoked", "the run's own release reports the revoke, not a clean release");
  assert.equal(await leases.releaseActLease(lease), "revoked", "and so does any later caller");
  assert.deepEqual(engine.revoked, ["plugin-1"]);
});

test("a new document, another profile, a closed tab or a stopped activity end the lease at once", async () => {
  const cases = [
    ["document", () => setTab(tab("t1", { url: "https://example.com/next", page: { kind: "loaded", nav: { url: "https://example.com/next", seq: 2 } } }))],
    ["document", () => setTab(tab("t1", { page: { kind: "loaded", nav: { url: "https://example.com/", seq: 3 } } }))],
    ["profile", () => setTab(tab("t1", { profileId: "p2" }))],
    ["tab", () => dropTab("t1")],
    ["stopped", () => leases.endActLeasesOf("a1")],
  ];
  for (const [why, change] of cases) {
    setTab(tab("t1"));
    const granted = await leases.grantActLease("a1", "t1", "plugin-1", 100);
    assert.ok("lease" in granted);
    change();
    await settle();
    assert.equal(granted.lease.ended, why, why);
    assert.equal(engine.released.at(-1), engine.granted.at(-1).lease, why);
    assert.equal(leases.liveActLeases().length, 0, why);
  }
});

test("other activities and tabs keep their leases", async () => {
  setTab(tab("t2"));
  const first = await leases.grantActLease("a1", "t1", "plugin-1", 100);
  const second = await leases.grantActLease("a2", "t2", "plugin-2", 100);
  await leases.endActLeasesOf("a1");
  setTab(tab("t1", { url: "https://example.com/elsewhere" }));
  await settle();
  assert.equal(first.lease.ended, "stopped");
  assert.equal(second.lease.ended, null);
  await leases.releaseActLease(second.lease);
});

test("a page change while the grant is on its way refuses the act and releases the grant", async () => {
  let open;
  engine.hold = new Promise((resolve) => (open = resolve));
  let ran = false;
  const pending = act(async () => {
    ran = true;
  });
  await settle();
  setTab(tab("t1", { url: "https://example.com/moved" }));
  open();
  const outcome = await pending;
  assert.equal(ran, false);
  assert.equal(outcome.ok, false);
  assert.match(outcome.refused, /new page before the step ran/);
  assert.deepEqual(engine.released, [engine.granted[0].lease]);
  assert.equal(leases.liveActLeases().length, 0);
});

test("an engine refusal stops the act", async () => {
  engine.refuse = "the tab can't be shown for this act";
  let ran = false;
  const outcome = await act(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(outcome.ok, false);
  assert.match(outcome.refused, /can't be shown/);
});

test("an engine that reports act leases is supported, and its errors refuse the act rather than fall back", async () => {
  assert.equal(await leases.actLeaseSupport(), "supported");
  engine.refuse = "unknown engine service";
  const outcome = await act(async () => "ran");
  assert.equal(outcome.ok, false);
});

test("an older engine without act leases is unsupported: the act is refused and no lease call is made", async () => {
  await leases.stopActLeases();
  let calls = 0;
  globalThis.acTestActLeases = {
    grant() {
      calls++;
      throw Object.assign(new Error("unknown engine service"), { code: "ERR_ENGINE" });
    },
    release() {
      calls++;
      throw Object.assign(new Error("unknown engine service"), { code: "ERR_ENGINE" });
    },
  };
  leases.startActLeases();
  assert.equal(await leases.actLeaseSupport(), "unsupported");
  let ran = false;
  const outcome = await act(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(outcome.ok, false);
  assert.match(outcome.refused, /can't hold plugins to approved acts/);
  assert.equal(calls, 0);
});

test("a status probe that fails is unknown: the act is refused, nothing runs, and the next step asks again", async () => {
  await leases.stopActLeases();
  globalThis.acTestCliControl = () => {
    throw Object.assign(new Error("bridge busy"), { code: "ERR_ENGINE" });
  };
  leases.startActLeases();
  let ran = false;
  const outcome = await act(async () => {
    ran = true;
  });
  assert.equal(ran, false);
  assert.equal(outcome.ok, false);
  assert.match(outcome.refused, /couldn't confirm/);
  assert.equal(engine.granted.length, 0);
  delete globalThis.acTestCliControl;
  assert.equal(await leases.actLeaseSupport(), "supported");
  const retried = await act(async () => "ran");
  assert.equal(retried.ok, true);
});

test("an act that throws carries its cleanup on the error, so the caller can tell revoked from unconfirmed", async () => {
  engine.releaseFails = true;
  const revoked = await act(async () => {
    throw new Error("page script failed");
  }).then(() => null, (error) => error);
  assert.equal(revoked.message, "page script failed");
  assert.equal(revoked.cleanup, "revoked");
  engine.revokeFails = true;
  const unconfirmed = await act(async () => {
    throw "not an Error";
  }).then(() => null, (error) => error);
  assert.equal(unconfirmed.message, "not an Error");
  assert.equal(unconfirmed.cleanup, "unconfirmed");
});

test("an act that throws something that can't become a string still reports its cleanup and keeps the original as the cause", async () => {
  engine.releaseFails = true;
  const original = Object.create(null);
  const failure = await act(async () => {
    throw original;
  }).then(() => null, (error) => error);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "the step failed with an error that couldn't be read");
  assert.equal(failure.cause, original);
  assert.equal(failure.cleanup, "revoked");
});

test("an act that throws a frozen error still reports its cleanup, on a wrapper whose cause is the original", async () => {
  engine.releaseFails = true;
  const original = Object.freeze(new Error("frozen page failure"));
  const failure = await act(async () => {
    throw original;
  }).then(() => null, (error) => error);
  assert.notEqual(failure, original);
  assert.equal(failure.message, "frozen page failure");
  assert.equal(failure.cause, original);
  assert.equal(failure.cleanup, "revoked");
  assert.equal("cleanup" in original, false);
});

test("a tab that changes while the grant is pending refuses the act and says how the grant was cleaned up", async () => {
  for (const [revokeFails, expected] of [[false, "revoked"], [true, "unconfirmed"]]) {
    await leases.stopActLeases();
    engine.releaseFails = false;
    engine.revokeFails = false;
    leases.startActLeases();
    setTab(tab("t1"));
    let open;
    engine.hold = new Promise((resolve) => (open = resolve));
    const pending = act(async () => "ran");
    await settle();
    engine.releaseFails = true;
    engine.revokeFails = revokeFails;
    setTab(tab("t1", { url: `https://example.com/moved-${expected}` }));
    open();
    const outcome = await pending;
    assert.equal(outcome.ok, false, expected);
    assert.equal(outcome.cleanup, expected, expected);
    engine.hold = null;
  }
});
