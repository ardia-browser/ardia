import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { downloadById, duplicateIds } from "../lib/assertions.mjs";
import { restartBrowser, startBrowser } from "../lib/flows.mjs";
import { js, nonce, pause, until } from "../lib/util.mjs";

const downloadsOf = (shell) => shell.state("return s.downloads ?? [];");
const PANEL = '[data-testid="ardia-downloads-popover"]';
const panelOpen = (shell) => shell.state("return s.windowUi[windowId]?.downloadsOpen === true;");

function panelPoint(shell, { text = null, label = null }) {
  return shell.eval(`(() => {
    const panel = document.querySelector(${js(PANEL)});
    if (!panel) return null;
    let best = null;
    for (const n of panel.querySelectorAll('*')) {
      const match = ${js(label)} === null ? (n.innerText ?? '').trim() === ${js(text)} : n.getAttribute('aria-label') === ${js(label)};
      if (!match) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (!best || r.width * r.height < best.area) best = { x: r.left + r.width / 2, y: r.top + r.height / 2, area: r.width * r.height };
    }
    return best;
  })()`);
}

async function pressInPanel(shell, target) {
  const point = await until(() => panelPoint(shell, target), { timeout: 6000, label: `${target.label ?? target.text} in the downloads panel` });
  await shell.mouse(point.x, point.y);
  return point;
}

function menuItemPoint(shell, title) {
  return shell.eval(`(() => {
    for (const n of document.querySelectorAll('.ardia-menu-item:not(.disabled)')) {
      if ((n.querySelector('.ardia-menu-title')?.textContent ?? '').trim() !== ${js(title)}) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  })()`);
}

async function openPanel(shell) {
  if (!(await panelOpen(shell))) await shell.command("downloads");
  await shell.waitState("return s.windowUi[windowId]?.downloadsOpen === true;", { timeout: 5000, label: "downloads panel" });
  await until(() => panelPoint(shell, { text: "RECENT DOWNLOADS" }), { timeout: 5000, label: "the downloads panel on screen" });
  await pause(400);
}

async function closePanel(shell) {
  if (await panelOpen(shell)) await shell.command("downloads");
  await shell.waitState("return s.windowUi[windowId]?.downloadsOpen === false;", { timeout: 5000, label: "the downloads panel to close" });
  await pause(400);
}

async function stillOpen(shell, action) {
  await pause(500);
  if (!(await panelOpen(shell))) throw new Error(`the downloads panel closed after ${action}`);
}

async function recordingXdgOpen(dir) {
  const bin = join(dir, "bin");
  const log = join(dir, "xdg-open.log");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$1" >> '${log.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
  const opened = () => readFile(log, "utf8").then((text) => text.split("\n").filter(Boolean).map((line) => resolve(...line.split("\t"))), () => []);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, opened };
}

async function waitDownload(shell, test, label, timeout = 20000) {
  return until(async () => (await downloadsOf(shell)).find(test) ?? false, { timeout, label });
}

async function startDownload(shell, tabId, url, filename) {
  await shell.navigate(tabId, url);
  return waitDownload(shell, (d) => d.filename?.endsWith(filename) || d.path?.endsWith(filename), `download ${filename} to appear`);
}

async function waitEngineDownload(shell, test, label, timeout = 10000) {
  return until(async () => {
    const reply = await shell.call("downloads.list", {});
    return (reply.ok && Array.isArray(reply.value) && reply.value.find(test)) || false;
  }, { timeout, label });
}

async function control(shell, verb, id) {
  const reply = await shell.call(`downloads.${verb}`, { id });
  if (!reply.ok) throw new Error(`downloads.${verb} failed: ${reply.code} ${reply.message}`);
  return reply.value;
}

async function receivedStalls(shell, id) {
  await pause(700);
  const first = (await waitEngineDownload(shell, (d) => d.id === id, "paused download in the engine")).received;
  await pause(1500);
  const second = (await waitEngineDownload(shell, (d) => d.id === id, "paused download in the engine")).received;
  return { first, second, stalled: first === second };
}

