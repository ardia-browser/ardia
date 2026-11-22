import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.__DEV__ = false;

const { useBrowser } = await import("../browser/store.ts");
const { Clock, emptyScope, syncScope } = await import("@ardia/sync");
const adapters = await import("./profileAdapters.ts");
const v0247 = await import("./fixtures/profileAdapters-v0.2.47.ts");
const { pairTheme, settleThemeAdoption } = await import("./syncThemes.ts");
const { choosePresetColor, resetPresetTheme, setProfileTheme } = await import("../profiles/themeActions.ts");
const { profilesWithOwnLooks } = await import("../../lib/presetLook.ts");

const S = () => useBrowser.getState();

const look = (r, intensity = 0.5) => ({ stops: [{ x: 0.3, y: 0.6, color: { r, g: 0.4, b: 0.7, a: 1 } }], intensity, mode: "auto", grain: 0, texture: "grain", translucency: 1 });
const PLUM = look(0.8);
const BLUE = look(0.2, 0.7);
const GREEN = look(0.1, 0.9);

class Folder {
  files = new Map();
  counter = 0;
  withhold = null;
  duringRead = null;
  transport() {
    return {
      write: async (scope, payload) => {
        const id = `f${++this.counter}`;
        this.files.set(id, { scope, payload });
        return id;
      },
      read: async (scope, known) => {
        this.duringRead?.();
        const here = [...this.files].filter(([id, f]) => f.scope === scope && (known.includes(id) || !this.withhold?.(id)));
        const files = here.filter(([id]) => !known.includes(id)).map(([id, f]) => ({ id, payload: f.payload }));
        return { files, pending: [], damaged: [], present: here.map(([id]) => id) };
      },
      remove: async (_scope, ids) => ids.forEach((id) => this.files.delete(id)),
    };
  }
}

class Mac {
  constructor(id, folder, { old = false, joining = false } = {}) {
    this.id = id;
    this.old = old;
    this.folder = folder;
    this.links = { default: { syncId: "s1" } };
    this.paired = !joining;
    S().hydrate({});
    this.browser = S();
    this.scope = emptyScope();
    this.scope.joined = !joining;
    this.clock = new Clock(id);
    this.adapters = old ? this.oldAdapters() : this.currentAdapters();
  }
  currentAdapters() {
    return adapters.profileSyncAdapters(() => this.links, () => this.scope.records);
  }
  oldAdapters() {
    return [v0247.profilesAdapter(() => this.links), v0247.profileThemesAdapter(() => this.links, () => this.scope.records)];
  }
  upgrade() {
    this.adapters = this.currentAdapters();
  }
  with(fn) {
    useBrowser.setState(this.browser, true);
    try {
      return fn();
    } finally {
      this.browser = S();
    }
  }
  pick(color) {
    this.with(() => choosePresetColor("default", color, () => {}));
  }
  reset() {
    this.with(() => resetPresetTheme("default", () => {}));
  }
  oldPick(color) {
    this.with(() => S().setProfileLook("default", { color, theme: null }));
  }
  edit(theme) {
    this.with(() => setProfileTheme("default", theme, () => {}));
  }
  async sync(duringRead = null) {
    useBrowser.setState(this.browser, true);
    this.folder.duringRead = duringRead;
    try {
      const { published } = await syncScope({ scope: "app", state: this.scope, transport: this.folder.transport(), adapters: this.adapters, clock: this.clock, device: this.id });
      if (!this.old && !this.paired && this.scope.joined) {
        pairTheme(this.scope, "default", this.links.default);
        this.paired = true;
      }
      if (!this.old) settleThemeAdoption(this.links, this.scope, true);
      return published;
    } finally {
      this.folder.duringRead = null;
      this.browser = S();
    }
  }
  profile() {
    return this.browser.profiles.default;
  }
  stash() {
    return { ...(this.profile().presetThemes ?? {}) };
  }
}

async function rounds(macs, n) {
  let published = 0;
  for (let i = 0; i < n; i++) for (const mac of macs) published += await mac.sync();
  return published;
}

async function twoMacsWithPlumEdited(folder) {
  const a = new Mac("a", folder);
  a.edit(PLUM);
  await a.sync();
  const b = new Mac("b", folder, { joining: true });
  await rounds([a, b], 2);
  return { a, b };
}

