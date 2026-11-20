import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, reporter, session } from "../../../scripts/lib/instance.mjs";

const [appArg] = process.argv.slice(2);
if (!appArg) {
  console.error("usage: node collapsed-fold-test.mjs <Debug Ardia.app>");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "ac-collapsed-fold-"));
const rep = reporter(join(scratch, "results.log"), { name: "collapsed-fold-test" });
const group = (id, tabIds, rest = {}) => ({ id, windowId: "w1", profileId: "default", name: id, collapsed: true, tabIds, shownTabIds: tabIds, createdAt: 1, ...rest });

async function track(watch, setup, actions) {
  const [target, anchor = null] = [watch].flat();
  const ys = await app.eval(`
    const s = () => ac.store.getState();
    const measure = (id) => ac.sidebarRows.measureRow("w1", id);
    const anchor = ${JSON.stringify(anchor)};
    const row = (id) => (anchor ? Promise.all([measure(id), measure(anchor)]).then(([r, a]) => r && a && { y: r.y - a.y }) : measure(id));
    const actions = ${actions};
    ${setup}
    globalThis.sidebarMotionScale = 5;
    return new Promise((r) => setTimeout(r, 1200)).then(() => row(${JSON.stringify(target)})).then((start) => {
      if (!start) throw new Error("row ${target} is missing");
      const samples = [start.y];
      const began = performance.now();
      let next = 0;
      const frame = () => {
        while (next < actions.length && performance.now() - began >= actions[next][0]) actions[next++][1]();
        if (performance.now() - began >= 1400) return Promise.resolve();
        return new Promise((r) => requestAnimationFrame(r)).then(() => row(${JSON.stringify(target)})).then((r) => {
          if (!r) throw new Error("row ${target} disappeared");
          samples.push(r.y);
          return frame();
        });
      };
      return frame().then(() => {
        globalThis.sidebarMotionScale = 1;
        return samples;
      });
    });
  `, { timeout: 20000 });
  const steps = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
  const result = { travel: Math.abs(ys.at(-1) - ys[0]), swing: Math.max(...ys.map((y) => Math.abs(y - ys[0]))), largest: Math.max(...steps), moving: steps.filter((d) => d > 0.05).length };
  rep.log({ watch, ...result, ys });
  return result;
}

function eased({ travel, largest, moving }, expected, what) {
  assert.ok(Math.abs(travel - expected) <= 1, `${what}: moved ${travel} pt, expected ${expected}`);
  assert.ok(largest <= 6, `${what}: a ${largest} pt step in one frame`);
  assert.ok(moving >= 10, `${what}: did not ease`);
}

