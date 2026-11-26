import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { bookmarkRoots } = await import("../bookmarks/bookmarks.ts");
const { historyOf } = await import("../history/history.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const { bookmarksAdapter } = await import("./adapters.ts");
const { historyAdapter, historyExpired } = await import("./historyAdapter.ts");
const { useEditClock } = await import("./editClock.ts");
const stub = await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const SAVE_MS = 30_000;

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (_scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, payload);
        return id;
      },
      read: async (_scope, known) => {
        const files = [...this.files].filter(([id]) => !known.includes(id)).map(([id, payload]) => ({ id, payload }));
        return { files, pending: [], damaged: [], present: [...this.files.keys()] };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

class Mac {
  constructor(id, folder) {
    this.id = id;
    this.folder = folder;
    S().hydrate({});
    useBrowser.setState({ bookmarks: { ...S().bookmarks, nodes: {} }, history: { "": { list: [], floor: -Infinity, ready: true } }, bookmarksReady: { "": true } });
    this.browser = S();
    this.state = emptyScope();
    this.clock = new Clock(id);
    this.saved = [];
    this.launches = 0;
    this.launch = `${id}-0`;
    this.steady = 0;
    this.chromeSaves();
  }
  with(fn) {
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  chromeSaves() {
    this.disk = { bookmarks: this.browser.bookmarks, history: this.browser.history };
  }
  killed() {
    this.browser = { ...this.browser, ...this.disk };
    const last = this.saved.map((s) => s.kind).lastIndexOf("state");
    this.state = last >= 0 ? JSON.parse(this.saved[last].json) : emptyScope();
    for (const later of this.saved.slice(last + 1)) {
      const batch = JSON.parse(later.json);
      this.state.applying = [...(this.state.applying ?? []).filter((b) => b.id !== batch.id), batch];
    }
    this.clock = new Clock(this.id, this.clock.last);
    this.launch = `${this.id}-${++this.launches}`;
    this.steady = 0;
  }
  async sync() {
    this.steady += 1_000;
    useEditClock(this.clock);
    stub.current.device = this.id;
    useBrowser.setState(this.browser, true);
    try {
      const result = await syncScope({
        scope: "p",
        state: this.state,
        transport: this.folder.transport(),
        adapters: [this.bookmarksReportFailure ? reportingFailure(bookmarksAdapter("default")) : bookmarksAdapter("default"), historyAdapter("default")],
        clock: this.clock,
        device: this.id,
        options: {
          expired: historyExpired,
          persistApplying: async (batch) => void this.saved.push({ kind: "batch", json: JSON.stringify(batch) }),
          launch: this.launch,
          nativeSaveMs: SAVE_MS,
          monotonic: () => this.steady,
        },
      });
      this.saved.push({ kind: "state", json: JSON.stringify(this.state) });
      return result;
    } finally {
      this.browser = S();
    }
  }
}

const reportingFailure = (adapter) => ({ ...adapter, apply: async (...args) => (await adapter.apply(...args), false) });

async function syncAll(macs, rounds = 2) {
  for (let i = 0; i < rounds; i++) for (const mac of macs) await mac.sync();
}

function titles(mac) {
  return mac.with(() => {
    const roots = bookmarkRoots(S(), "default");
    const b = S().bookmarks;
    return [roots.bar, roots.other].map((root) => b.nodes[root].children.map((id) => b.nodes[id].title));
  });
}

const idOf = (mac, title) => mac.with(() => Object.values(S().bookmarks.nodes).find((n) => n.title === title)?.id);

async function savedPair() {
  const folder = new Folder();
  const a = new Mac("devA", folder);
  const p = new Mac("devP", folder);
  return { folder, a, p };
}

async function settled(a, p) {
  await syncAll([a, p], 2);
  a.chromeSaves();
  p.chromeSaves();
  a.steady += SAVE_MS + 1;
  p.steady += SAVE_MS + 1;
  await syncAll([a, p], 1);
}

test("bookmarks: renamed and moved first on one Mac, applied and killed before Chrome saved on the other, then deleted: it stays deleted", async () => {
  const { a, p } = await savedPair();
  a.with(() => {
    S().addBookmark({ profileId: "default", url: "https://x.example/", title: "X" });
    S().addBookmark({ profileId: "default", url: "https://b.example/", title: "B" });
  });
  await settled(a, p);
  assert.deepEqual(titles(p), titles(a));
  a.with(() => {
    const id = idOf(a, "B");
    S().updateBookmark(id, { title: "B renamed" });
    S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 0);
  });
  await a.sync();
  await p.sync();
  assert.deepEqual(titles(p), titles(a));
  p.killed();
  a.with(() => S().removeBookmark(idOf(a, "B renamed")));
  await a.sync();
  await syncAll([p, a], 3);
  const left = titles(a).flat();
  assert.deepEqual(left, ["X"]);
  assert.deepEqual(titles(p), titles(a));
});

test("bookmarks: a reorder applied and killed before Chrome saved isn't undone on the other Mac", async () => {
  const { a, p } = await savedPair();
  a.with(() => {
    S().addBookmark({ profileId: "default", url: "https://one.example/", title: "One" });
    S().addBookmark({ profileId: "default", url: "https://two.example/", title: "Two" });
    S().addBookmark({ profileId: "default", url: "https://three.example/", title: "Three" });
  });
  await settled(a, p);
  const before = titles(a);
  a.with(() => {
    const id = idOf(a, "One");
    S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 3);
  });
  await a.sync();
  await p.sync();
  a.chromeSaves();
  p.chromeSaves();
  a.steady += SAVE_MS + 1;
  p.steady += SAVE_MS + 1;
  await syncAll([a, p], 1);
  const settledOrder = titles(a);
  a.with(() => {
    const id = idOf(a, "Three");
    S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 0);
  });
  await a.sync();
  await p.sync();
  const reordered = titles(a);
  assert.notDeepEqual(reordered, settledOrder);
  assert.notDeepEqual(settledOrder, before);
  assert.deepEqual(titles(p), reordered);
  p.killed();
  assert.deepEqual(titles(p), settledOrder);
  assert.equal((await p.sync()).published, 0, "the stale order isn't sent as this Mac's edit");
  await syncAll([p, a], 3);
  assert.deepEqual(titles(a), reordered);
  assert.deepEqual(titles(p), reordered);
});

