import assert from "node:assert/strict";
import { test } from "node:test";
const { forgetSettingsScroll, goToSettingsPane, rememberSettingsScrollOffset, replaceSettingsPlace, settingsBack, settingsForward, useSettingsNav } = await import("./settingsWindows.ts");
const { settingsScrollFor } = await import("./settingsWindows.ts");
const { SCROLL_SETTLE_MS, revealScrollTarget, settingsLayoutKey, settingsScroller } = await import("./paneScroll.ts");
globalThis.__browserStore = await import("../browser/store.ts");

const nav = () => useSettingsNav.getState();
const scrollShown = (y) => rememberSettingsScrollOffset(nav().visit, y);

function fresh() {
  forgetSettingsScroll();
  useSettingsNav.setState({ pane: "general", profileId: null, detail: null, scroll: 0, visit: 0, back: [], forward: [] });
  rememberSettingsScrollOffset(-1, 0);
}

test("Back returns to the parent pane where it was left, Forward to the sub-page's own spot", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(520);
  goToSettingsPane("profiles", "default", "passwords");
  assert.equal(nav().scroll, 0);
  scrollShown(240);
  settingsBack();
  assert.equal(nav().detail, null);
  assert.equal(nav().scroll, 520);
  settingsForward();
  assert.equal(nav().detail, "passwords");
  assert.equal(nav().scroll, 240);
});

test("each pane keeps its own position across several steps", () => {
  fresh();
  scrollShown(700);
  goToSettingsPane("general", null, "crashDetails");
  scrollShown(90);
  goToSettingsPane("plugins");
  scrollShown(300);
  goToSettingsPane("plugins", null, "some-plugin");
  settingsBack();
  assert.equal(nav().scroll, 300);
  settingsBack();
  assert.equal(nav().scroll, 90);
  settingsBack();
  assert.equal(nav().pane, "general");
  assert.equal(nav().scroll, 700);
});

test("a pane opened fresh starts at the top", () => {
  fresh();
  scrollShown(700);
  goToSettingsPane("tabs");
  assert.equal(nav().scroll, 0);
  goToSettingsPane("general");
  assert.equal(nav().scroll, 0);
});

test("two profiles' overviews are separate history entries with their own positions", () => {
  fresh();
  goToSettingsPane("profiles", "work");
  scrollShown(500);
  const work = nav().visit;
  goToSettingsPane("profiles", "home");
  assert.notEqual(nav().visit, work);
  scrollShown(80);
  settingsBack();
  assert.equal(nav().profileId, "work");
  assert.equal(nav().visit, work);
  assert.equal(nav().scroll, 500);
  settingsForward();
  assert.equal(nav().profileId, "home");
  assert.equal(nav().scroll, 80);
});

test("an offset noted for one visit is never taken for another visit of the same page", () => {
  fresh();
  goToSettingsPane("tabs");
  scrollShown(400);
  const stale = nav().visit;
  goToSettingsPane("general");
  goToSettingsPane("tabs");
  rememberSettingsScrollOffset(stale, 999);
  settingsBack();
  settingsForward();
  assert.equal(nav().scroll, 0);
});

test("leaving a page saves where it actually is, not where it was meant to go back to", () => {
  fresh();
  goToSettingsPane("profiles", "default", "passwords");
  scrollShown(2400);
  goToSettingsPane("general");
  settingsBack();
  assert.equal(nav().scroll, 2400);
  scrollShown(310);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 310);
});

test("leaving a sub-page in place lands on the parent's spot", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(360);
  const parent = nav().visit;
  goToSettingsPane("profiles", "default", "extension:abc");
  replaceSettingsPlace("default", null);
  assert.equal(nav().scroll, 360);
  assert.equal(nav().visit, parent);
});

test("closing Settings forgets every entry's position", () => {
  fresh();
  goToSettingsPane("profiles", "default");
  scrollShown(520);
  goToSettingsPane("profiles", "default", "passwords");
  scrollShown(200);
  goToSettingsPane("general");
  settingsBack();
  forgetSettingsScroll();
  const all = [nav(), ...nav().back, ...nav().forward];
  assert.ok(all.length >= 3);
  for (const stop of all) assert.equal(stop.scroll, 0, `${stop.pane}:${stop.detail}`);
  settingsBack();
  assert.equal(nav().scroll, 0);
  settingsForward();
  settingsForward();
  assert.equal(nav().scroll, 0);
});

