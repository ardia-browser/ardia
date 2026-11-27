import { sleep } from "../../../../scripts/lib/instance.mjs";

const q = JSON.stringify;
const KEYS = { down: ["", 125], up: ["", 126], enter: ["\r", 36], escape: ["\u001b", 53], tab: ["\t", 48], backspace: ["\u007f", 51] };
const ROW = { inset: 5, login: 36, notice: 62 };

export async function waitFor(what, test, ms = 10_000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    last = await test().catch((e) => ({ error: String(e) }));
    if (last && !last.error) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${q(last)?.slice(0, 300)}`);
    await sleep(150);
  }
}

export function parseRows(ax) {
  const lines = ax.split("\n").map((line) => {
    const [, indent = "", role = "", label = ""] = line.match(/^(\s*)(\S+?)(?:: (.*))?$/) ?? [];
    return { depth: indent.length, role, label };
  });
  const depth = Math.min(...lines.filter((l) => l.role === "AXMenuItem").map((l) => l.depth));
  if (!Number.isFinite(depth)) return [];
  const rows = [];
  lines.forEach((line, i) => {
    if (line.depth !== depth || (line.role !== "AXMenuItem" && line.role !== "AXStaticText")) return;
    let end = i + 1;
    while (end < lines.length && lines[end].depth > depth) end++;
    const inside = lines.slice(i + 1, end);
    const icon = inside.find((c) => c.role === "AXImage")?.label ?? "";
    const bold = inside.map((c) => c.label.split(" | ").find((part) => part.startsWith("bold="))?.slice(5)).find((run) => run !== undefined) ?? "";
    rows.push({ title: line.label.split(", ")[0], label: line.label, notice: line.role !== "AXMenuItem", icon, bold });
  });
  return rows;
}

export const webkitTabs = (app, options = {}) => engineTabs(app, { ...options, engine: "webkit" });
export const chromiumTabs = (app, options = {}) => engineTabs(app, { ...options, engine: "chromium" });

export function engineTabs(app, { log = () => {}, engine: engineName = "webkit" } = {}) {
  const evalApp = (body, timeout = 20_000) => app.eval(body, { timeout });
  const engine = (name, payload) => evalApp(`return ac.engine.call(${q(name)}, ${q(payload)})`);
  const proceeded = new Set();

  async function useEngine(origins, chosen = engineName) {
    await evalApp(`const s = ac.store.getState(); const engines = { ...s.settings.websiteEngines }; for (const o of ${q(origins)}) ${chosen === "webkit" ? `engines[o] = "webkit"` : "delete engines[o]"}; s.updateSettings({ websiteEngines: engines }); return true`);
  }
  const useWebKit = (origins) => useEngine(origins, "webkit");

  async function open(url, { kind } = {}) {
    const origin = new URL(url).origin;
    await useEngine([origin]);
    let windowId;
    let id;
    if (kind) {
      windowId = await evalApp(`return ac.actions.openWindow({ kind: ${q(kind)}, url: ${q(url)} })`);
      id = await waitFor(`the ${kind} window's tab`, () => evalApp(`return ac.store.getState().windows[${q(windowId)}]?.tabIds[0] ?? null`), 15_000);
    } else {
      windowId = await evalApp("return ac.store.getState().windowOrder[0]");
      id = await evalApp(`return ac.store.getState().newTab(${q(windowId)}, { url: ${q(url)} })`);
    }
    const tab = handle(id, windowId, kind);
    await tab.loaded();
    const inChromium = !!(await engine("tabs.devBrowserId", { tabId: id }).catch(() => null));
    if (inChromium !== (engineName === "chromium")) throw new Error(`${url} opened in ${inChromium ? "Chromium" : "WebKit"}, not ${engineName}`);
    if ((await tab.value("document.title")) === "Privacy error") {
      const host = `${kind ?? "normal"} ${new URL(url).hostname}`;
      if (proceeded.has(host)) throw new Error(`${host} shows the certificate warning again`);
      await tab.click("#advanced");
      await waitFor("the certificate details", () => tab.value(`document.getElementById("details").classList.contains("open") || null`), 5000);
      await tab.click("#proceed");
      proceeded.add(host);
      await waitFor("the page past the certificate warning", async () => ((await tab.value("document.title")) !== "Privacy error" ? true : null), 20_000);
      await tab.loaded();
    }
    return tab;
  }

  function handle(id, windowId, kind) {
    const raw = (expr) => evalApp(`return ac.webviews.get(${q(id)})?.evaluate(${q(`post("result", JSON.stringify(${expr}))`)}) ?? null`);
    const value = async (expr) => {
      return raw(expr);
    };
    const windowNumber = () =>
      waitFor("the window number", async () => {
        const windows = (await engine("windows.list", {})).filter((w) => w.visible && w.hasRoot && !w.parentWindow);
        return ((kind && windows.find((w) => w.key)) || windows[0])?.window ?? null;
      }, 15_000);
    const act = async (window, action) => engine("windows.dev", { window, action });
    const panel = async () => {
      const children = JSON.parse((await act(await windowNumber(), "children")) || "[]");
      return children.find((c) => c.class === "NSPanel" && c.visible) ?? null;
    };
    const tab = {
      id,
      value,
      async loaded() {
        await waitFor(`tab ${id} loaded`, () => evalApp(`const t = ac.store.getState().tabs[${q(id)}]; return t?.title && !ac.tabLive.liveOf(${q(id)})?.isLoading ? true : null`), 30_000);
        await waitFor("the page script", () => value("document.readyState === 'complete' || null"), 10_000);
      },
      async navigate(url) {
        await useEngine([new URL(url).origin]);
        await evalApp(`ac.store.getState().navigate(${q(id)}, ${q(url)}, { userInitiated: true }); return true`);
        await waitFor("the new page", async () => ((await value("location.href")) === url ? true : null), 20_000);
        await tab.loaded();
      },
      async front() {
        await evalApp(`ac.actions.switchToTab(${q(id)}); return true`);
        await waitFor("the tab in front", () => evalApp(`return Object.values(ac.store.getState().windows[${q(windowId)}]?.activeTabIds ?? {}).includes(${q(id)}) || null`), 5000);
      },
      async clickAt(x, y) {
        await tab.front();
        const click = await evalApp(`return ac.shell.devClick(${q(windowId)}, { in: "page", x: ${Math.round(x)}, y: ${Math.round(y)}, wait: 150 })`);
        log("click", x, y, q(click));
        return click;
      },
      async click(selector) {
        const rect = await waitFor(`the element ${selector}`, () => value(`(() => { const r = document.querySelector(${q(selector)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null })()`), 5000);
        return tab.clickAt(rect.x + Math.min(20, rect.width / 2), rect.y + rect.height / 2);
      },
      async type(text) {
        await tab.front();
        return evalApp(`return ac.shell.devTypeKeys(${q(windowId)}, ${q(text)}, 20)`, 60_000);
      },
      prompt() {
        return evalApp(`const p = ac.pageState.getState().pages[${q(id)}]?.passwordPrompt; return p ? { ...p, copy: ac.prompts.passwordPromptCopy(p) } : null`);
      },
      answer(action) {
        return evalApp(`return ac.prompts.answerPasswordPrompt(${q(id)}, ${q(action)})`);
      },
      async key(name) {
        const [key, keyCode] = KEYS[name];
        return evalApp(`return ac.shell.devKeyEquivalent(${q(windowId)}, { key: ${q(key)}, keyCode: ${keyCode}, modifiers: [], send: true, asKey: true, wait: 30 })`);
      },
      async rows() {
        const shown = await panel();
        if (!shown) return null;
        return parseRows(await act(shown.number, "ax:bold"));
      },
      async chromePopups() {
        const children = JSON.parse((await act(await windowNumber(), "children")) || "[]");
        return children.filter((c) => c.visible && c.class === "NativeWidgetMacNSWindow");
      },
      async waitRows(what = "the Login list", ms = 10_000) {
        return waitFor(what, async () => {
          const rows = await tab.rows();
          return rows?.length ? rows : null;
        }, ms);
      },
      async noList(ms = 1500) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const rows = await tab.rows();
          if (rows?.length) return rows;
          await sleep(150);
        }
        return null;
      },
      async pick(title) {
        const shown = await panel();
        const rows = shown ? parseRows(await act(shown.number, "ax:bold")) : [];
        const index = rows.findIndex((r) => r.title === title);
        if (index < 0) throw new Error(`no row ${q(title)} in ${q(rows)}`);
        const y = ROW.inset + rows.slice(0, index).reduce((sum, r) => sum + (r.notice ? ROW.notice : ROW.login), 0) + ROW.login / 2;
        return act(shown.number, `click:40,${y}`);
      },
      async close() {
        if (kind) return evalApp(`ac.store.getState().closeWindow(${q(windowId)}); return true`).catch(() => null);
        await evalApp(`ac.store.getState().closeTab(${q(id)}); return true`).catch(() => null);
      },
    };
    return tab;
  }

  return { open, useWebKit, engine: engineName };
}
