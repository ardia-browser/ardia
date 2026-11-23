import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;
const { useBrowser, storeTransaction } = await import("../browser/store.ts");
const { watchTab, watchedTabs, tabSnapshot, shallowEqual } = await import("./tabWatch.ts");

const S = () => useBrowser.getState();
const setup = () => {
  S().hydrate({});
  const w = S().createWindow({ url: "https://a.com" });
  const a = S().windows[w].tabIds[0];
  const b = S().newTab(w, { url: "https://b.com", background: true });
  return { w, a, b };
};

test("a watcher wakes for its tab's changes only", () => {
  const { a, b } = setup();
  const woke = { a: 0, b: 0 };
  const offA = watchTab(a, () => woke.a++);
  const offB = watchTab(b, () => woke.b++);
  S().updateTab(a, { title: "A" });
  assert.deepEqual(woke, { a: 1, b: 0 });
  S().updateLive(b, { isLoading: true });
  assert.deepEqual(woke, { a: 1, b: 0 }, "live state isn't the tab");
  S().updateTab(b, { title: "B" });
  assert.deepEqual(woke, { a: 1, b: 1 });
  S().updateSettings({ bookmarksBar: "always" });
  assert.deepEqual(woke, { a: 1, b: 1 }, "other keys don't wake it");
  offA();
  S().updateTab(a, { title: "A2" });
  assert.equal(woke.a, 1, "unsubscribed");
  offB();
  assert.equal(watchedTabs(), 0, "nothing left behind");
});

test("closing a watched tab wakes it; several watchers of one tab all wake", () => {
  const { a, b } = setup();
  const woke = [];
  const offs = [watchTab(b, () => woke.push(1)), watchTab(b, () => woke.push(2)), watchTab(a, () => woke.push("a"))];
  S().closeTab(b);
  assert.deepEqual(woke.filter((x) => x !== "a").sort(), [1, 2]);
  for (const off of offs) off();
  assert.equal(watchedTabs(), 0);
});

test("a watcher that unsubscribes another while waking doesn't break the loop", () => {
  const { a } = setup();
  const woke = [];
  let offSecond = () => {};
  const offFirst = watchTab(a, () => {
    woke.push(1);
    offSecond();
  });
  offSecond = watchTab(a, () => woke.push(2));
  S().updateTab(a, { title: "x" });
  assert.deepEqual(woke, [1, 2], "the listeners of one update are the ones there when it started");
  S().updateTab(a, { title: "y" });
  assert.deepEqual(woke, [1, 2, 1]);
  offFirst();
});

test("a snapshot keeps its value while the tab object is the same, and an equal value across changes", () => {
  const { a } = setup();
  let calls = 0;
  const get = tabSnapshot(
    a,
    (t) => {
      calls++;
      return { url: t?.url, zoom: t?.zoom ?? 1 };
    },
    shallowEqual,
  );
  const first = get();
  assert.equal(get(), first);
  assert.equal(calls, 1, "the same tab isn't selected again");
  S().updateTab(a, { title: "new title" });
  const second = get();
  assert.equal(second, first, "an equal value is the same snapshot");
  assert.equal(calls, 2);
  S().updateTab(a, { zoom: 1.25 });
  const third = get();
  assert.notEqual(third, first);
  assert.equal(third.zoom, 1.25);
  S().closeTab(a);
  assert.equal(get().url, undefined, "a closed tab reads as missing");
});

test("a watcher that unsubscribes another while two tabs change at once stops it from waking, as before", () => {
  const { w, a, b } = setup();
  const c = S().newTab(w, { url: "https://c.com", background: true });
  const woke = [];
  let offA = () => {};
  const offB = watchTab(b, () => {
    woke.push("b");
    offA();
  });
  offA = watchTab(a, () => woke.push("a"));
  const offC = watchTab(c, () => woke.push("c"));
  storeTransaction(() => {
    S().updateTab(a, { title: "A" });
    S().updateTab(b, { title: "B" });
  });
  assert.deepEqual(woke, ["b"], "b is watched first; its callback unsubscribed a before a's turn");
  offB();
  offC();
  assert.equal(watchedTabs(), 0);
});