test("a local edit is this Mac's own look of the preset it was made on; a synced look is only shown", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  assert.deepEqual(a.stash(), { plum: PLUM });
  assert.deepEqual(b.profile().theme, PLUM, "b shows the synced look");
  assert.deepEqual(b.stash(), {}, "but keeps no look of its own");
});

test("a reset reaches the other Mac's screen", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.reset();
  await rounds([a, b], 2);
  assert.equal(b.profile().theme, null);
  assert.deepEqual(a.stash(), {});
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("my presets are mine on this Mac: after another Mac edits the showing preset, switching away and back here brings back this Mac's own look and sends it", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  b.edit(BLUE);
  await rounds([b, a], 2);
  a.edit(GREEN);
  await rounds([a, b], 2);
  assert.deepEqual(b.profile().theme, GREEN, "b shows a's newer edit");
  assert.deepEqual(b.stash(), { plum: BLUE }, "and keeps its own look of plum");
  b.pick("blue");
  b.pick("plum");
  assert.deepEqual(b.profile().theme, BLUE);
  await rounds([b, a], 2);
  assert.deepEqual(a.profile().theme, BLUE, "the pick sends it");
  assert.deepEqual(a.stash(), { plum: GREEN }, "a keeps its own look of plum for later");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("my presets are mine on this Mac: after another Mac resets the showing preset, switching away and back here brings back this Mac's own look", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  b.reset();
  await rounds([b, a], 2);
  assert.equal(a.profile().theme, null);
  a.pick("blue");
  a.pick("plum");
  assert.deepEqual(a.profile().theme, PLUM);
});

async function splitPick(order, setup) {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  await setup?.(a, b);
  a.pick("blue");
  await a.sync();
  const colourFile = `f${folder.counter}`;
  a.edit(BLUE);
  await a.sync();
  const lookFile = `f${folder.counter}`;
  folder.withhold = (id) => id === (order === "look first" ? colourFile : lookFile);
  await b.sync();
  folder.withhold = null;
  await b.sync();
  return { a, b, folder };
}

for (const order of ["look first", "colour first"]) {
  test(`W1, ${order}: a look and its colour arriving in separate pulls never land in this Mac's own looks`, async () => {
    const { b } = await splitPick(order, (a) => a.reset());
    assert.equal(b.profile().color, "blue");
    assert.deepEqual(b.profile().theme, BLUE);
    assert.deepEqual(b.stash(), {}, "plum was plain here and stays plain; blue's look isn't b's");
  });

  test(`W1, ${order}: this Mac's own look of the preset it was on stays under that preset through a later switch`, async () => {
    const { a, b } = await splitPick(order, async (a, b) => {
      b.edit(GREEN);
      await rounds([b, a], 2);
    });
    a.pick("green");
    await rounds([a, b], 2);
    assert.deepEqual(b.stash(), { plum: GREEN }, "only b's own plum look, under plum");
    b.pick("plum");
    assert.deepEqual(b.profile().theme, GREEN);
  });
}

test("U1: switching to a preset and resetting it before syncing shows it plain on the other Mac too", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  b.pick("blue");
  b.edit(BLUE);
  b.pick("plum");
  await rounds([a, b], 2);
  a.pick("blue");
  a.reset();
  await rounds([a, b], 3);
  for (const mac of [a, b]) {
    assert.equal(mac.profile().color, "blue", mac.id);
    assert.equal(mac.profile().theme, null, `${mac.id}: blue shows plain, as the Mac that reset it`);
  }
  assert.deepEqual(b.stash(), { blue: BLUE }, "b keeps its own blue look");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U2: picking a preset whose look equals the one it left still shows that look on the other Mac", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.pick("blue");
  a.edit(BLUE);
  a.pick("plum");
  a.edit(BLUE);
  await a.sync();
  const b = new Mac("b", folder, { joining: true });
  await rounds([a, b], 2);
  a.pick("blue");
  await rounds([a, b], 3);
  for (const mac of [a, b]) {
    assert.equal(mac.profile().color, "blue", mac.id);
    assert.deepEqual(mac.profile().theme, BLUE, mac.id);
  }
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U3: a rename after a plain switch changes nothing about the look", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.pick("blue");
  a.with(() => S().updateProfile("default", { name: "Renamed" }));
  await rounds([a, b], 3);
  for (const mac of [a, b]) {
    assert.equal(mac.profile().color, "blue", mac.id);
    assert.equal(mac.profile().theme, null, mac.id);
  }
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U4: a switch on one Mac and an edit on the other at once end with both Macs showing the same look", async () => {
  const folder = new Folder();
  const { a, b } = await twoMacsWithPlumEdited(folder);
  a.pick("blue");
  a.edit(BLUE);
  b.edit(GREEN);
  await a.sync();
  await b.sync();
  await rounds([a, b], 3);
  assert.equal(a.profile().color, b.profile().color);
  assert.deepEqual(a.profile().theme, b.profile().theme);
  assert.deepEqual(b.stash(), { plum: GREEN }, "b's own edit stays its own look of plum");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("U5 and V1: pairing takes the synced colour, keeps this Mac's own looks, and publishes nothing until a look arrives", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.with(() => S().setProfileLook("default", { color: "blue" }));
  await a.sync();
  const fresh = new Mac("fresh", folder, { joining: true });
  fresh.edit(PLUM);
  await fresh.sync();
  assert.equal(fresh.profile().color, "blue");
  assert.equal(fresh.profile().theme ?? null, null);
  assert.deepEqual(fresh.stash(), { plum: PLUM });
  assert.equal(await rounds([fresh, a, fresh], 3), 0, "nothing publishes without a user action");
  a.edit(BLUE);
  await rounds([a, fresh], 2);
  assert.deepEqual(fresh.profile().theme, BLUE);
  assert.deepEqual(fresh.stash(), { plum: PLUM });
});

test("pairing a fresh Mac shows the synced colour and look", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  a.edit(BLUE);
  await a.sync();
  const fresh = new Mac("fresh", folder, { joining: true });
  fresh.with(() => pairTheme(a.scope, "default", { syncId: "s1" }));
  assert.equal(fresh.profile().color, "blue");
  assert.deepEqual(fresh.profile().theme, BLUE);
  fresh.pick("plum");
  assert.equal(fresh.profile().theme, null, "plum on the new Mac is plain");
});

