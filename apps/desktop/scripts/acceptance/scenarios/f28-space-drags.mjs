import { startBrowser } from "../lib/flows.mjs";
import { sessionSeed } from "../lib/seed.mjs";
import { pause, until } from "../lib/util.mjs";

const SPACES = [
  { id: "default", name: "Personal", prefix: "P", tiles: 0 },
  { id: "work", name: "Work", prefix: "W", tiles: 2 },
];
const ROWS = 6;
const js = (value) => JSON.stringify(value);

function spacesSeed() {
  const seed = sessionSeed({ windows: [{ id: "main", urls: ["about:blank"] }] });
  const template = Object.values(seed.tabs)[0];
  const window = seed.windows.main;
  seed.tabs = {};
  window.tabIds = [];
  seed.profileOrder = [];
  SPACES.forEach((space, index) => {
    seed.profiles[space.id] = { id: space.id, name: space.name, color: index ? "blue" : "plum", icon: null, createdAt: index + 1 };
    seed.profileOrder.push(space.id);
    const titles = [...Array.from({ length: space.tiles }, (_, i) => `${space.prefix}T${i}`), ...Array.from({ length: ROWS }, (_, i) => `${space.prefix}${i}`)];
    const ids = titles.map((title) => {
      const id = `${space.id}-${title}`;
      seed.tabs[id] = { ...template, id, profileId: space.id, url: `data:text/html,<title>${title}</title>`, title };
      return id;
    });
    window.tabIds.push(...ids);
    window.activeTabIds[space.id] = ids[space.tiles];
  });
  window.profileId = "default";
  return seed;
}

function sidebar(shell) {
  const listOrder = (profile) => shell.state(`return s.windows[windowId].tabIds.filter(id => s.tabs[id].profileId === ${js(profile)} && !s.tabs[id].pin).map(id => s.tabs[id].title)`);
  const tileTitles = (profile) => shell.state(`return s.windows[windowId].tabIds.filter(id => s.tabs[id].profileId === ${js(profile)} && s.tabs[id].pin?.as === "tile").map(id => s.tabs[id].title)`);
  const current = () => shell.state("return s.windows[windowId].profileId");
  const shown = (selector) => shell.eval(`(() => {
    const visible = (n) => { const r = n.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0 || r.left < 0 || r.left > 400) return null; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return hit && (n.contains(hit) || hit.contains(n)) ? r : null; };
    ${selector}
  })()`);
  const row = (title) => shown(`let best = null; for (const n of document.querySelectorAll("div")) { if ((n.innerText ?? "").trim() !== ${js(title)}) continue; const r = visible(n); if (r && (!best || r.width * r.height < best.w * best.h)) best = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; } return best;`);
  const tiles = () => shown(`const seen = new Map(); for (const n of document.querySelectorAll("div")) { const r = visible(n); if (!r || r.top > 250 || r.height < 38 || r.height > 70 || r.width < 40 || r.width > 165) continue; const key = Math.round(r.left / 10) + ":" + Math.round(r.top / 10); if (!seen.has(key)) seen.set(key, { x: r.left + r.width / 2, y: r.top + r.height / 2 }); } return [...seen.values()].sort((a, b) => a.y - b.y || a.x - b.x);`);
  const button = (type, x, y) => shell.session.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
  const drag = async (from, to, steps) => {
    await shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y, buttons: 0 });
    await button("mousePressed", from.x, from.y);
    try {
      await pause(60);
      for (let i = 1; i <= steps; i++) {
        await button("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
        await pause(16);
      }
      await pause(250);
    } finally {
      await button("mouseReleased", to.x, to.y);
    }
    await pause(900);
  };
  const groupCount = () => shell.state("return Object.keys(s.groups ?? {}).length");
  const moveRow = async (profile, title, towardTitle, steps) => {
    const before = await listOrder(profile);
    const groups = await groupCount();
    const [a, b] = [await row(title), await row(towardTitle)];
    if (!a || !b) throw new Error(`rows not on screen: ${js({ [title]: a, [towardTitle]: b })}`);
    await drag({ x: a.x, y: a.y }, { x: a.x, y: b.y - 14 }, steps);
    const after = await listOrder(profile);
    const [from, to, landed] = [before.indexOf(title), before.indexOf(towardTitle), after.indexOf(title)];
    const toward = to < from ? landed < from && landed >= to : landed > from && landed <= to;
    if (!toward || (await groupCount()) !== groups) throw new Error(`${title} didn't move toward ${towardTitle}: ${before.join(" ")} -> ${after.join(" ")}`);
    return after.join(" ");
  };
  const switchTo = async (switching, profile) => {
    await switching();
    await until(async () => (await current()) === profile, { timeout: 8000, label: `the window to show ${profile}` });
    await pause(1200);
    return profile;
  };
  return { listOrder, tileTitles, row, tiles, drag, moveRow, switchTo };
}