let app;
try {
  app = await launch(resolve(appArg), {
    data: join(scratch, "data"), onboarded: true,
    session: session({
      windows: [{ activeTabIds: { default: "direct" } }],
      tabs: ["inside", "direct", "below", "p1", "p2", "a", "b", "c", "k1", "k2", "x", "h1", "m1", "m2", "m3", "la", "lb", "px", "g1", "py", "q1", "q2", "q3", "n1", "n2", "rz", "d1", "d2", "last"].map((id) => ({ id, url: `about:blank#${id}`, title: id })),
      groups: [
        group("outer", ["inside", "direct"]),
        group("inner", ["inside"], { parentId: "outer", createdAt: 2 }),
        group("g", ["a", "b", "c"], { createdAt: 3 }),
        group("k", ["k1", "k2"], { createdAt: 4, shownTabIds: [] }),
        group("h", ["h1"], { createdAt: 5, shownTabIds: [] }),
        group("m", ["m1", "m2", "m3"], { createdAt: 6, shownTabIds: ["m1", "m2"] }),
        group("P", ["px", "g1", "py"], { createdAt: 7, collapsed: false }),
        group("G", ["g1"], { parentId: "P", createdAt: 8, shownTabIds: [] }),
        group("pg", ["q1", "q2", "q3"], { createdAt: 9, shownTabIds: [], pinned: true }),
        group("R", ["n1", "n2", "rz"], { createdAt: 10, shownTabIds: [] }),
        group("N", ["n1", "n2"], { parentId: "R", createdAt: 11, shownTabIds: [] }),
        group("D1", ["d1", "d2"], { createdAt: 12, shownTabIds: [] }),
        group("D2", ["d1", "d2"], { parentId: "D1", createdAt: 13, shownTabIds: ["d1"] }),
        group("D3", ["d1", "d2"], { parentId: "D2", createdAt: 14, shownTabIds: ["d1"] }),
      ],
    }),
  });
  await rep.check("hiding a nested first row eases its top gap while the active direct tab stays", async () => {
    const result = await app.eval(`
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const row = (id) => ac.sidebarRows.measureRow("w1", id);
      globalThis.sidebarMotionScale = 3;
      return pause(600).then(() => Promise.all([row("outer"), row("direct")])).then(([header, direct]) => {
        if (!header || !direct) throw new Error("fixture rows did not mount");
        return ac.engine.call("windows.list").then((windows) => {
          const window = windows.find((w) => w.hasRoot).window;
          const at = (header.x + 50) + "," + (header.y + header.height / 2);
          return ac.engine.call("windows.dev", { window, action: "mouse:down:" + at }).then(() => {
            const samples = [direct.y];
            const started = performance.now();
            const frame = () => {
              if (performance.now() - started >= 800) return Promise.resolve();
              return new Promise((r) => requestAnimationFrame(r)).then(() => row("direct")).then((r) => {
                if (!r) throw new Error("the retained tab disappeared");
                samples.push(r.y);
                return frame();
              });
            };
            return ac.engine.call("windows.dev", { window, action: "mouse:up:" + at }).then(frame).then(() => {
              const s = ac.store.getState();
              return { samples, collapsed: s.groups.outer.collapsed, shown: s.groups.outer.shownTabIds || [], active: s.windows.w1.activeTabIds.default };
            });
          });
        });
      });
    `, { timeout: 15000 });
    rep.log(result);
    assert.equal(result.collapsed, true);
    assert.equal(result.active, "direct");
    assert.ok(!result.shown.includes("inside"), "header click did not hide the nested row");
    const ys = result.samples;
    const end = ys.at(-1);
    assert.ok(ys[0] - end > 20, "the nested group did not fold away");
    assert.ok(ys.some((y) => y > end + 0.25 && y < end + 2.75), "the last 3 pt of padding snapped instead of easing");
    return { frames: ys.length, end };
  });
  await rep.check("a nested group leaving a collapsed group folds from the height it had, not the one it shrinks to", async () => {
    const setup = `s().activate("inside"); s().updateGroup("outer", { collapsed: true, shownTabIds: [] }); s().updateGroup("inner", { shownTabIds: [] });`;
    eased(await track("below", setup, `[[0, () => s().activate("direct")]]`), 40.5, "the rows below the outer group");
  });
  for (const [name, from, to] of [["a kept pinned row and the gap above its divider fold in together", "below", "p2"], ["a kept pinned row and the gap above its divider fold out together", "p2", "below"]]) {
    await rep.check(name, async () => {
      const setup = `if (!s().tabs.p1.pinned) s().pinTabs(["p1", "p2"], true, true); s().updateProfile("default", { pinnedCollapsed: true }); ac.actions.switchToTab(${JSON.stringify(from)});`;
      eased(await track("outer", setup, `[[0, () => ac.actions.switchToTab(${JSON.stringify(to)})]]`), 34, "the rows below the pinned section");
    });
  }
  await rep.check("switching to a tab of a collapsed group folds its row in", async () => {
    eased(await track("last", `ac.actions.switchToTab("below");`, `[[0, () => ac.actions.switchToTab("k1")]]`), 37, "the rows below the group");
  });
  await rep.check("a closed kept row's ghost keeps its place when the row under it closes too", async () => {
    eased(await track("c", `ac.actions.switchToTab("below");`, `[[0, () => s().closeTab("a")], [250, () => s().closeTab("b")]]`), 74, "the last kept row");
  });
  await rep.check("a row closed while it folds away leaves as a ghost from its current height", async () => {
    eased(await track("last", `ac.actions.switchToTab("k2");`, `[[0, () => s().updateGroup("k", { shownTabIds: ["k2"] })], [250, () => s().closeTab("k1")]]`), 37, "the row below the group");
  });
  await rep.check("closing the tab above a collapsed group as focus moves into it slides the rows below from the closed tab's place", async () => {
    const { active, from } = await app.eval(`
      const s = () => ac.store.getState();
      s().activate("h1");
      s().activate("x");
      s().updateGroup("h", { shownTabIds: [] });
      return new Promise((r) => setTimeout(r, 1200)).then(() => {
        s().closeTab("x");
        const active = s().windows.w1.activeTabIds.default;
        return new Promise((r) => requestAnimationFrame(r)).then(() => ({ active, from: globalThis.sidebarMotion.w1.slides.get("t:last")?.from ?? 0 }));
      });
    `, { timeout: 15000 });
    assert.equal(active, "h1", "closing the tab didn't hand focus into the collapsed group");
    assert.equal(from, 37, "the rows below the group don't slide with the growing group, so they jump up and back");
  });
  await rep.check("expanding a group while its hidden rows still fold away opens them from where they are", async () => {
    const opened = await track("last", `ac.actions.switchToTab("below");`, `[[0, () => s().updateGroup("m", { shownTabIds: [] })], [250, () => s().updateGroup("m", { collapsed: false })]]`);
    assert.ok(opened.largest <= 12, `the rows below the group jumped ${opened.largest} pt in one frame`);
  });
  await rep.check("a live folder item never shown before folds in as the kept one folds out, and the kept one folds away when focus leaves", async () => {
    const setup = `
      const live = ac.live.store;
      const folder = live.createFolder("default", "pullRequests");
      const item = (id) => ({ id, source: "github", url: "about:blank#" + id, title: id, subtitle: "", icon: null, updatedAt: 1 });
      live.applyFetch(folder, [item("la"), item("lb")], {});
      live.setStatus(folder, { state: "idle", lastFetch: Date.now(), error: null });
      for (const id of ["la", "lb"]) s().updateTab(id, { liveItem: { folderId: folder, itemId: id } });
      s().updateProfile("default", { pinnedCollapsed: false });
      ac.actions.switchToTab("la");
      live.updateFolder(folder, { collapsed: true });`;
    const swap = await track("last", setup, `[[0, () => ac.actions.switchToTab("lb")]]`);
    assert.ok(swap.swing <= 1, `the rows below the folder moved ${swap.swing} pt while one row replaced another of the same height`);
    const back = await track("last", "", `[[0, () => ac.actions.switchToTab("la")], [250, () => ac.actions.switchToTab("lb")]]`);
    assert.ok(back.swing <= 2, `the rows below the folder moved ${back.swing} pt when the switch turned back halfway`);
    eased(await track("last", "", `[[0, () => ac.actions.switchToTab("below")]]`), 36, "the rows below the folder as its kept row folds away");
  });
  await rep.check("closing a tab above a collapsed group inside an expanded one, as focus moves into it, slides the rows below", async () => {
    const { active, from } = await app.eval(`
      const s = () => ac.store.getState();
      s().activate("g1");
      s().activate("px");
      s().updateGroup("G", { shownTabIds: [] });
      return new Promise((r) => setTimeout(r, 1200)).then(() => {
        s().closeTab("px");
        const active = s().windows.w1.activeTabIds.default;
        return new Promise((r) => requestAnimationFrame(r)).then(() => ({ active, from: globalThis.sidebarMotion["w1:P"]?.slides.get("t:py")?.from ?? 0 }));
      });
    `, { timeout: 15000 });
    assert.equal(active, "g1", "closing the tab didn't hand focus into the nested collapsed group");
    assert.equal(from, 37, "the row below the nested group doesn't slide with the growing group, so it jumps up and back");
  });
  await rep.check("a collapsed pinned group shown again opens to the height of the rows it shows now", async () => {
    const setup = `s().updateProfile("default", { pinnedCollapsed: true }); s().activate("q1"); setTimeout(() => s().activate("below"), 300);`;
    const r = await track("outer", setup, `[[0, () => s().activate("q2")]]`);
    assert.ok(Math.abs(r.travel - 108.5) <= 1, `the rows below the pinned section moved ${r.travel} pt, expected 108.5`);
    assert.ok(r.largest <= 12 && r.moving >= 10, `the pinned group opened with a ${r.largest} pt step in one frame`);
  });
  await rep.check("a nested group that grows while it folds into a collapsed group opens to its new height without a step", async () => {
    const setup = `ac.actions.switchToTab("below"); s().updateGroup("R", { shownTabIds: [] }); s().updateGroup("N", { shownTabIds: [] });`;
    const r = await track(["D1", "R"], setup, `[[0, () => s().activate("n1")], [300, () => s().activate("n2")]]`);
    assert.ok(Math.abs(r.travel - 114.5) <= 1, `the rows below the group moved ${r.travel} pt, expected 114.5 for the nested group's name and both its tabs`);
    assert.ok(r.largest <= 6 && r.moving >= 10, `the rows below the group took a ${r.largest} pt step in one frame`);
  });
  await rep.check("a group two levels down that grows while its grandparent folds it in opens to its new height without a step", async () => {
    const setup = `ac.actions.switchToTab("below"); s().updateGroup("D1", { shownTabIds: [] }); s().updateGroup("D2", { shownTabIds: ["d1"] }); s().updateGroup("D3", { shownTabIds: ["d1"] });`;
    const r = await track(["last", "D1"], setup, `[[0, () => s().activate("d1")], [300, () => s().activate("d2")]]`);
    assert.ok(Math.abs(r.travel - 154.5) <= 1, `the rows below the group moved ${r.travel} pt, expected 154.5 for both nested groups' names and both tabs`);
    assert.ok(r.largest <= 12 && r.moving >= 10, `the rows below the group took a ${r.largest} pt step in one frame`);
  });
} catch (error) {
  rep.record("setup", { error });
} finally {
  await app?.quit();
  rmSync(join(scratch, "data"), { recursive: true, force: true });
}
process.exitCode = rep.summary() ? 0 : 1;