test("history: visits applied and killed before Chrome committed them are applied again after the restart", async () => {
  const { a, p } = await savedPair();
  const url = "https://visited.example/";
  const first = Date.now() - 60_000;
  const second = Date.now() - 30_000;
  const visit = (times) => ({ url, title: "Visited", favicon: null, visits: times.length, lastVisit: times.at(-1), visitTimes: times });
  a.with(() => useBrowser.setState({ history: { "": { list: [visit([first])], floor: -Infinity, ready: true } } }));
  await settled(a, p);
  const timesOn = (mac) => mac.with(() => historyOf(S(), "default").find((e) => e.url === url)?.visitTimes);
  assert.deepEqual(timesOn(p), [first]);
  a.with(() => useBrowser.setState({ history: { "": { list: [visit([first, second])], floor: -Infinity, ready: true } } }));
  await a.sync();
  await p.sync();
  assert.deepEqual(timesOn(p), [first, second]);
  p.killed();
  assert.deepEqual(timesOn(p), [first]);
  await syncAll([p, a], 2);
  assert.deepEqual(timesOn(p), [first, second]);
  assert.deepEqual(timesOn(a), [first, second]);
});

test("bookmarks: two reorders applied and killed before Chrome saved either, then a delete elsewhere: it stays deleted and the order holds", async () => {
  const { a, p } = await savedPair();
  a.with(() => {
    for (const title of ["X", "B", "C"]) S().addBookmark({ profileId: "default", url: `https://${title.toLowerCase()}.example/`, title });
  });
  await settled(a, p);
  const toFront = (title) =>
    a.with(() => {
      const id = idOf(a, title);
      S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 0);
    });
  toFront("C");
  await a.sync();
  await p.sync();
  toFront("B");
  await a.sync();
  await p.sync();
  assert.deepEqual(titles(p), titles(a));
  p.killed();
  a.with(() => S().removeBookmark(idOf(a, "C")));
  await a.sync();
  assert.equal((await p.sync()).published, 0, "neither stale order is sent as this Mac's edit");
  await syncAll([p, a], 3);
  assert.deepEqual(titles(a).flat(), ["B", "X"]);
  assert.deepEqual(titles(p), titles(a));
});