export default {
  id: "F08",
  issue: 18,
  title: "Downloads events, controls, settings and restart behaviour",
  deadline: 360000,
  manual: [
    { name: "Move to Trash from the row menu", steps: ["Right-click a finished download in Ctrl+J and choose Move to Trash.", "The file moves to ~/.local/share/Trash/files with a .trashinfo record and the row shows it as gone."], reason: "F08D drives Open and Show in Folder through a private session; F08 opens the row's menu for Escape and Open, and Move to Trash stays a manual desktop check" },
  ],
  async run(t) {
    const run = nonce("f08");
    const folder = await t.scratch("downloads");
    const other = join(folder, "other");
    await mkdir(other, { recursive: true });
    const desktop = await recordingXdgOpen(await t.scratch("desktop"));
    let state = await startBrowser(t, { name: "downloads", preferences: { downloads: folder }, extraArgs: [`--ardia-downloads-dir=${folder}`], env: desktop.env });
    const page = t.fixtures.url.page(1, run);
    const tabId = await state.shell.newTab(page);
    await state.shell.waitTabUrl(tabId, (u) => u === page);

    const small = `small-${run}.bin`;
    let smallDownload;
    await t.check("a known file downloads to completion and is on disk", async () => {
      await startDownload(state.shell, tabId, t.fixtures.url.download(small, 65536), small);
      smallDownload = await waitDownload(state.shell, (d) => d.filename?.endsWith(small) && d.state === "finished", "small download to finish");
      const size = (await stat(smallDownload.path)).size;
      if (size !== 65536) throw new Error(`downloaded ${size} bytes`);
      const status = await state.shell.invoke("ArdiaSystem.fileStatus", { args: [[smallDownload.path]] });
      if (!status.ok || status.value?.[0] !== true) throw new Error(`fileStatus ${JSON.stringify(status)}`);
      return { path: smallDownload.path, size };
    }, { critical: true });
    await t.check("Ctrl+J shows the finished download", async () => {
      if (await state.shell.state("return s.windowUi[windowId]?.downloadsOpen === true;")) {
        await state.shell.command("downloads");
        await state.shell.waitState("return s.windowUi[windowId]?.downloadsOpen === false;", { timeout: 5000, label: "the auto-opened downloads popover to close" });
      }
      await state.shell.command("downloads");
      await state.shell.waitState("return s.windowUi[windowId]?.downloadsOpen === true;", { timeout: 5000, label: "downloads popover" });
      await until(async () => (await state.shell.text()).includes(small), { timeout: 5000, label: `${small} in the downloads list` });
      await state.shell.command("downloads");
      return true;
    });
    await t.check("a press inside the downloads panel reaches it and leaves it open", async () => {
      await closePanel(state.shell);
      await openPanel(state.shell);
      await t.screenshot(state.shell, "panel-before-inside-press");
      const point = await pressInPanel(state.shell, { text: "RECENT DOWNLOADS" });
      await pause(500);
      await t.screenshot(state.shell, "panel-after-inside-press");
      await stillOpen(state.shell, "a press on its header");
      return point;
    });
    await t.check("a finished row in the downloads panel opens its file, and its reveal button shows it", async () => {
      await openPanel(state.shell);
      await pressInPanel(state.shell, { text: small });
      await until(async () => (await desktop.opened()).includes(smallDownload.path) || false, { timeout: 8000, label: "xdg-open on the downloaded file" });
      await stillOpen(state.shell, "opening a file");
      const row = await panelPoint(state.shell, { text: small });
      await state.shell.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: row.x, y: row.y });
      const reveal = await until(() => state.shell.eval(`[...document.querySelectorAll(${js(`${PANEL} [aria-label^="Show in"]`)})].map(n => n.getAttribute('aria-label')).find(Boolean) ?? false`), { timeout: 5000, label: "the reveal button on the hovered row" });
      await pressInPanel(state.shell, { label: reveal });
      await until(async () => (await desktop.opened()).includes(dirname(smallDownload.path)) || false, { timeout: 8000, label: "xdg-open on the download's folder" });
      await stillOpen(state.shell, "showing a file");
      return { opened: await desktop.opened(), reveal };
    });
    await t.check("a row's menu takes Escape and its item presses, and leaves the downloads panel open", async () => {
      await openPanel(state.shell);
      const row = await until(() => panelPoint(state.shell, { text: small }), { timeout: 6000, label: `${small} in the downloads panel` });
      const showMenu = async () => {
        await state.shell.mouse(row.x, row.y, { button: "right" });
        return until(() => menuItemPoint(state.shell, "Open"), { timeout: 5000, label: "Open in the row's menu" });
      };
      await showMenu();
      await state.shell.key("Escape", { code: "Escape", keyCode: 27 });
      await until(async () => !(await menuItemPoint(state.shell, "Open")), { timeout: 5000, label: "Escape to close the row's menu" });
      await stillOpen(state.shell, "Escape closed the row's menu");
      const openedBefore = (await desktop.opened()).filter((path) => path === smallDownload.path).length;
      const item = await showMenu();
      await state.shell.mouse(item.x, item.y);
      await until(async () => (await desktop.opened()).filter((path) => path === smallDownload.path).length > openedBefore || false, { timeout: 8000, label: "xdg-open on the file chosen from the row's menu" });
      await stillOpen(state.shell, "choosing Open from the row's menu");
      return { opened: smallDownload.path };
    });
    await t.check("View all downloads in the panel opens the downloads page and closes the panel", async () => {
      await openPanel(state.shell);
      await pressInPanel(state.shell, { text: "View all downloads" });
      await state.shell.waitState("return s.windowUi[windowId]?.downloadsOpen === false;", { timeout: 5000, label: "the panel to close" });
      const active = await until(async () => {
        const id = await state.shell.activeTabId();
        const tab = id ? await state.shell.tab(id) : null;
        return tab?.url?.startsWith("ardia://downloads") ? tab.url : false;
      }, { timeout: 8000, label: "the downloads page in the active tab" });
      await pause(400);
      return { active };
    });
    await t.check("Pause, Resume and Cancel in the downloads panel control a running download", async () => {
      const name = `panel-${run}.bin`;
      const d = await startDownload(state.shell, tabId, t.fixtures.url.slow(name, 6 << 20), name);
      await openPanel(state.shell);
      await pressInPanel(state.shell, { label: "Pause" });
      await waitEngineDownload(state.shell, (x) => x.id === d.id && x.paused === true, "the engine to pause it");
      await stillOpen(state.shell, "Pause");
      await pressInPanel(state.shell, { label: "Resume" });
      await waitEngineDownload(state.shell, (x) => x.id === d.id && x.paused === false && x.state === "downloading", "the engine to resume it");
      await stillOpen(state.shell, "Resume");
      await pressInPanel(state.shell, { label: "Cancel" });
      await waitEngineDownload(state.shell, (x) => x.id === d.id && x.state === "cancelled", "the engine to cancel it");
      await stillOpen(state.shell, "Cancel");
      t.fixtures.release(name);
      return { id: d.id };
    });
    await t.check("Keep and Discard in the downloads panel decide a held insecure download", async () => {
      const decided = {};
      for (const [button, end] of [["Keep", "finished"], ["Discard", "cancelled"]]) {
        const name = `held-${button.toLowerCase()}-${run}.bin`;
        await state.shell.navigate(tabId, t.fixtures.url.http("plain.ardia.test", `/download/${name}?size=2048`));
        const held = await waitDownload(state.shell, (d) => d.filename?.endsWith(name) && d.dangerous === true && d.state === "downloading", `${name} held for Keep or Discard`);
        await openPanel(state.shell);
        await pressInPanel(state.shell, { text: button });
        decided[button] = (await waitEngineDownload(state.shell, (d) => d.id === held.id && d.state === end, `the engine to mark ${name} ${end} after ${button}`)).state;
        await stillOpen(state.shell, button);
      }
      return decided;
    });
    await t.check("a left or right press outside the downloads panel closes it, no part of that press reaches the control under it, and the next click does", async () => {
      await openPanel(state.shell);
      const target = await state.shell.eval(`(() => {
        const panel = document.querySelector(${js(PANEL)});
        const inert = ['Go Back', 'Go Forward', 'Reload'];
        const label = (n) => n.getAttribute('aria-label') ?? n.getAttribute('title') ?? '';
        const rank = (n) => { const i = inert.findIndex((name) => label(n).startsWith(name)); return i < 0 ? inert.length : i; };
        const controls = [...document.querySelectorAll('[aria-label], [title]')].filter((n) => rank(n) < inert.length).sort((a, b) => rank(a) - rank(b));
        for (const n of controls) {
          const r = n.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (!hit || panel.contains(hit) || !n.contains(hit)) continue;
          window.__outsidePress = [];
          for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu']) hit.addEventListener(type, () => window.__outsidePress.push(type));
          return { x, y, control: n.getAttribute('aria-label') ?? n.getAttribute('title') };
        }
        return null;
      })()`);
      if (!target) throw new Error("no Go Back, Go Forward or Reload control outside the panel");
      await state.shell.mouse(target.x, target.y);
      await state.shell.waitState("return s.windowUi[windowId]?.downloadsOpen === false;", { timeout: 5000, label: "the panel to close" });
      await pause(800);
      const reached = await state.shell.eval("window.__outsidePress");
      if (reached.length) throw new Error(`the closing press reached ${target.control}: ${reached.join(", ")}`);
      await openPanel(state.shell);
      await state.shell.eval("window.__outsidePress = [], true");
      await state.shell.mouse(target.x, target.y, { button: "right" });
      await state.shell.waitState("return s.windowUi[windowId]?.downloadsOpen === false;", { timeout: 5000, label: "a right-click to close the panel" });
      const rightReached = await state.shell.eval("window.__outsidePress.splice(0)");
      if (rightReached.length) throw new Error(`the closing right-click reached ${target.control}: ${rightReached.join(", ")}`);
      await state.shell.mouse(target.x, target.y);
      await pause(300);
      const nextReached = await state.shell.eval("window.__outsidePress.splice(0)");
      if (!nextReached.includes("click")) throw new Error(`a click right after the closing right-click was lost: ${nextReached.join(", ") || "nothing"} reached ${target.control}`);
      return { control: target.control, reached, rightReached, nextReached };
    });
    await t.check("Escape closes the downloads panel", async () => {
      await openPanel(state.shell);
      await state.shell.key("Escape", { code: "Escape", keyCode: 27 });
      await state.shell.waitState("return s.windowUi[windowId]?.downloadsOpen === false;", { timeout: 5000, label: "Escape to close the panel" });
      return true;
    });

    const slow = `slow-${run}.bin`;
    let slowDownload;
    await t.check("a slow download reports progress", async () => {
      await startDownload(state.shell, tabId, t.fixtures.url.slow(slow, 6 << 20), slow);
      slowDownload = await waitEngineDownload(state.shell, (d) => d.filename?.endsWith(slow) && d.state === "downloading" && d.received > 0, "slow download progress");
      return { received: slowDownload.received, total: slowDownload.total };
    }, { critical: true });
    await t.check("pause stops progress", async () => {
      await control(state.shell, "pause", slowDownload.id);
      await waitDownload(state.shell, (d) => d.id === slowDownload.id && d.paused === true, "paused flag");
      const sample = await receivedStalls(state.shell, slowDownload.id);
      if (!sample.stalled) throw new Error(`still receiving while paused ${JSON.stringify(sample)}`);
      return sample;
    });
    await t.check("resume continues and completes", async () => {
      await control(state.shell, "resume", slowDownload.id);
      await waitDownload(state.shell, (d) => d.id === slowDownload.id && d.paused === false, "resumed flag");
      t.fixtures.release(slow);
      const done = await waitDownload(state.shell, (d) => d.id === slowDownload.id && d.state === "finished", "slow download to finish", 60000);
      const size = (await stat(done.path)).size;
      if (size !== 6 << 20) throw new Error(`downloaded ${size} bytes`);
      slowDownload = done;
      return { size };
    });

    const cancelled = `cancel-${run}.bin`;
    let cancelledDownload;
    await t.check("cancel stops a download and removes its partial file", async () => {
      const d = await startDownload(state.shell, tabId, t.fixtures.url.slow(cancelled, 6 << 20), cancelled);
      await waitEngineDownload(state.shell, (x) => x.id === d.id && x.received > 0, "cancel candidate progress");
      await control(state.shell, "cancel", d.id);
      cancelledDownload = await waitDownload(state.shell, (x) => x.id === d.id && x.state === "cancelled", "cancelled state");
      const leftovers = () => readdir(folder).then((names) => names.filter((name) => name.includes(cancelled)));
      const left = await until(async () => ((await leftovers()).length ? false : []), { timeout: 5000, label: "the partial file to be deleted" }).catch(leftovers);
      if (left.length) throw new Error(`partial files left: ${left.join(", ")}`);
      return { id: d.id };
    });
    await t.check("remove forgets a finished download in the engine too", async () => {
      await state.shell.state(`s.removeDownload(${js(smallDownload.id)}); return true;`);
      await until(async () => !downloadById(await downloadsOf(state.shell), smallDownload.id), { timeout: 5000, label: "removed from the store" });
      const listed = await until(async () => {
        const reply = await state.shell.call("downloads.list", {});
        return reply.ok && !JSON.stringify(reply.value).includes(smallDownload.id) ? reply.value : false;
      }, { timeout: 8000, label: "removed from Chromium's download history" });
      return { remaining: Array.isArray(listed) ? listed.length : null };
    });
    await t.check("the destination folder setting changes where files land", async () => {
      const reply = await state.shell.call("downloads.setSettings", { folder: other });
      if (!reply.ok) throw new Error(`setSettings failed ${reply.code} ${reply.message}`);
      const name = `elsewhere-${run}.bin`;
      await startDownload(state.shell, tabId, t.fixtures.url.download(name, 2048), name);
      const done = await waitDownload(state.shell, (d) => d.filename?.endsWith(name) && d.state === "finished", "download into the new folder");
      if (!done.path.startsWith(other)) throw new Error(`landed in ${done.path}`);
      await state.shell.call("downloads.setSettings", { folder });
      return { path: done.path };
    });
    await t.check("Clear in the downloads panel removes finished and cancelled rows", async () => {
      await openPanel(state.shell);
      await pressInPanel(state.shell, { text: "Clear" });
      const left = await until(async () => {
        const list = await downloadsOf(state.shell);
        return list.every((d) => d.state === "downloading") ? list : false;
      }, { timeout: 5000, label: "cleared downloads" });
      await pause(500);
      const panel = await panelOpen(state.shell);
      await closePanel(state.shell);
      return { left: left.length, panelOpenAfterClear: panel };
    });
    await t.check("restart restores no stale, live or duplicate downloads", async () => {
      const kept = `kept-${run}.bin`;
      await startDownload(state.shell, tabId, t.fixtures.url.download(kept, 1024), kept);
      const keptDownload = await waitDownload(state.shell, (d) => d.filename?.endsWith(kept) && d.state === "finished", "kept download");
      await pause(1000);
      state = await restartBrowser(t, state, { preferences: { downloads: folder }, extraArgs: [`--ardia-downloads-dir=${folder}`] });
      const list = await until(async () => {
        const l = await downloadsOf(state.shell);
        return l.some((d) => d.id === keptDownload.id) ? l : false;
      }, { timeout: 15000, label: "the kept download after restart" });
      const problems = [];
      const dupes = duplicateIds(list);
      if (dupes.length) problems.push(`duplicates ${dupes.join(", ")}`);
      if (list.some((d) => d.state === "downloading")) problems.push("a download reports live after restart");
      for (const gone of [smallDownload?.id, slowDownload?.id, cancelledDownload?.id].filter(Boolean)) if (list.some((d) => d.id === gone)) problems.push(`cleared download ${gone} came back`);
      const popover = await state.shell.state("return s.windowUi[windowId]?.downloadsOpen ?? false;");
      if (popover) problems.push("restart opened the downloads popover");
      if (problems.length) throw new Error(problems.join("; "));
      return { count: list.length };
    });
  },
};
