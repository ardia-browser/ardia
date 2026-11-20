import assert from "node:assert/strict";
import { test } from "node:test";
import { createRevealGuard, measureWithin, startReveal } from "./revealRunner.ts";
import { clearSettingsReveal, revealSetting, useSettingsSearch } from "../../state/settings/searchState.ts";
import { useSettingsNav } from "../../state/settings/settingsWindows.ts";
import { settingsReveal } from "./tokens.ts";

function fakeHost() {
  const views = new Map();
  const waiting = new Map();
  let frames = [];
  let timers = [];
  let now = 0;
  const host = {
    current: () => true,
    find: (id) => views.get(id),
    whenMounted: (id, then) => {
      waiting.set(id, then);
      return () => waiting.get(id) === then && waiting.delete(id);
    },
    measure: (view, done) => view.measure(done),
    nextFrame: (then) => {
      const entry = { then, live: true };
      frames.push(entry);
      return () => void (entry.live = false);
    },
    after: (ms, then) => {
      const entry = { at: now + ms, then, live: true };
      timers.push(entry);
      return () => void (entry.live = false);
    },
  };
  const flush = async () => {
    for (let round = 0; round < 50; round++) {
      await new Promise((r) => setImmediate(r));
      const due = frames.filter((f) => f.live);
      frames = [];
      due.forEach((f) => f.then());
      if (!due.length && !frames.length) break;
    }
  };
  const advance = async (ms) => {
    now += ms;
    const due = timers.filter((t) => t.live && t.at <= now);
    timers = timers.filter((t) => !due.includes(t));
    due.forEach((t) => t.then());
    await flush();
  };
  const mount = (id, view) => {
    views.set(id, view);
    waiting.get(id)?.();
  };
  const unmount = (id) => views.delete(id);
  return { host, flush, advance, mount, unmount };
}

const outcome = (rows, extraHooks = {}) => ({
  extra: () => Promise.resolve(null),
  finish: (row) => rows.push(row),
  onGiveUp: () => rows.push("gave up"),
  onLost: () => rows.push("lost"),
  onWaited: () => {},
  ...extraHooks,
});

const laidOut = (rect) => ({ measure: (done) => done(rect) });
const silent = () => ({ measure: () => {} });

test("a measurement whose callbacks never come resolves at its deadline instead of hanging", async () => {
  const { host, advance } = fakeHost();
  let result = "pending";
  measureWithin(host, silent(), 300).then((r) => (result = r));
  await advance(299);
  assert.equal(result, "pending");
  await advance(1);
  assert.equal(result, null);
});

test("a row that unmounts while it's being measured is waited for and revealed once it mounts again", async () => {
  const { host, flush, advance, mount, unmount } = fakeHost();
  const rows = [];
  const waited = [];
  mount("general.defaultBrowser", silent());
  startReveal("general.defaultBrowser", host, outcome(rows, { onWaited: () => waited.push(1) }));
  await flush();
  unmount("general.defaultBrowser");
  await advance(settingsReveal.measureDeadlineMs);
  assert.deepEqual(rows, []);
  mount("general.defaultBrowser", laidOut({ y: 300, h: 34 }));
  await flush();
  assert.deepEqual(rows, [{ y: 300, h: 34 }]);
  assert.equal(waited.length, 1);
});

test("a reveal cancelled while it waits for its row does nothing when the row mounts", async () => {
  const { host, flush, mount } = fakeHost();
  const rows = [];
  const cancel = startReveal("general.defaultBrowser", host, outcome(rows));
  await flush();
  cancel();
  mount("general.defaultBrowser", laidOut({ y: 10, h: 34 }));
  await flush();
  assert.deepEqual(rows, []);
});

test("a reveal whose request was superseded during a measurement neither scrolls nor flashes", async () => {
  const { host, flush, mount } = fakeHost();
  let wanted = true;
  host.current = () => wanted;
  let answer;
  mount("general.defaultBrowser", { measure: (done) => (answer = done) });
  const rows = [];
  startReveal("general.defaultBrowser", host, outcome(rows));
  await flush();
  wanted = false;
  answer({ y: 10, h: 34 });
  await flush();
  assert.deepEqual(rows, []);
});

test("a row that never lays out gives up after its frames instead of retrying forever", async () => {
  const { host, flush, mount } = fakeHost();
  const rows = [];
  mount("general.defaultBrowser", laidOut({ y: 0, h: 0 }));
  startReveal("general.defaultBrowser", host, outcome(rows));
  await flush();
  assert.deepEqual(rows, ["gave up"]);
});

test("a target that becomes unavailable while its row is measured is neither scrolled to nor flashed", async () => {
  const { host, flush, mount } = fakeHost();
  let available = true;
  host.current = () => available;
  let answer;
  mount("general.updateChannel", { measure: (done) => (answer = done) });
  const rows = [];
  startReveal("general.updateChannel", host, outcome(rows));
  await flush();
  available = false;
  answer({ y: 420, h: 34 });
  await flush();
  assert.deepEqual(rows, []);
});