test("bookmarks: two reorders applied, Chrome saved only the first before the kill, then a delete elsewhere: it stays deleted and the order holds", async () => {
  const { a, p } = await savedPair();
  a.with(() => {
    for (const title of ["X", "B", "C"]) S().addBookmark({ profileId: "default", url: `https://${title.toLowerCase()}.example/`, title });
  });
  await settled(a, p);
  const toFront = (title) =>
    a.with(() => {
      const id = idOf(a, title);
      S().moveBookmark(id, S().bookmarks.nodes[id].parentId, 0);
    });
  toFront("C");
  await a.sync();
  await p.sync();
  p.chromeSaves();
  toFront("B");
  await a.sync();
  await p.sync();
  assert.deepEqual(titles(p), titles(a));
  p.killed();
  a.with(() => S().removeBookmark(idOf(a, "C")));
  await a.sync();
  assert.equal((await p.sync()).published, 0, "neither stale order is sent as this Mac's edit");
  await syncAll([p, a], 3);
  assert.deepEqual(titles(a).flat(), ["B", "X"]);
  assert.deepEqual(titles(p), titles(a));
});

test("history: Chrome committed only the first of two synced visit sets before the kill, then the page is deleted elsewhere: it stays deleted", async () => {
  const { a, p } = await savedPair();
  const url = "https://visited.example/";
  const times = [Date.now() - 90_000, Date.now() - 60_000, Date.now() - 30_000];
  const visit = (list) => ({ url, title: "Visited", favicon: null, visits: list.length, lastVisit: list.at(-1), visitTimes: list });
  const setVisits = (list) => a.with(() => useBrowser.setState({ history: { "": { list: list ? [visit(list)] : [], floor: -Infinity, ready: true } } }));
  const timesOn = (mac) => mac.with(() => historyOf(S(), "default").find((e) => e.url === url)?.visitTimes);
  setVisits(times.slice(0, 1));
  await settled(a, p);
  setVisits(times.slice(0, 2));
  await a.sync();
  await p.sync();
  p.chromeSaves();
  setVisits(times);
  await a.sync();
  await p.sync();
  assert.deepEqual(timesOn(p), times);
  p.killed();
  assert.deepEqual(timesOn(p), times.slice(0, 2));
  setVisits(null);
  await a.sync();
  await syncAll([p, a], 3);
  assert.equal(timesOn(a), undefined);
  assert.equal(timesOn(p), undefined);
});

test("history: Chrome kept two of the three visits it was given before the kill: the third is applied again, not lost", async () => {
  const { a, p } = await savedPair();
  const url = "https://visited.example/";
  const times = [Date.now() - 90_000, Date.now() - 60_000, Date.now() - 30_000];
  const visit = (list) => ({ url, title: "Visited", favicon: null, visits: list.length, lastVisit: list.at(-1), visitTimes: list });
  const timesOn = (mac) => mac.with(() => historyOf(S(), "default").find((e) => e.url === url)?.visitTimes);
  a.with(() => useBrowser.setState({ history: { "": { list: [visit(times.slice(0, 1))], floor: -Infinity, ready: true } } }));
  await settled(a, p);
  a.with(() => useBrowser.setState({ history: { "": { list: [visit(times)], floor: -Infinity, ready: true } } }));
  await a.sync();
  await p.sync();
  assert.deepEqual(timesOn(p), times);
  p.disk = { ...p.disk, history: { "": { list: [visit(times.slice(0, 2))], floor: -Infinity, ready: true } } };
  p.killed();
  assert.deepEqual(timesOn(p), times.slice(0, 2));
  await syncAll([p, a], 2);
  assert.deepEqual(timesOn(p), times);
  assert.deepEqual(timesOn(a), times);
});