test("a switch made on 0.2.47 leaves this Mac's own looks alone", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.oldPick("blue");
  await rounds([old, a], 3);
  assert.equal(a.profile().color, "blue");
  assert.equal(a.profile().theme, null);
  assert.deepEqual(a.stash(), { plum: PLUM });
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("an edit made on 0.2.47 shows on the newer Mac without becoming its own look", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.edit(GREEN);
  await rounds([old, a], 3);
  assert.equal(a.profile().color, "blue");
  assert.deepEqual(a.profile().theme, GREEN);
  assert.deepEqual(a.stash(), { plum: PLUM });
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("a Mac upgraded from 0.2.47 keeps its newest edit and settles", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  await a.sync();
  const old = new Mac("old", folder, { old: true, joining: true });
  await rounds([a, old], 3);
  old.edit(GREEN);
  await old.sync();
  old.upgrade();
  await rounds([old, a], 3);
  for (const mac of [a, old]) assert.deepEqual(mac.profile().theme, GREEN, mac.id);
  assert.equal(await rounds([a, old], 3), 0, "and they settle");
});

test("only the showing look is ever written to sync", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  a.edit(BLUE);
  await a.sync();
  const keys = new Set([...folder.files.values()].flatMap((f) => (JSON.parse(f.payload).ops ?? []).map((op) => op.k)));
  assert.deepEqual([...keys].filter((k) => !/^(prof|pth):s1(:angle)?$/.test(k)), []);
});

test("W2: a colour change for a profile whose look this Mac doesn't sync leaves its look alone, as main does", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  a.edit(BLUE);
  await a.sync();
  const b = new Mac("b", folder, { joining: true });
  b.paired = true;
  b.edit(GREEN);
  b.adapters = [adapters.profilesAdapter(() => b.links, undefined, () => b.scope.records, () => ({})), adapters.profileThemesAdapter(() => ({}), () => b.scope.records)];
  await b.sync();
  assert.equal(b.profile().color, "blue");
  assert.deepEqual(b.profile().theme, GREEN, "its own look stays, never blue's synced look");
});

