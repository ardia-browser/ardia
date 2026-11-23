import { pathToFileURL } from "node:url";

const MAX_WINDOWS = 3;
const MAX_PROFILES = 3;
const MAX_TABS = 24;
const STEP_MS = 1000;

export const ACTION_WEIGHTS = {
  openTab: 14,
  openTabInProfile: 6,
  closeTab: 8,
  select: 8,
  moveTab: 4,
  moveToWindow: 3,
  pin: 6,
  unpin: 3,
  group: 3,
  ungroup: 2,
  addToGroup: 2,
  leaveGroup: 2,
  newWindow: 4,
  closeWindow: 4,
  switchProfile: 4,
  createProfile: 2,
  deleteProfile: 1,
  shareTabs: 2,
  sleepTab: 3,
  reopenTab: 3,
  reopenWindow: 2,
  syncPatch: 2,
  saveReload: 2,
  quitRelaunch: 1,
};

const PICKS_PER_STEP = 4;

export function installClock() {
  const clock = { now: Date.UTC(2026, 10, 20, 12) };
  Date.now = () => clock.now;
  return clock;
}

const VIRTUAL_TIMER_MS = 20;

const shortTimers = [];

export function installTimerLedger() {
  const live = new Set();
  let ids = 0;
  const handle = (callback, args) => {
    const h = { id: ++ids, callback, args, unref: () => h, ref: () => h, hasRef: () => false, refresh: () => h, [Symbol.toPrimitive]: () => h.id };
    return h;
  };
  globalThis.setTimeout = (callback, ms = 0, ...args) => {
    const h = handle(callback, args);
    live.add(h);
    if (ms < VIRTUAL_TIMER_MS) shortTimers.push(h);
    return h;
  };
  globalThis.clearTimeout = (h) => {
    if (h != null) live.delete(h);
  };
  globalThis.requestAnimationFrame = (callback) => globalThis.setTimeout(() => callback(Date.now()), 16);
  globalThis.cancelAnimationFrame = (h) => globalThis.clearTimeout(h);
  globalThis.setInterval = () => {
    const h = handle(null, []);
    live.add(h);
    return h;
  };
  globalThis.clearInterval = (h) => {
    if (h != null) live.delete(h);
  };
  return { pending: () => live.size, live };
}

function runShortTimers(live) {
  const due = shortTimers.splice(0);
  for (const h of due) {
    if (!live.has(h)) continue;
    live.delete(h);
    h.callback(...h.args);
  }
}

let ledger = null;
export const turn = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  if (ledger) runShortTimers(ledger.live);
  await Promise.resolve();
};


export async function loadModules(src) {
  const root = pathToFileURL(src.endsWith("/") ? src : `${src}/`);
  const at = (path) => import(new URL(path, root).href);
  const optional = async (path) => {
    try {
      return await at(path);
    } catch {
      return null;
    }
  };
  const [store, model, groups, persist, stub, sync, pinned, tabLive, reopen] = await Promise.all([
    at("state/browser/store.ts"),
    at("state/browser/model.ts"),
    at("state/groups/groups.ts"),
    at("state/session/persist.ts"),
    at("test-native/index.ts"),
    optional("platform/sync.ts"),
    optional("state/sync/pinned.ts"),
    optional("state/tabs/tabLive.ts"),
    optional("state/windows/reopenClosed.ts"),
  ]);
  return { root, at, optional, store, model, groups, persist, stub, sync, pinned, tabLive, reopen };
}

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

export function pinKeysOf(world, s) {
  const { inPinnedContainer, pinKeyOf } = world.modules.model;
  const keys = new Map();
  const add = (profileId, key) => {
    if (!keys.has(profileId)) keys.set(profileId, new Set());
    keys.get(profileId).add(key);
  };
  for (const t of Object.values(s.tabs)) {
    const w = s.windows[t.windowId];
    if (!w || w.kind === "private" || w.kind === "small") continue;
    if (inPinnedContainer(s, t.id)) add(t.profileId, pinKeyOf(t));
  }
  for (const [profileId, park] of Object.entries(s.parkedPins ?? {})) for (const t of park.tabs ?? []) add(profileId, t.id);
  return keys;
}

const snapshot = (s) => JSON.parse(JSON.stringify(s));