const clock = { now: 0 };

function window(viewport = 600) {
  const reports = [];
  const memory = settingsScroller((outcome) => reports.push(outcome), () => clock.now);
  memory.resized(viewport);
  const reported = (move, before) => (move ? { y: move.y, restore: reports.length > before ? reports.at(-1) : null } : null);
  let generations = 0;
  let current = null;
  let pending = null;
  const latest = new Map();
  const generationOf = (layout) => {
    const next = { layout, generation: ++generations };
    latest.set(layout, next.generation);
    return next;
  };
  const sourceOf = (layout, explicit) => {
    if (current?.layout === layout) return current.generation;
    if (explicit && latest.has(layout)) return latest.get(layout);
    pending = pending?.layout === layout ? pending : generationOf(layout);
    return pending.generation;
  };
  return {
    reports,
    memory,
    generation: () => current?.generation ?? 0,
    show: () => {
      const layout = settingsLayoutKey(nav());
      if (current?.layout !== layout) current = pending?.layout === layout ? pending : generationOf(layout);
      pending = null;
      const before = reports.length;
      return reported(memory.begin(nav().visit, settingsScrollFor(nav().visit), nav(), null, current.generation), before);
    },
    lay: (height, place, generation) => {
      const layout = settingsLayoutKey(place ?? nav());
      const before = reports.length;
      return reported(memory.laidOut(layout, height, generation ?? sourceOf(layout, !!place)), before);
    },
    scrolled: (y, max = 1e9, contentHeight = -1, place, generation) => {
      const layout = place ? settingsLayoutKey(place) : null;
      memory.scrolled(y, max, contentHeight, layout === null ? undefined : { layout, generation: generation ?? sourceOf(layout, true) });
    },
  };
}

const later = () => void (clock.now += SCROLL_SETTLE_MS + 1);

function returnToSaved(y) {
  fresh();
  goToSettingsPane("profiles", "default", "passwords");
  scrollShown(y);
  goToSettingsPane("general");
  settingsBack();
}

test("the saved offset is restored when the page first lays out tall enough to reach it", () => {
  returnToSaved(800);
  const settings = window();
  assert.deepEqual(settings.show(), { y: 0, restore: null }, "a new page goes to the top while it lays out");
  assert.deepEqual(settings.lay(1400), { y: 800, restore: null }, "applied once the scroll view reports it");
  settings.scrolled(800);
  assert.deepEqual(settings.reports, ["applied"]);
  assert.equal(settings.lay(3000), null);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 800);
});

test("a page too short for its saved offset at first layout opens at the top and never jumps later", () => {
  returnToSaved(2400);
  const settings = window();
  settings.show();
  assert.deepEqual(settings.lay(900), { y: 0, restore: "unreachable" });
  assert.equal(settings.lay(5000), null);
});

test("(a) leaving a page that never reached its saved offset saves where it really was", () => {
  returnToSaved(2400);
  const settings = window();
  settings.show();
  settings.lay(900);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 0);
});

test("(b) a user scroll after first layout is simply recorded: nothing is waiting to pull it back", () => {
  returnToSaved(2400);
  const settings = window();
  settings.show();
  settings.lay(900);
  settings.scrolled(0);
  settings.scrolled(300);
  assert.equal(settings.lay(5000), null);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 300);
});

test("(c) a scroll event from the page being left, delivered to the one scroll view's current handler, is never credited to the destination", () => {
  fresh();
  const settings = window();
  goToSettingsPane("tabs");
  settings.show();
  settings.lay(3000);
  later();
  settings.scrolled(500);
  goToSettingsPane("advanced");
  settings.show();
  settings.scrolled(650);
  settings.lay(3000);
  settings.scrolled(700);
  settings.scrolled(0);
  settings.scrolled(120);
  settingsBack();
  assert.equal(nav().pane, "tabs");
  assert.equal(nav().scroll, 500);
  settingsForward();
  assert.equal(nav().scroll, 120);
});

test("(c) leaving right after a stale scroll event never saves that stale offset", () => {
  fresh();
  const settings = window();
  goToSettingsPane("tabs");
  settings.show();
  settings.lay(3000);
  later();
  settings.scrolled(500);
  goToSettingsPane("advanced");
  settings.show();
  settings.lay(3000);
  settings.scrolled(700);
  settingsBack();
  assert.equal(nav().pane, "tabs");
  assert.equal(nav().scroll, 500);
  settings.show();
  settingsForward();
  assert.equal(nav().pane, "advanced");
  assert.equal(nav().scroll, 0, "the stale 700 was never saved for the destination");
});