test("a target that becomes unavailable while its section headers are measured isn't finished either", async () => {
  const { host, flush, mount } = fakeHost();
  let available = true;
  host.current = () => available;
  let headersDone;
  mount("general.updateChannel", laidOut({ y: 420, h: 34 }));
  const rows = [];
  startReveal("general.updateChannel", host, outcome(rows, { extra: () => new Promise((done) => (headersDone = done)) }));
  await flush();
  available = false;
  headersDone(null);
  await flush();
  assert.deepEqual(rows, []);
});

test("a placeholder that unmounts before it's measured stops the reveal at the mount deadline instead of waiting forever", async () => {
  const { host, flush, advance, mount, unmount } = fakeHost();
  const rows = [];
  mount("general.updateChannel", laidOut({ y: 420, h: 34 }));
  startReveal("general.updateChannel", host, outcome(rows));
  unmount("general.updateChannel");
  await flush();
  await advance(settingsReveal.mountDeadlineMs - 1);
  assert.deepEqual(rows, []);
  await advance(1);
  assert.deepEqual(rows, ["lost"]);
  mount("general.updateChannel", laidOut({ y: 420, h: 34 }));
  await flush();
  assert.deepEqual(rows, ["lost"]);
});

test("an anchor replaced by a different node while it's measured is measured again, and the new node's place is used", async () => {
  const { host, flush, mount } = fakeHost();
  let answer;
  mount("general.updateChannel", { measure: (done) => (answer = done) });
  const rows = [];
  startReveal("general.updateChannel", host, outcome(rows));
  await flush();
  mount("general.updateChannel", laidOut({ y: 900, h: 34 }));
  answer({ y: 420, h: 34 });
  await flush();
  assert.deepEqual(rows, [{ y: 900, h: 34 }]);
});

test("an anchor replaced right before the reveal finishes is checked again, so the old node's place is never used", async () => {
  const { host, flush, mount } = fakeHost();
  let headersDone;
  let extras = 0;
  mount("general.updateChannel", laidOut({ y: 420, h: 34 }));
  const rows = [];
  startReveal("general.updateChannel", host, outcome(rows, { extra: () => (extras++ === 0 ? new Promise((done) => (headersDone = done)) : Promise.resolve(null)) }));
  await flush();
  mount("general.updateChannel", laidOut({ y: 900, h: 34 }));
  headersDone(null);
  await flush();
  assert.deepEqual(rows, [{ y: 900, h: 34 }]);
});

test("a row its own setting hides mid-measurement isn't revealed when the setting is switched back, and the request stays dead", async () => {
  const { host, flush, mount, unmount } = fakeHost();
  const guard = createRevealGuard();
  let shown = true;
  host.current = () => guard.current(1, true, !shown);
  let answer;
  mount("tabs.sidebarSide", { measure: (done) => (answer = done) });
  const rows = [];
  startReveal("tabs.sidebarSide", host, outcome(rows));
  await flush();
  shown = false;
  guard.observe(1, true);
  unmount("tabs.sidebarSide");
  answer({ y: 300, h: 34 });
  await flush();
  shown = true;
  guard.observe(1, false);
  mount("tabs.sidebarSide", laidOut({ y: 300, h: 34 }));
  await flush();
  assert.deepEqual(rows, []);
  assert.equal(guard.current(1, true, false), false);
  assert.equal(guard.current(2, true, false), true);
});

test("the guard catches a hidden row on its own, even before the window has rendered the change", () => {
  const guard = createRevealGuard();
  assert.equal(guard.current(1, true, true), false);
  assert.equal(guard.current(1, true, false), false);
});

test("giving up after the row disappears on its last retry clears the reveal without recording a flash", async () => {
  const { host, flush, mount, unmount } = fakeHost();
  useSettingsNav.setState({ pane: "general", profileId: null, detail: null, back: [], forward: [] });
  useSettingsSearch.setState({ flash: null });
  revealSetting({ id: "general.defaultBrowser", pane: "general", section: "Default browser" }, "click", 0);
  const { request } = useSettingsSearch.getState().reveal;
  let tries = 0;
  mount("general.defaultBrowser", { measure: (done) => (++tries === settingsReveal.layoutFrames + 1 ? (unmount("general.defaultBrowser"), done({ y: 10, h: 34 })) : done({ y: 0, h: 0 })) });
  const rows = [];
  startReveal("general.defaultBrowser", host, outcome(rows, { onGiveUp: () => (rows.push("gave up"), clearSettingsReveal(request)) }));
  for (let i = 0; i < 40 && !rows.length; i++) await flush();
  assert.deepEqual(rows, ["gave up"]);
  const { reveal, flash } = useSettingsSearch.getState();
  assert.equal(reveal, null);
  assert.equal(flash, null);
});