export function createWorld(modules, { clock, timers }) {
  ledger = timers;
  const { useBrowser } = modules.store;
  const S = () => useBrowser.getState();
  const world = { modules, clock, timers, S, useBrowser, urlCounter: 0, folder: null, peer: null };
  const nextUrl = () => `https://s${++world.urlCounter}.example/`;
  const settleTurns = async (n = 4) => {
    for (let i = 0; i < n; i++) await turn();
  };

  const regularWindows = () => S().windowOrder.filter((id) => S().windows[id] && (S().windows[id].kind ?? "main") === "main");
  const pick = (list, r) => (list.length ? list[r % list.length] : undefined);
  const shownIn = (w) => modules.model.viewTabIds(S(), w);
  const allTabs = () => regularWindows().flatMap((w) => S().windows[w].tabIds.filter((id) => S().tabs[id]));
  const keyOf = (id) => modules.model.pinKeyOf(S().tabs[id]);
  const pinnedTabs = () => allTabs().filter((id) => modules.model.inPinnedContainer(S(), id));
  const groups = () => Object.values(S().groups).filter((g) => S().windows[g.windowId]);
  const groupKeys = (g) => g.tabIds.filter((id) => S().tabs[id]).map(keyOf);

  async function flushSession() {
    const { flushPersistence } = modules.persist;
    flushPersistence();
    for (let i = 0; i < 4; i++) {
      await turn();
      flushPersistence();
    }
  }

  function makePeer() {
    if (!modules.sync || !modules.pinned) return null;
    S().hydrate({});
    S().createWindow({ url: "https://peer-home.example/" });
    return { id: "peer", state: S(), scope: modules.sync.emptyScope(), clock: new modules.sync.Clock("peer") };
  }

  world.reset = async () => {
    modules.stub.docs?.clear?.();
    world.urlCounter = 0;
    world.folder = new Folder();
    world.peer = makePeer();
    world.self = modules.sync ? { id: "self", scope: modules.sync.emptyScope(), clock: new modules.sync.Clock("self") } : null;
    S().hydrate({});
    S().createWindow({ url: nextUrl() });
    await flushSession();
  };

  async function syncDevice(device) {
    const adapters = modules.pinned.pinnedAreaAdapters("default");
    const result = await modules.sync.syncScope({ scope: "p", state: device.scope, transport: world.folder.transport(), adapters, clock: device.clock, device: device.id });
    return result;
  }

  const actions = {
    openTab([w, bg]) {
      if (allTabs().length >= MAX_TABS) return null;
      const windowId = pick(regularWindows(), w);
      if (!windowId) return null;
      const id = S().newTab(windowId, { url: nextUrl(), background: bg % 2 === 0 });
      return { detail: `newTab(${windowId}) -> ${id}` };
    },
    openTabInProfile([w, p, bg]) {
      if (allTabs().length >= MAX_TABS) return null;
      const windowId = pick(regularWindows(), w);
      const profileId = pick(S().profileOrder, p);
      if (!windowId || !profileId) return null;
      const id = S().newTab(windowId, { url: nextUrl(), profileId, background: bg % 2 === 0 });
      return { detail: `newTab(${windowId}, profile ${profileId}) -> ${id}` };
    },
    closeTab([t]) {
      const id = pick(allTabs(), t);
      if (!id) return null;
      S().closeTab(id);
      return { detail: `closeTab(${id})` };
    },
    select([w, t]) {
      const windowId = pick(regularWindows(), w);
      const id = windowId && pick(shownIn(windowId), t);
      if (!id) return null;
      S().activate(id);
      return { detail: `activate(${id})` };
    },
    moveTab([t, to]) {
      const id = pick(allTabs(), t);
      if (!id) return null;
      const w = S().windows[S().tabs[id].windowId];
      const index = to % Math.max(w.tabIds.length, 1);
      S().moveTab(id, index);
      return { detail: `moveTab(${id}, ${index})` };
    },
    moveToWindow([t, w]) {
      const id = pick(allTabs(), t);
      const windowId = pick(regularWindows(), w);
      if (!id || !windowId || S().tabs[id].windowId === windowId) return null;
      S().moveTabsToWindow([id], windowId);
      return { detail: `moveTabsToWindow([${id}], ${windowId})` };
    },
    pin([t, row]) {
      const id = pick(
        allTabs().filter((x) => !S().tabs[x].pin),
        t,
      );
      if (!id) return null;
      S().pinTabs([id], true, row % 3 === 0);
      return { detail: `pinTabs([${id}], true${row % 3 === 0 ? ", row" : ""})`, pinned: [id] };
    },
    unpin([t]) {
      const id = pick(
        allTabs().filter((x) => S().tabs[x].pin),
        t,
      );
      if (!id) return null;
      const removes = { [S().tabs[id].profileId]: [keyOf(id)] };
      S().pinTabs([id], false);
      return { detail: `pinTabs([${id}], false)`, removes, keeps: [id] };
    },
    group([t, n, pinned]) {
      const list = allTabs().filter((x) => !groups().some((g) => g.tabIds.includes(x)));
      const first = pick(list, t);
      if (!first) return null;
      const same = list.filter((x) => S().tabs[x].windowId === S().tabs[first].windowId && S().tabs[x].profileId === S().tabs[first].profileId);
      const ids = [first, ...same.filter((x) => x !== first).slice(0, n % 3)];
      const asPinned = pinned % 2 === 0;
      const groupId = S().groupTabs(ids, { pinned: asPinned, name: `G${world.urlCounter}` });
      return { detail: `groupTabs([${ids}], pinned ${asPinned}) -> ${groupId}` };
    },
    ungroup([g]) {
      const group = pick(groups(), g);
      if (!group) return null;
      const removes = group.pinned ? { [group.profileId]: groupKeys(group) } : undefined;
      const members = group.tabIds.filter((x) => S().tabs[x]);
      S().ungroup(group.id);
      return { detail: `ungroup(${group.id})`, removes, keeps: members };
    },
    addToGroup([g, t]) {
      const group = pick(groups(), g);
      if (!group) return null;
      const id = pick(
        allTabs().filter((x) => S().tabs[x].windowId === group.windowId && S().tabs[x].profileId === group.profileId && !group.tabIds.includes(x)),
        t,
      );
      if (!id) return null;
      const leavesPins = !group.pinned && modules.model.inPinnedContainer(S(), id);
      const removes = leavesPins ? { [group.profileId]: [keyOf(id)] } : undefined;
      S().addTabsToGroup(group.id, [id]);
      return { detail: `addTabsToGroup(${group.id}, [${id}])`, removes, keeps: [id] };
    },
    leaveGroup([g, t]) {
      const group = pick(groups(), g);
      const id = group && pick(group.tabIds.filter((x) => S().tabs[x]), t);
      if (!id) return null;
      const removes = group.pinned ? { [group.profileId]: [keyOf(id)] } : undefined;
      S().removeTabsFromGroup([id]);
      return { detail: `removeTabsFromGroup([${id}]) from ${group.id}`, removes, keeps: [id] };
    },
    newWindow([p]) {
      if (regularWindows().length >= MAX_WINDOWS) return null;
      const profileId = pick(S().profileOrder, p);
      const id = S().createWindow({ url: nextUrl(), profileId });
      return { detail: `createWindow(profile ${profileId}) -> ${id}` };
    },
    closeWindow([w]) {
      const windowId = pick(regularWindows(), w);
      if (!windowId) return null;
      S().closeWindow(windowId);
      return { detail: `closeWindow(${windowId})` };
    },
    switchProfile([w, p]) {
      const windowId = pick(regularWindows(), w);
      const profileId = pick(S().profileOrder, p);
      if (!windowId || !profileId || S().windows[windowId].profileId === profileId) return null;
      S().switchProfile(windowId, profileId);
      return { detail: `switchProfile(${windowId}, ${profileId})` };
    },
    createProfile() {
      if (S().profileOrder.length >= MAX_PROFILES) return null;
      const id = S().createProfile({ name: `P${S().profileOrder.length}` });
      return { detail: `createProfile() -> ${id}` };
    },
    deleteProfile([p]) {
      const profileId = pick(
        S().profileOrder.filter((id) => id !== S().settings.defaultProfileId),
        p,
      );
      if (!profileId) return null;
      S().deleteProfile(profileId);
      return { detail: `deleteProfile(${profileId})`, removesProfile: profileId };
    },
    shareTabs([on]) {
      const next = on % 2 === 0;
      if (!!S().settings.shareTabsAcrossWindows === next) return null;
      S().updateSettings({ shareTabsAcrossWindows: next });
      return { detail: `updateSettings({ shareTabsAcrossWindows: ${next} })` };
    },
    sleepTab([t]) {
      const id = pick(allTabs(), t);
      if (!id) return null;
      const { inPinnedContainer } = modules.model;
      if (inPinnedContainer(S(), id)) S().closeTabs([id]);
      else S().updateTab(id, { page: { kind: "asleep" } });
      return { detail: `sleep(${id})` };
    },
    reopenTab([w]) {
      const windowId = pick(regularWindows(), w);
      if (!windowId || !S().closedTabs.length) return null;
      const expected = modules.reopen?.lastClosedTab?.(S(), windowId);
      return { detail: `reopenClosedTab(${windowId})`, reopen: () => S().reopenClosedTab(windowId), expected };
    },
    reopenWindow() {
      if (!S().closedWindows.length || regularWindows().length >= MAX_WINDOWS) return null;
      return { detail: "reopenClosedWindow()", reopen: () => S().reopenClosedWindow(), expected: S().closedWindows.at(-1) };
    },
    async syncPatch([t, move]) {
      if (!world.peer) return null;
      const mine = S();
      const live = modules.tabLive ? Object.keys(mine.tabs).map((id) => [id, modules.tabLive.liveOf(id)]) : [];
      const held = modules.persist.holdPersistence?.();
      const kind = world.kind;
      world.setKind?.("sync peer swap");
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        useBrowser.setState(mine, true);
        for (const [id, value] of live) modules.tabLive.replaceLive(id, value);
        world.setKind?.(kind);
      };
      try {
        useBrowser.setState(world.peer.state, true);
        const home = S().windowOrder[0];
        if (home && move % 2 === 0) {
          const id = S().newTab(home, { url: nextUrl(), background: true });
          S().pinTabs([id], true);
        } else if (home) {
          const pins = S().windows[home].tabIds.filter((id) => S().tabs[id]?.pin);
          const id = pick(pins, t);
          if (id) S().moveTab(id, 0);
        }
        world.peer.state = S();
        await syncDevice(world.peer);
        world.peer.state = S();
        restore();
        await syncDevice(world.self);
        const first = snapshot(S());
        await syncDevice(world.self);
        return { detail: "sync patch from peer, applied twice", syncPair: [first, snapshot(S())] };
      } finally {
        restore();
        if (held !== undefined) modules.persist.resumePersistence?.();
      }
    },
    async saveReload() {
      const before = snapshot(S());
      await flushSession();
      const loaded = modules.persist.loadSession();
      S().hydrate(loaded ?? {});
      return { detail: "save, then reload the session", roundTrip: [before, snapshot(S())] };
    },
    async quitRelaunch() {
      const before = snapshot(S());
      const { flushPersistence, resumePersistence, loadSession } = modules.persist;
      await flushSession();
      flushPersistence({ final: true });
      await settleTurns();
      resumePersistence?.();
      S().hydrate(loadSession() ?? {});
      const relaunched = snapshot(S());
      if (!S().windowOrder.length) S().createWindow({ url: nextUrl() });
      return { detail: "quit, then relaunch", relaunch: [before, relaunched] };
    },
  };

  world.actions = actions;
  world.run = async (step) => {
    clock.now += STEP_MS;
    const before = S();
    const outcome = await actions[step.kind](step.picks);
    if (!outcome) {
      await settleTurns(1);
      return { skipped: true, before, after: S() };
    }
    let reopened = null;
    if (outcome.reopen) {
      const was = S();
      reopened = { tabs: was.closedTabs, windows: was.closedWindows, expected: outcome.expected, tabsBefore: was.tabs };
      outcome.reopen();
    }
    await settleTurns(1);
    return { ...outcome, reopened, before, after: S() };
  };
  return world;
}

export function generateSteps(random, count, weights = ACTION_WEIGHTS) {
  const keys = Object.keys(weights);
  const total = keys.reduce((sum, k) => sum + weights[k], 0);
  const steps = [];
  for (let i = 0; i < count; i++) {
    let at = random() * total;
    let kind = keys.at(-1);
    for (const k of keys) {
      at -= weights[k];
      if (at < 0) {
        kind = k;
        break;
      }
    }
    steps.push({ kind, picks: Array.from({ length: PICKS_PER_STEP }, () => Math.floor(random() * 1000)) });
  }
  return steps;
}