test("after a restore, a queued offset delivered through the current handler is ignored until the scroll view reports the restored spot", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  assert.deepEqual(settings.lay(1400), { y: 500, restore: null });
  settings.scrolled(120, 800, 1400, nav());
  assert.equal(settings.memory.revealTop(), 500, "queued offset doesn't shift revealTop");
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 500, "the stale 120 didn't overwrite the restored 500");
  settings.show();
  settings.lay(1400);
  settings.scrolled(120, 800, 1400, nav());
  settings.scrolled(500, 800, 1400, nav());
  settings.scrolled(530, 800, 1400, nav());
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 530, "once the restored spot is reported, the user's scroll counts");
});

test("a restore that moves nothing waits only briefly: the user's next scroll still counts", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  settings.lay(1400);
  later();
  settings.scrolled(560);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 560);
});

test("scroll events before the destination's first layout are ignored", () => {
  fresh();
  const settings = window();
  goToSettingsPane("tabs");
  settings.show();
  settings.scrolled(900);
  goToSettingsPane("general");
  settingsBack();
  assert.equal(nav().scroll, 0);
});

test("Back to a shorter profile scrolls it to the top explicitly, and a late layout from the profile left behind settles nothing", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("profiles", "tall");
  const tall = nav();
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(550);
  goToSettingsPane("profiles", "short");
  assert.equal(settings.show(), null, "the same page with another profile waits for that profile's layout");
  assert.equal(settings.lay(1500, tall), null, "the outgoing profile's layout is not the destination's");
  assert.deepEqual(settings.lay(1000), { y: 0, restore: null }, "the short profile opens at the top, not at the tall one's 550");
});

test("Back from a short profile's overview to a taller one judges the saved offset at the taller one's own height", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("profiles", "tall");
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(900);
  goToSettingsPane("profiles", "short");
  settings.show();
  settings.lay(1000);
  settings.scrolled(0);
  settingsBack();
  assert.equal(nav().scroll, 900);
  assert.equal(settings.show(), null, "the short profile's height says nothing about the tall one");
  assert.deepEqual(settings.lay(1500), { y: 900, restore: null });
  settings.scrolled(900);
  assert.equal(settings.reports.at(-1), "applied");
  goToSettingsPane("profiles", "tall", "passwords");
  settings.show();
  settings.lay(800);
  settingsBack();
  assert.deepEqual(settings.show(), { y: 0, restore: null });
});

test("the same profile's page, laid out already, settles at once from its known height", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("profiles", "tall");
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(700);
  replaceSettingsPlace("tall");
  assert.equal(nav().scroll, 700);
  assert.deepEqual(settings.show(), { y: 700, restore: "applied" });
  goToSettingsPane("profiles", "tall", "passwords");
  assert.deepEqual(settings.show(), { y: 0, restore: null }, "another page goes to the top while it lays out");
});

test("switching profiles with the pills keeps each profile's position, without adding history", () => {
  fresh();
  const { useBrowser } = globalThis.__browserStore;
  const work = useBrowser.getState().createProfile({ name: "Work" });
  const home = useBrowser.getState().createProfile({ name: "Home" });
  const settings = window(500);
  goToSettingsPane("profiles", work);
  const history = nav().back.length;
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(350);
  replaceSettingsPlace(home);
  assert.equal(nav().scroll, 0, "a profile not seen yet starts at the top");
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(180);
  replaceSettingsPlace(work);
  assert.equal(nav().scroll, 350);
  assert.equal(settings.show(), null);
  assert.deepEqual(settings.lay(1500), { y: 350, restore: null });
  settings.scrolled(350);
  assert.equal(settings.reports.at(-1), "applied");
  replaceSettingsPlace(home);
  assert.equal(nav().scroll, 180);
  assert.equal(nav().back.length, history);
  forgetSettingsScroll();
  replaceSettingsPlace(work);
  assert.equal(nav().scroll, 0, "closing Settings forgets them too");
});