export default {
  id: "F28",
  issue: 2341,
  title: "Sidebar drags reorder tabs in every space, not only the one the window opened in",
  deadline: 240000,
  manual: [
    { name: "Reorder with a real pointer after switching spaces", steps: ["Open a window with two spaces that each have a few tabs.", "Switch to the second space with its footer dot or a swipe, then drag a tab up and another down with a mouse and with a touchpad.", "A gap opens under the pointer and each tab stays where it was let go."], reason: "headless input is synthesized through CDP" },
  ],
  async run(t) {
    const { shell } = await startBrowser(t, { name: "spaces", session: spacesSeed() });
    const ui = sidebar(shell);
    await t.check("Work's tiles are pinned", async () => {
      await shell.state(`s.switchProfile(windowId, "work"); s.pinTabs(Object.keys(s.tabs).filter(id => /^work-WT/.test(id)), true); s.switchProfile(windowId, "default"); return true;`);
      const tiles = await until(async () => ((await ui.tileTitles("work")).length === 2 ? ui.tileTitles("work") : false), { timeout: 8000, label: "Work's tiles" });
      await pause(1500);
      return { tiles };
    }, { critical: true });
    await t.check("a row reorders in the space the window opened in", () => ui.moveRow("default", "P4", "P1", 30));
    await t.check("the footer dot switches to Work", async () => {
      const dot = await until(() => shell.eval(`(() => { const r = [...document.querySelectorAll('[aria-label="Work"]')].map(n => n.getBoundingClientRect()).find(r => r.width > 0 && r.top > 300 && r.left < 400); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : false; })()`), { timeout: 8000, label: "Work's footer dot" });
      return ui.switchTo(() => shell.mouse(dot.x, dot.y), "work");
    }, { critical: true });
    await t.check("a row dragged up reorders in Work", () => ui.moveRow("work", "W4", "W1", 30));
    await t.check("a quick row drag down reorders in Work", () => ui.moveRow("work", "W0", "W3", 4));
    await t.check("a Top Apps tile dragged into Work's list leaves the grid for the list", async () => {
      const [tile] = await ui.tiles();
      const target = await ui.row("W2");
      if (!tile || !target) throw new Error(`not on screen: ${js({ tile, target })}`);
      const before = await ui.tileTitles("work");
      await ui.drag(tile, { x: target.x, y: target.y - 14 }, 30);
      const left = await ui.tileTitles("work");
      const moved = before.filter((title) => !left.includes(title));
      const list = await ui.listOrder("work");
      if (moved.length !== 1 || !list.includes(moved[0])) throw new Error(`tiles ${before} -> ${left}; list ${list.join(" ")}`);
      return { moved: moved[0], list: list.join(" ") };
    });
    await t.screenshot(shell, "work-after-drags");
    await t.check("the previous-space command switches back to Personal", () => ui.switchTo(() => shell.command("previousProfile"), "default"), { critical: true });
    await t.check("a row still reorders in Personal", () => ui.moveRow("default", "P5", "P0", 30));
  },
};