test("history: a visit applied again after one crash is applied again after a second crash before Chrome saved it", async () => {
  const { a, p } = await savedPair();
  const url = "https://visited.example/";
  const times = [Date.now() - 90_000, Date.now() - 60_000, Date.now() - 30_000];
  const visit = (list) => ({ url, title: "Visited", favicon: null, visits: list.length, lastVisit: list.at(-1), visitTimes: list });
  const timesOn = (mac) => mac.with(() => historyOf(S(), "default").find((e) => e.url === url)?.visitTimes);
  a.with(() => useBrowser.setState({ history: { "": { list: [visit(times.slice(0, 1))], floor: -Infinity, ready: true } } }));
  await settled(a, p);
  a.with(() => useBrowser.setState({ history: { "": { list: [visit(times)], floor: -Infinity, ready: true } } }));
  await a.sync();
  await p.sync();
  p.disk = { ...p.disk, history: { "": { list: [visit(times.slice(0, 2))], floor: -Infinity, ready: true } } };
  p.killed();
  await p.sync();
  assert.deepEqual(timesOn(p), times);
  p.killed();
  assert.deepEqual(timesOn(p), times.slice(0, 2));
  await syncAll([p, a], 2);
  assert.deepEqual(timesOn(p), times);
});

test("history: Chrome saved a synced deletion but not the visits added with it, and the page is visited again elsewhere: the visit survives on both", async () => {
  const { a, p } = await savedPair();
  const visit = (url, at) => ({ url, title: url, favicon: null, visits: 1, lastVisit: at, visitTimes: [at] });
  const urls = { x: "https://x.example/", y: "https://y.example/", z: "https://z.example/" };
  const setList = (list) => a.with(() => useBrowser.setState({ history: { "": { list, floor: -Infinity, ready: true } } }));
  const urlsOn = (mac) => mac.with(() => historyOf(S(), "default").map((e) => e.url).sort());
  setList([visit(urls.x, Date.now() - 90_000)]);
  await settled(a, p);
  setList([visit(urls.y, Date.now() - 60_000), visit(urls.z, Date.now() - 50_000)]);
  await a.sync();
  await p.sync();
  assert.deepEqual(urlsOn(p), [urls.y, urls.z]);
  p.disk = { ...p.disk, history: { "": { list: [], floor: -Infinity, ready: true } } };
  p.killed();
  setList([visit(urls.x, Date.now() - 1_000), visit(urls.y, Date.now() - 60_000), visit(urls.z, Date.now() - 50_000)]);
  await a.sync();
  assert.equal((await p.sync()).published, 0, "no fresh tombstone for the deletion Chrome already saved");
  await syncAll([p, a], 3);
  assert.deepEqual(urlsOn(a), [urls.x, urls.y, urls.z]);
  assert.deepEqual(urlsOn(p), urlsOn(a));
});

test("bookmarks: a rename whose write to Chrome timed out isn't sent over a deletion that arrives more than 30 s later", async () => {
  const { a, p } = await savedPair();
  a.with(() => S().addBookmark({ profileId: "default", url: "https://kept.example/", title: "Kept" }));
  a.with(() => S().addBookmark({ profileId: "default", url: "https://renamed.example/", title: "Before" }));
  await settled(a, p);
  a.with(() => S().updateBookmark(idOf(a, "Before"), { title: "After" }));
  await a.sync();
  p.bookmarksReportFailure = true;
  await p.sync();
  p.bookmarksReportFailure = false;
  assert.ok(titles(p).flat().includes("After"), "the store holds the rename Chrome never confirmed");
  a.with(() => S().removeBookmark(idOf(a, "After")));
  await a.sync();
  p.steady += 31_000;
  assert.equal((await p.sync()).published, 0, "the unconfirmed rename isn't sent as this Mac's edit");
  await syncAll([a, p], 2);
  assert.deepEqual(titles(a).flat(), ["Kept"]);
  assert.deepEqual(titles(p), titles(a));
});