test("S1 (round 2): a marker that reports before the visit begins, as on Linux and Windows, still settles that visit", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("profiles", "work");
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(300);
  goToSettingsPane("general");
  settings.show();
  settings.lay(900);
  settings.scrolled(0);
  settingsBack();
  assert.equal(nav().scroll, 300);
  assert.equal(settings.lay(1500), null, "the destination's marker fires before begin");
  assert.deepEqual(settings.show(), { y: 300, restore: null }, "begin takes that report instead of waiting for one that won't come again");
  settings.scrolled(300);
  assert.equal(settings.reports.at(-1), "applied");
  later();
  settings.scrolled(340);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 340, "the user's scroll is saved, not 0");
});

test("S2 (round 2): a restore the view is already at concludes at once, so a scroll right after it counts", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("profiles", "work");
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(450);
  replaceSettingsPlace("work");
  assert.deepEqual(settings.show(), { y: 450, restore: "applied" });
  settings.scrolled(470);
  goToSettingsPane("general");
  settingsBack();
  assert.equal(nav().scroll, 470, "no 250 ms wait swallowed the user's scroll");
});

test("S2 (round 2): a search reveal right after a restore is recorded", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  settings.lay(1400);
  settings.memory.moved();
  settings.scrolled(700);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 700);
  assert.deepEqual(settings.reports, [], "the restore was never confirmed, so it isn't counted as applied");
});

test("S2 (round 2): a restore the scroll view clamps keeps the offset it landed on and is counted as clamped", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  assert.deepEqual(settings.lay(1400), { y: 500, restore: null });
  settings.scrolled(480, 480);
  assert.deepEqual(settings.reports, ["clamped"]);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 480);
});

test("S3 (round 2): the default profile opened without an id and its own pill share one remembered position", () => {
  fresh();
  const { useBrowser } = globalThis.__browserStore;
  const work = useBrowser.getState().createProfile({ name: "Work" });
  const personal = useBrowser.getState().settings.defaultProfileId;
  const settings = window(500);
  goToSettingsPane("profiles", null);
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(310);
  replaceSettingsPlace(work);
  replaceSettingsPlace(personal);
  assert.equal(nav().scroll, 310);
});

test("S5 (round 2): Back to a deleted profile, now shown as another one, doesn't take the deleted profile's offset", () => {
  fresh();
  const { useBrowser } = globalThis.__browserStore;
  const work = useBrowser.getState().createProfile({ name: "Work" });
  const personal = useBrowser.getState().settings.defaultProfileId;
  goToSettingsPane("profiles", work);
  scrollShown(400);
  goToSettingsPane("profiles", personal);
  useBrowser.setState((s) => {
    const { [work]: _gone, ...profiles } = s.profiles;
    return { profiles, profileOrder: s.profileOrder.filter((id) => id !== work) };
  });
  settingsBack();
  assert.equal(nav().profileId, work);
  assert.equal(nav().scroll, 400);
  assert.equal(settingsScrollFor(nav().visit), 0, "the page shows the default profile, so 400 isn't restored on it");
});

test("S2 (round 3): a restore that never confirms keeps its offset against queued same-height events, and records scrolls after settle or search reveal", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  assert.deepEqual(settings.lay(1400), { y: 500, restore: null });
  settings.scrolled(350, 800, 9999, nav());
  settings.scrolled(120, 800, 1400, nav());
  assert.deepEqual(settings.reports, [], "unacknowledged events before the restore confirms are ignored");
  assert.equal(settings.memory.revealTop(), 500, "queued events don't move revealTop away from the pending restore");
  settingsForward();
  settings.show();
  settingsBack();
  assert.equal(nav().scroll, 500, "navigating away before acknowledgement keeps the saved 500");
  settings.show();
  assert.deepEqual(settings.lay(1400), { y: 500, restore: null });
  settings.memory.moved();
  settings.scrolled(350, 800, 1400, nav());
  assert.deepEqual(settings.reports, []);
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 350, "a scroll after a search reveal is recorded without counting the restore as applied");
});

test("S2 (round 3): an unconfirmed restore left by navigation isn't counted, and nothing observed keeps the position it came back to", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  settings.lay(1400);
  settingsForward();
  settings.show();
  assert.deepEqual(settings.reports, []);
  settingsBack();
  assert.equal(nav().scroll, 500);
});