function random(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

test("over random sequences: no sync publishes without a user action, no synced record changes a Mac's own looks, and quiet Macs agree", async () => {
  const colors = ["plum", "blue", "green"];
  const looks = [PLUM, BLUE, GREEN, look(0.5, 0.3)];
  for (let seed = 1; seed <= 80; seed++) {
    const next = random(seed);
    const folder = new Folder();
    const a = new Mac("a", folder);
    a.edit(PLUM);
    await a.sync();
    const b = new Mac("b", folder, { joining: true });
    const old = new Mac("old", folder, { old: true, joining: true });
    const macs = [a, b, old];
    const dirty = new Set();
    const act = (mac, inPlace) => {
      const run = inPlace ? (fn) => fn() : (fn) => mac.with(fn);
      const action = next();
      if (action < 0.4) {
        const color = colors[Math.floor(next() * colors.length)];
        run(() => (mac.old ? S().setProfileLook("default", { color, theme: null }) : choosePresetColor("default", color, () => {})));
      } else if (action < 0.8) run(() => setProfileTheme("default", looks[Math.floor(next() * looks.length)], () => {}));
      else run(() => (mac.old ? S().setProfileLook("default", { theme: null }) : resetPresetTheme("default", () => {})));
      dirty.add(mac);
    };
    if (next() < 0.5) act(b, false);
    folder.withhold = (id) => next() < 0.3 && Number(id.slice(1)) > 1;
    for (let step = 0; step < 16; step++) {
      const mac = macs[Math.floor(next() * macs.length)];
      if (next() < 0.4) {
        act(mac, false);
        continue;
      }
      const wasDirty = dirty.has(mac);
      dirty.delete(mac);
      let midRead = false;
      const before = JSON.stringify(mac.profile().presetThemes ?? {});
      const published = await mac.sync(next() < 0.2 ? () => ((midRead = true), act(mac, true)) : null);
      if (!wasDirty && !midRead) assert.equal(published, 0, `seed ${seed} step ${step}: ${mac.id} published after only applying`);
      if (!midRead) assert.equal(JSON.stringify(mac.profile().presetThemes ?? {}), before, `seed ${seed} step ${step}: a sync changed ${mac.id}'s own looks`);
    }
    folder.withhold = null;
    await rounds(macs, 4);
    assert.equal(await rounds(macs, 2), 0, `seed ${seed}: settles`);
    for (const mac of [b, old]) {
      assert.equal(mac.profile().color, a.profile().color, `seed ${seed}: ${mac.id} colour`);
      assert.deepEqual(mac.profile().theme ?? null, a.profile().theme ?? null, `seed ${seed}: ${mac.id} look`);
    }
  }
});

const restart = (mac) => mac.with(() => useBrowser.setState((s) => ({ profiles: profilesWithOwnLooks(JSON.parse(JSON.stringify(s.profiles))) })));

test("a plain upgrade from 0.2.47 with a custom theme keeps the look, on screen and after switching away and back", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder, { old: true });
  a.with(() => useBrowser.setState((s) => ({ profiles: { ...s.profiles, default: { id: "default", name: "Personal", color: "blue", icon: null, createdAt: 0, theme: BLUE } } })));
  await a.sync();
  const b = new Mac("b", folder, { old: true, joining: true });
  await rounds([a, b], 3);
  a.upgrade();
  restart(a);
  assert.deepEqual(a.profile().theme, BLUE);
  a.pick("plum");
  a.pick("blue");
  assert.deepEqual(a.profile().theme, BLUE, "nothing lost by switching away and back");
  await rounds([a, b], 3);
  assert.deepEqual(b.profile().theme, BLUE, "the older Mac still shows it");
  assert.equal(await rounds([a, b], 3), 0, "and they settle");
});

test("0.2.48 to 0.2.47 and back with nothing done on 0.2.47 keeps every look", async () => {
  const folder = new Folder();
  const a = new Mac("a", folder);
  a.edit(PLUM);
  a.pick("blue");
  a.edit(BLUE);
  a.pick("plum");
  await a.sync();
  const before = { theme: a.profile().theme, stash: a.stash(), color: a.profile().color };
  a.adapters = a.oldAdapters();
  restart(a);
  await a.sync();
  a.upgrade();
  restart(a);
  await a.sync();
  assert.deepEqual({ theme: a.profile().theme, stash: a.stash(), color: a.profile().color }, before);
  a.pick("blue");
  assert.deepEqual(a.profile().theme, BLUE);
});