test("a sole watcher that unsubscribes itself and watches the same tab again wakes the new watcher too, as before", () => {
  const { a, b } = setup();
  const offB = watchTab(b, () => {});
  const woke = [];
  let offFirst = () => {};
  let offReplacement = () => {};
  offFirst = watchTab(a, () => {
    woke.push("first");
    offFirst();
    offReplacement = watchTab(a, () => woke.push("replacement"));
  });
  S().updateTab(a, { title: "one tab changed" });
  assert.deepEqual(woke, ["first", "replacement"]);
  S().updateTab(a, { title: "again" });
  assert.deepEqual(woke, ["first", "replacement", "replacement"], "the replacement stays subscribed");
  offReplacement();
  offB();
  assert.equal(watchedTabs(), 0);
});


test("a watcher that watches its tab again on its first call and stops on its second is called twice and removed, as before", () => {
  const { a } = setup();
  let calls = 0;
  let off = () => {};
  const listener = () => {
    calls++;
    off();
    if (calls === 1) off = watchTab(a, listener);
  };
  off = watchTab(a, listener);
  S().updateTab(a, { title: "x" });
  assert.equal(calls, 2);
  assert.equal(watchedTabs(), 0, "removed");
  S().updateTab(a, { title: "y" });
  assert.equal(calls, 2);
});

function random(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mainWatchers() {
  const watchers = new Map();
  const watch = (tabId, listener) => {
    let listeners = watchers.get(tabId);
    if (!listeners) watchers.set(tabId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && watchers.get(tabId) === listeners) watchers.delete(tabId);
    };
  };
  const wake = (changed) => {
    for (const [id, listeners] of watchers) {
      if (!changed.includes(id)) continue;
      for (const listener of [...listeners]) listener();
    }
  };
  return { watch, wake };
}

function scripted(rand, tabs, count) {
  const specs = Array.from({ length: count }, (_, i) => ({ label: `w${i}`, tab: tabs[Math.floor(rand() * tabs.length)], initial: i < count / 2 || rand() < 0.2 }));
  const kinds = ["offSelf", "again", "sub", "offOther", "nothing"];
  for (const spec of specs) {
    spec.script = Array.from({ length: Math.floor(rand() * 4) }, () =>
      Array.from({ length: Math.floor(rand() * 3) }, () => ({ kind: kinds[Math.floor(rand() * kinds.length)], other: specs[Math.floor(rand() * specs.length)]?.label ?? `w0` })),
    );
  }
  return specs;
}

function run(specs, watch, wakeA, wakeAll) {
  const calls = [];
  const live = new Map();
  const fns = new Map();
  let acting = true;
  const byLabel = new Map(specs.map((spec) => [spec.label, spec]));
  const subscribe = (label) => {
    const spec = byLabel.get(label);
    live.get(label)?.();
    live.set(label, watch(spec.tab, fns.get(label)));
  };
  for (const spec of specs) {
    let n = 0;
    fns.set(spec.label, () => {
      calls.push(spec.label);
      if (!acting) return;
      for (const step of spec.script[n++] ?? []) {
        if (step.kind === "offSelf" || (step.kind === "offOther" && live.has(step.other))) {
          const label = step.kind === "offSelf" ? spec.label : step.other;
          live.get(label)?.();
          live.delete(label);
        } else if (step.kind === "again") {
          live.get(spec.label)?.();
          live.set(spec.label, watch(spec.tab, fns.get(spec.label)));
        } else if (step.kind === "sub") subscribe(step.other);
      }
    });
  }
  for (const spec of specs) if (spec.initial) subscribe(spec.label);
  wakeA();
  const during = [...calls];
  acting = false;
  calls.length = 0;
  wakeAll();
  const after = [...calls];
  for (const off of live.values()) off();
  return { during, after };
}

test("one changed tab wakes watchers exactly as main's watcher walk did, on random subscribe and unsubscribe scripts", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rand = random(seed);
    const { a, b } = setup();
    const c = S().newTab(S().tabs[a].windowId, { url: "https://c.com", background: true });
    const specs = scripted(rand, [a, a, b, c], 3 + Math.floor(rand() * 6));
    const reference = mainWatchers();
    const expected = run(specs, reference.watch, () => reference.wake([a]), () => {
      reference.wake([a]);
      reference.wake([b]);
      reference.wake([c]);
    });
    const actual = run(specs, watchTab, () => S().updateTab(a, { title: `seed ${seed}` }), () => {
      S().updateTab(a, { title: `after ${seed}` });
      S().updateTab(b, { title: `after ${seed}` });
      S().updateTab(c, { title: `after ${seed}` });
    });
    assert.deepEqual(actual, expected, `seed ${seed}`);
    assert.equal(watchedTabs(), 0, `seed ${seed} leaves nothing behind`);
  }
});