test("S5 (round 3): deleting the profile on screen and falling back to the default doesn't hand the deleted profile's offset to it", () => {
  fresh();
  const { useBrowser } = globalThis.__browserStore;
  const work = useBrowser.getState().createProfile({ name: "Work" });
  const personal = useBrowser.getState().settings.defaultProfileId;
  goToSettingsPane("profiles", work);
  scrollShown(400);
  useBrowser.setState((s) => {
    const { [work]: _gone, ...profiles } = s.profiles;
    return { profiles, profileOrder: s.profileOrder.filter((id) => id !== work) };
  });
  replaceSettingsPlace(null);
  assert.equal(nav().scroll, 0);
  replaceSettingsPlace(personal);
  assert.equal(nav().scroll, 0, "Personal never took Work's 400");
});

test("S6 (round 3): SettingsWindow begins a visit only from a layout effect, never while rendering", async () => {
  const { readFileSync } = await import("node:fs");
  const ts = (await import("typescript")).default;
  const path = new URL("../../components/settings/SettingsWindow.tsx", import.meta.url);
  const file = ts.createSourceFile("SettingsWindow.tsx", readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const begins = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "scrollMemory.begin") begins.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(begins.length > 0);
  for (const call of begins) {
    let inside = null;
    for (let node = call.parent; node; node = node.parent) {
      if (ts.isCallExpression(node) && /^use\w*Effect$/.test(node.expression.getText(file))) {
        inside = node.expression.getText(file);
        break;
      }
    }
    assert.equal(inside, "useLayoutEffect", "begin runs after commit, so an uncommitted render changes no history or telemetry");
  }
});

test("R4-1: outgoing scroll events (shorter, equal-height, or matching target offset) never settle the destination", () => {
  fresh();
  const settings = window(600);
  goToSettingsPane("tabs");
  const tabsPlace = nav();
  settings.show();
  settings.lay(1400);
  later();
  settings.scrolled(800, 800, 1400, tabsPlace);
  goToSettingsPane("advanced");
  const advPlace = nav();
  settings.show();
  settings.lay(1400);
  later();
  settings.scrolled(800, 800, 1400, advPlace);
  goToSettingsPane("general");
  const genPlace = nav();
  settings.show();
  settings.lay(900);
  later();
  settings.scrolled(300, 300, 900, genPlace);
  settingsBack();
  assert.equal(nav().scroll, 800);
  settings.show();
  assert.deepEqual(settings.lay(1400), { y: 800, restore: null }, "same-offset outgoing pane never pre-confirms applied");
  settings.scrolled(300, 300, 900, genPlace);
  settings.scrolled(300, 300, 900);
  settings.scrolled(300, 800, 1400, tabsPlace);
  assert.deepEqual(settings.reports, [], "shorter or equal-height outgoing events never settle or clamp the destination");
  settings.scrolled(800, 800, 1400, advPlace);
  assert.deepEqual(settings.reports, ["applied"]);
});

test("R4-2: fallback profile keeps its own scroll offset and default switch never leaks offset to previous default", () => {
  fresh();
  const { useBrowser } = globalThis.__browserStore;
  const work = useBrowser.getState().createProfile({ name: "Work" });
  const alt = useBrowser.getState().createProfile({ name: "Alt" });
  const personal = useBrowser.getState().settings.defaultProfileId;
  goToSettingsPane("profiles", work);
  scrollShown(400);
  goToSettingsPane("general");
  useBrowser.setState((s) => {
    const { [work]: _gone, ...profiles } = s.profiles;
    return { profiles, profileOrder: s.profileOrder.filter((id) => id !== work) };
  });
  settingsBack();
  assert.equal(settingsScrollFor(nav().visit), 0);
  scrollShown(160);
  settingsForward();
  settingsBack();
  assert.equal(settingsScrollFor(nav().visit), 160, "fallback profile kept its own scroll offset across Forward/Back");

  fresh();
  goToSettingsPane("profiles", null);
  scrollShown(120);
  useBrowser.setState((s) => ({ settings: { ...s.settings, defaultProfileId: alt } }));
  scrollShown(260);
  replaceSettingsPlace(personal);
  assert.equal(nav().scroll, 0, "switching to previous default never restores the new default's 260");
  replaceSettingsPlace(alt);
  assert.equal(nav().scroll, 260, "the new default kept its own 260");
});

