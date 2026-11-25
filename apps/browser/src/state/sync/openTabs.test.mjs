import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { Clock, compact, emptyScope, syncScope } = await import("@ardia/sync");
const pinnedArea = await import("./pinned.ts");
const previous = await import("./fixtures/pinned-v0.2.40.ts");
const openTabs = await import("./openTabs.ts");
const { openTabsClosed, noteTabClosedByUser } = await import("./openTabCloses.ts");
const { spaceOpenTabsAdapter } = await import("./profileAdapters.ts");
const { pinKeyOf } = await import("../browser/model.ts");

const S = () => useBrowser.getState();
const P = "default";

class Folder {
  files = new Map();
  counter = 0;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        const shown = [...this.files].filter(([, f]) => f.scope === scope);
        const files = shown.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
        return { files, pending: [], damaged: [], present: shown.map(([id]) => id) };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

class Device {
  constructor(id, folder, { old = false, browser = null, scope = null } = {}) {
    this.id = id;
    this.folder = folder;
    this.old = old;
    this.closes = [];
    this.retire = false;
    if (browser) S().hydrate(browser);
    else {
      S().hydrate({});
      S().updateSpace(P, { syncTabs: true });
    }
    this.browser = S();
    this.scope = scope ?? emptyScope();
    this.clock = new Clock(id);
    this.flagAt = this.clock.tick();
  }
  setOption(on) {
    this.with(() => S().updateSpace(P, { syncTabs: on || undefined }));
    this.flagAt = this.clock.tick();
  }
  note(next, prev) {
    for (const { key } of openTabsClosed(next, prev)) if (!this.closes.includes(key)) this.closes.push(key);
  }
  ledger() {
    return {
      keys: () => this.closes,
      settle: (keys) => (this.closes = this.closes.filter((k) => !keys.includes(k))),
    };
  }
  mode() {
    return S().spaces[P]?.syncTabs ? "on" : this.retire ? "retire" : "off";
  }
  with(fn) {
    useBrowser.setState(this.browser, true);
    try {
      const before = S();
      const out = fn();
      this.note(S(), before);
      return out;
    } finally {
      this.browser = S();
    }
  }
  async sync() {
    useBrowser.setState(this.browser, true);
    try {
      const before = S();
      const adapters = this.old
        ? [previous.pinnedRowsAdapter(P), previous.pinnedAdapter(P)]
        : [...pinnedArea.pinnedAreaAdapters(P), ...openTabs.openTabsAdapters(P, this.scope, this.mode(), this.ledger(), () => this.flagAt)];
      const result = await syncScope({ scope: "p", state: this.scope, transport: this.folder.transport(), adapters, clock: this.clock, device: this.id });
      this.note(S(), before);
      return result;
    } finally {
      this.browser = S();
    }
  }
}

async function syncAll(devices, rounds = 2) {
  for (let i = 0; i < rounds; i++) for (const d of devices) await d.sync();
}

const host = (t) => new URL(t.url).hostname.replace(".example", "");
const web = (t) => /^https:/.test(t.url);
const regular = (d) => d.with(() => Object.values(S().tabs).filter((t) => web(t) && !t.pin).map(host).sort());
const order = (d) => d.with(() => S().windowOrder.flatMap((w) => S().windows[w].tabIds.map((id) => S().tabs[id]).filter((t) => web(t) && !t.pin).map(host)));
const tabByHost = (d, h) => d.with(() => Object.values(S().tabs).find((t) => web(t) && host(t) === h));
const record = (d, key) => d.scope.records[`otab:t:${key}`]?.v;

function open(d, hosts, windowId = null) {
  return d.with(() => {
    const w = windowId ?? S().createWindow({});
    const ids = hosts.map((h) => S().newTab(w, { url: `https://${h}.example/`, background: true }));
    ids.forEach((id, i) => S().updateTab(id, { title: hosts[i] }));
    return { w, ids };
  });
}

async function pair(hosts = ["mail", "docs"]) {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const b = new Device("devB", folder);
  const opened = open(a, hosts);
  const bw = b.with(() => S().createWindow({}));
  await syncAll([a, b]);
  return { folder, a, b, ...opened, bw };
}

test("a tab opened on one Mac arrives on the other unloaded, in the background, and nothing echoes back", async () => {
  const { a, b, ids, bw } = await pair();
  assert.deepEqual(order(b), ["mail", "docs"]);
  const mail = tabByHost(b, "mail");
  assert.equal(mail.id, ids[0], "the tab keeps its key as its id");
  assert.equal(mail.page.kind, "idle");
  assert.equal(mail.title, "mail");
  assert.equal(mail.windowId, bw);
  const active = b.with(() => S().windows[bw].activeTabIds[P]);
  assert.ok(!ids.includes(active), "the arriving tabs aren't selected");
  assert.equal((await a.sync()).published, 0);
  assert.equal((await b.sync()).published, 0);
});

test("closing a tab closes it on the other Mac without a recently closed entry there", async () => {
  const { a, b } = await pair();
  b.with(() => S().closeTab(tabByHost(b, "docs").id));
  await syncAll([b, a]);
  assert.deepEqual(regular(a), ["mail"]);
  assert.equal(a.with(() => S().closedTabs.some((c) => c.tab.url.includes("docs"))), false);
  assert.deepEqual(b.closes, [], "the close settles once it's published");
});

test("a selected tab closed elsewhere hands the selection to its neighbour", async () => {
  const { a, b, ids } = await pair(["mail", "docs", "news"]);
  b.with(() => S().activate(ids[1]));
  a.with(() => S().closeTab(ids[1]));
  await syncAll([a, b]);
  const shown = b.with(() => S().activeTabId?.(S().windows[S().windowOrder[0]].id) ?? S().windows[S().windowOrder[0]].activeTabIds[P]);
  assert.ok(shown && shown !== ids[1], "another tab is selected");
  assert.deepEqual(regular(b), ["mail", "news"]);
});

test("reorders made on both Macs merge", async () => {
  const { a, b, ids } = await pair(["mail", "docs", "news"]);
  const [mail, , news] = ids;
  a.with(() => S().moveTab(news, S().windows[S().tabs[mail].windowId].tabIds.indexOf(mail)));
  b.with(() => S().moveTab(mail, S().windows[S().tabs[mail].windowId].tabIds.length - 1));
  await syncAll([a, b, a]);
  assert.deepEqual(order(a), ["news", "docs", "mail"]);
  assert.deepEqual(order(b), order(a));
});

test("a group made on one Mac arrives with its name and colour, and a tab moved out of it on the other goes back", async () => {
  const { a, b, ids } = await pair(["mail", "docs", "news"]);
  a.with(() => S().createGroup([ids[0], ids[1]], { name: "Work", color: "blue" }));
  await syncAll([a, b]);
  const groupOn = (d) => d.with(() => Object.values(S().groups).find((g) => g.name === "Work"));
  const onB = groupOn(b);
  assert.ok(onB, "the group arrives");
  assert.equal(onB.color, "blue");
  assert.deepEqual(onB.tabIds.map((id) => b.with(() => pinKeyOf(S().tabs[id]))).sort(), [ids[0], ids[1]].sort());
  b.with(() => S().removeTabsFromGroup([ids[1]]));
  await syncAll([b, a]);
  assert.deepEqual(groupOn(a).tabIds, [ids[0]]);
  assert.equal((await a.sync()).published, 0);
  assert.equal((await b.sync()).published, 0);
});

test("a page change reaches an unloaded copy, and a loaded copy keeps its page without sending it back", async () => {
  const { a, b, ids } = await pair();
  const [mail, docs] = ids;
  b.with(() => S().updateTab(docs, { page: { kind: "loaded", nav: { url: "https://docs.example/", seq: 1 } } }));
  a.with(() => {
    S().updateTab(mail, { url: "https://mail.example/inbox", title: "Inbox" });
    S().updateTab(docs, { url: "https://docs.example/d2", title: "D2" });
  });
  await syncAll([a, b]);
  assert.equal(tabByHost(b, "mail").url, "https://mail.example/inbox");
  assert.equal(tabByHost(b, "mail").title, "Inbox");
  assert.equal(tabByHost(b, "mail").page.kind, "idle");
  assert.equal(tabByHost(b, "docs").url, "https://docs.example/");
  assert.equal(record(b, docs).u, "https://docs.example/d2");
  assert.equal((await b.sync()).published, 0, "no ping-pong");
  assert.equal((await a.sync()).published, 0);
  b.with(() => S().updateTab(docs, { url: "https://docs.example/d3" }));
  await syncAll([b, a]);
  assert.equal(record(a, docs).u, "https://docs.example/d3", "a navigation on the loaded copy still goes out");
});

test("a pin made on one Mac takes the other Mac's regular tab without doubling, and an unpin gives it back", async () => {
  const { a, b, ids } = await pair();
  const mail = ids[0];
  a.with(() => S().pinTabs([mail], true));
  await syncAll([a, b]);
  const copies = (d) => d.with(() => Object.values(S().tabs).filter((t) => pinKeyOf(t) === mail));
  assert.equal(copies(b).length, 1);
  assert.ok(copies(b)[0].pin, "pinned on B");
  assert.equal(record(b, mail), null);
  a.with(() => S().pinTabs([mail], false));
  await syncAll([a, b]);
  assert.equal(copies(b).length, 1);
  assert.equal(copies(b)[0].pin, null);
  assert.deepEqual(regular(b), ["docs", "mail"]);
  assert.deepEqual(regular(a), ["docs", "mail"]);
});

test("closing the last window leaves the tabs on the other Macs, and the next window brings them back", async () => {
  const { a, b, w } = await pair();
  a.with(() => S().closeWindow(w));
  assert.deepEqual(a.closes, []);
  await syncAll([a, b]);
  assert.deepEqual(regular(b), ["docs", "mail"]);
  a.with(() => S().createWindow({}));
  assert.equal((await a.sync()).published, 0);
  assert.deepEqual(regular(a), ["docs", "mail"]);
  assert.equal(tabByHost(a, "mail").page.kind, "idle");
});

test("bringing the closed window back adopts the synced tabs instead of doubling them", async () => {
  const { a, b, w } = await pair();
  a.with(() => S().closeWindow(w));
  await syncAll([a, b]);
  a.with(() => S().reopenClosedWindow());
  await syncAll([a, b]);
  assert.deepEqual(regular(a), ["docs", "mail"]);
  assert.deepEqual(regular(b), ["docs", "mail"]);
});

test("closing one of two windows closes its tabs everywhere; ⌘W on the last tab counts as closing it", async () => {
  const { a, b, w } = await pair(["mail"]);
  const second = open(a, ["news"]);
  await syncAll([a, b]);
  assert.deepEqual(regular(b), ["mail", "news"]);
  a.with(() => S().closeWindow(second.w));
  await syncAll([a, b]);
  assert.deepEqual(regular(b), ["mail"]);
  const mail = tabByHost(a, "mail").id;
  a.with(() => {
    noteTabClosedByUser(mail);
    S().closeWindow(w);
  });
  await syncAll([a, b]);
  assert.deepEqual(regular(b), []);
});

test("quitting and relaunching with the session restored publishes nothing", async () => {
  const { folder, a, b } = await pair();
  const saved = a.with(() => {
    const s = S();
    const tabs = Object.fromEntries(Object.entries(s.tabs).map(([id, t]) => [id, { ...t, page: { kind: "idle" } }]));
    return { profiles: s.profiles, spaces: s.spaces, spaceOrder: s.spaceOrder, windows: s.windows, windowOrder: s.windowOrder, tabs, groups: s.groups };
  });
  const relaunched = new Device("devA", folder, { browser: saved, scope: JSON.parse(JSON.stringify(a.scope)) });
  relaunched.clock = a.clock;
  assert.equal((await relaunched.sync()).published, 0);
  await b.sync();
  assert.deepEqual(regular(b), ["docs", "mail"]);
  assert.deepEqual(regular(relaunched), ["docs", "mail"]);
});

test("turning the option off on one Mac deletes the records and both Macs keep their tabs; turning it back on doesn't double them", async () => {
  const { a, b, ids } = await pair();
  a.retire = true;
  a.setOption(false);
  await a.sync();
  assert.equal(record(a, ids[0]), null);
  await b.sync();
  assert.deepEqual(regular(b), ["docs", "mail"], "the deletions reach B before the switch does, and B keeps its tabs");
  assert.equal((await b.sync()).published, 0, "and doesn't send them back");
  b.setOption(false);
  await syncAll([b, a]);
  assert.deepEqual(regular(a), ["docs", "mail"]);
  assert.deepEqual(regular(b), ["docs", "mail"]);
  open(b, ["news"], b.with(() => S().windowOrder[0]));
  await syncAll([a, b]);
  assert.deepEqual(regular(a), ["docs", "mail"], "nothing syncs while it's off");
  a.retire = false;
  for (const d of [a, b]) d.setOption(true);
  await syncAll([a, b, a]);
  assert.deepEqual(regular(a), ["docs", "mail", "news"]);
  assert.deepEqual(regular(b), ["docs", "mail", "news"]);
});

test("a Mac that turned the option off and hears of it coming back on in the tab records first doesn't delete them", async () => {
  const { a, b } = await pair();
  a.retire = true;
  a.setOption(false);
  await a.sync();
  b.setOption(false);
  await b.sync();
  b.setOption(true);
  open(b, ["news"], b.with(() => S().windowOrder[0]));
  await syncAll([b, a, b]);
  assert.equal(record(a, tabByHost(b, "news").id).u, "https://news.example/", "A, still off, leaves B's new records alone");
  a.retire = false;
  a.setOption(true);
  await syncAll([a, b, a]);
  assert.deepEqual(regular(a), ["docs", "mail", "news"]);
  assert.deepEqual(regular(b), ["docs", "mail", "news"]);
});

test("a synced tab closed after it navigated to a page that doesn't sync stays closed", async () => {
  const { a, b, ids } = await pair();
  a.with(() => S().updateTab(ids[1], { url: "file:///tmp/notes.txt" }));
  await syncAll([a, b]);
  a.with(() => S().closeTab(ids[1]));
  await syncAll([a, b, a]);
  assert.deepEqual(regular(a), ["mail"]);
  assert.deepEqual(regular(b), ["mail"]);
});

test("the option itself syncs between Macs", async () => {
  const folder = new Folder();
  const app = (id) => {
    const d = new Device(id, folder);
    d.with(() => S().updateSpace(P, { syncTabs: undefined }));
    d.sync = async function () {
      useBrowser.setState(this.browser, true);
      try {
        return await syncScope({ scope: "app", state: this.scope, transport: folder.transport(), adapters: [spaceOpenTabsAdapter(() => ({ [P]: { syncId: "s1" } }))], clock: this.clock, device: this.id });
      } finally {
        this.browser = S();
      }
    };
    return d;
  };
  const a = app("devA");
  const b = app("devB");
  await syncAll([a, b]);
  a.with(() => S().updateSpace(P, { syncTabs: true }));
  await syncAll([a, b]);
  assert.equal(b.with(() => S().spaces[P].syncTabs), true);
  b.with(() => S().updateSpace(P, { syncTabs: undefined }));
  await syncAll([b, a]);
  assert.equal(a.with(() => S().spaces[P].syncTabs), undefined);
});

test("a Mac on a released version keeps the records untouched, through its own snapshot too", async () => {
  const { folder, a, ids } = await pair();
  const old = new Device("devOld", folder, { old: true });
  old.with(() => S().createWindow({}));
  await syncAll([old, a]);
  assert.equal(record(old, ids[0]).u, "https://mail.example/");
  await compact(old.scope, folder.transport(), "p", "devOld", Date.now(), {}, true);
  const ops = [...folder.files.values()].map((f) => JSON.parse(f.payload)).filter((f) => f.device === "devOld" && f.kind === "log").flatMap((f) => f.ops);
  assert.ok(!ops.some((op) => op.k.startsWith("otab:")), "it never writes the new keys");
  const fresh = new Device("devC", folder);
  fresh.with(() => S().createWindow({}));
  await syncAll([fresh]);
  assert.deepEqual(regular(fresh), ["docs", "mail"]);
});

test("private, peek, blank and file tabs never publish", async () => {
  const folder = new Folder();
  const a = new Device("devA", folder);
  const { w, ids } = open(a, ["mail"]);
  a.with(() => {
    S().newTab(w, { background: true });
    S().newTab(w, { url: "file:///tmp/notes.txt", background: true });
    const priv = S().createWindow({ kind: "private", url: "https://secret.example/" });
    S().newTab(priv, { url: "https://secret2.example/", background: true });
    S().activate(ids[0]);
    S().openPeek(ids[0], "https://peek.example/");
  });
  await a.sync();
  const keys = Object.keys(a.scope.records).filter((k) => k.startsWith("otab:t:"));
  assert.deepEqual(keys, [`otab:t:${ids[0]}`]);
});

test("closing the window and bringing it back before the next sync doesn't double its tabs", async () => {
  const { a, b, w } = await pair();
  a.with(() => S().closeWindow(w));
  a.with(() => S().reopenClosedWindow());
  await syncAll([a, b, a]);
  assert.deepEqual(regular(a), ["docs", "mail"]);
  assert.deepEqual(regular(b), ["docs", "mail"]);
});

test("closing the last window and opening a fresh one before the next sync brings the tabs back", async () => {
  const { a, b, w } = await pair();
  a.with(() => S().closeWindow(w));
  a.with(() => S().createWindow({}));
  await syncAll([a, b]);
  assert.deepEqual(regular(a), ["docs", "mail"]);
  assert.deepEqual(regular(b), ["docs", "mail"]);
});

test("Macs that spread the same tabs over different windows settle instead of resending the order", async () => {
  const { a, b, ids } = await pair(["t1", "t2", "t3", "t4"]);
  const [t1, t2, t3, t4] = ids;
  a.with(() => S().createWindow({ tabIds: [t2, t4] }));
  b.with(() => S().createWindow({ tabIds: [t3, t4] }));
  await syncAll([a, b], 4);
  let sent = 0;
  for (let i = 0; i < 4; i++) sent += (await a.sync()).published + (await b.sync()).published;
  assert.equal(sent, 0);
  assert.deepEqual(regular(a), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(regular(b), regular(a));
  assert.ok(t1);
});