test("R5-1: a search reveal judges the row against the current page's own offset, not the page left behind", () => {
  fresh();
  const settings = window(600);
  goToSettingsPane("tabs");
  const tabs = nav();
  settings.show();
  settings.lay(3000);
  later();
  settings.scrolled(1200, 2400, 3000, tabs);
  assert.equal(settings.memory.revealTop(), 1200);
  const left = settings.generation();
  goToSettingsPane("advanced");
  const advanced = nav();
  settings.show();
  settings.lay(3000);
  assert.equal(settings.memory.revealTop(), 0, "navigating resets the one scroll view to the top");
  settings.scrolled(1300, 2400, 3000, tabs, left);
  assert.equal(settings.memory.revealTop(), 0, "a late event from the page left behind doesn't move it");
  assert.equal(revealScrollTarget(1500, 40, settings.memory.revealTop(), 600), 1300, "a row at 1500 is offscreen at the top, so the reveal scrolls to it");
  later();
  settings.scrolled(1300, 2400, 3000, advanced);
  assert.equal(settings.memory.revealTop(), 1300);
  assert.equal(revealScrollTarget(1500, 40, settings.memory.revealTop(), 600), null, "once it's on screen nothing moves");
});

test("R5-1: a reveal that scrolls before the page settles isn't undone by the restore", () => {
  returnToSaved(800);
  const settings = window(600);
  settings.show();
  settings.memory.moved();
  assert.equal(settings.lay(1400), null, "the saved 800 doesn't pull the revealed row offscreen");
  settings.scrolled(300, 800, 1400, nav());
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 300);
});

test("R5-2: a quick Back before the page left reports layout waits for the destination's fresh layout", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("profiles", "tall");
  const tall = nav();
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(900, 1000, 1500, tall);
  const first = settings.generation();
  goToSettingsPane("profiles", "short");
  settings.show();
  settingsBack();
  assert.equal(nav().scroll, 900);
  assert.equal(settings.show(), null, "the overview shown again keeps its spot and never settles from its earlier 1500");
  assert.deepEqual(settings.reports, []);
  assert.equal(settings.lay(1500, tall, first), null, "a late layout from the earlier showing settles nothing");
  assert.deepEqual(settings.lay(1000), { y: 0, restore: "unreachable" }, "the fresh 1000 decides: 900 is out of reach");
});

test("R5-2: a page shown again restores once its own layout can reach the saved offset", () => {
  fresh();
  const settings = window(500);
  goToSettingsPane("tabs");
  const tabs = nav();
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(900, 1000, 1500, tabs);
  goToSettingsPane("general");
  settings.show();
  settingsBack();
  assert.deepEqual(settings.show(), { y: 0, restore: null });
  assert.deepEqual(settings.lay(1600), { y: 900, restore: null });
  settings.scrolled(900, 1100, 1600, tabs);
  assert.deepEqual(settings.reports, ["applied"]);
});

test("R6-1: switching profile pills keeps the one scroll view's real offset for a search reveal", () => {
  fresh();
  const { useBrowser } = globalThis.__browserStore;
  const work = useBrowser.getState().createProfile({ name: "Work" });
  const home = useBrowser.getState().createProfile({ name: "Home" });
  const settings = window(500);
  goToSettingsPane("profiles", work);
  settings.show();
  settings.lay(1500);
  later();
  settings.scrolled(550, 1000, 1500, nav());
  replaceSettingsPlace(home);
  assert.equal(settings.show(), null, "the same page with another profile doesn't jump to the top");
  assert.equal(settings.memory.revealTop(), 550, "until it lays out, the view still sits where the last profile left it");
  assert.deepEqual(settings.lay(1500), { y: 0, restore: null });
  assert.equal(settings.memory.revealTop(), 0, "the settled spot is what a reveal judges against");
  goToSettingsPane("tabs");
  assert.deepEqual(settings.show(), { y: 0, restore: null });
  assert.equal(settings.memory.revealTop(), 0);
});

test("R6-2: a restore whose wait has expired saves the offset as an ordinary scroll and reports nothing", () => {
  returnToSaved(500);
  const settings = window();
  settings.show();
  assert.deepEqual(settings.lay(1400), { y: 500, restore: null });
  later();
  settings.scrolled(500, 800, 1400, nav());
  assert.deepEqual(settings.reports, [], "a late match isn't credited as applied");
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 500);

  returnToSaved(500);
  const clamped = window();
  clamped.show();
  clamped.lay(1400);
  later();
  clamped.scrolled(480, 480, 1400, nav());
  assert.deepEqual(clamped.reports, [], "a late clamp isn't credited as clamped");
  settingsForward();
  settingsBack();
  assert.equal(nav().scroll, 480);
});
