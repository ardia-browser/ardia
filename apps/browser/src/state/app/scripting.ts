import { onScriptCommand, replyToScript, setScriptState, type ScriptCommand, type ScriptState } from "../../platform/scripting";
import { useBrowser, type BrowserState } from "../browser/store";
import { activeTabId, resolveWindowId, viewTabIds, windowTitle } from "../browser/model";
import { openWindow, switchProfile, switchToTab } from "../browser/actions";
import { JAVASCRIPT_FROM_APPLE_EVENTS_REFUSED, runsJavaScript } from "../settings/scriptUrls";
import { webviews } from "../../platform/webviews";
import { errorText } from "../../lib/errors";
import { changedIds } from "../browser/changes";

const STRUCTURE_DELAY_MS = 100;
const TITLE_DELAY_MS = 1000;
const SCRIPTS_RUNNING_MS = 30_000;

type Scripted = Pick<BrowserState, "tabs" | "windows" | "windowOrder" | "live" | "profiles" | "profileOrder">;

export function scriptChange(s: Scripted, prev: Scripted): "structure" | "titles" | null {
  if (s.windows !== prev.windows || s.windowOrder !== prev.windowOrder || s.profiles !== prev.profiles || s.profileOrder !== prev.profileOrder) return "structure";
  let titles = false;
  for (const id of changedIds(s.tabs, prev.tabs)) {
    const a = s.tabs[id];
    const b = prev.tabs[id];
    if (!a || !b || a.url !== b.url || !a.pin !== !b.pin || a.customTitle !== b.customTitle || a.profileId !== b.profileId || a.windowId !== b.windowId) return "structure";
    if (a.title !== b.title) titles = true;
  }
  for (const id of changedIds(s.live, prev.live)) if (!s.live[id]?.isLoading !== !prev.live[id]?.isLoading) return "structure";
  return titles ? "titles" : null;
}

export function scriptState(s: BrowserState): ScriptState {
  return {
    windows: s.windowOrder.map((id) => {
      const w = s.windows[id]!;
      return {
        id,
        title: windowTitle(s, id),
        profileId: w.profileId,
        incognito: w.kind === "private",
        activeTabId: activeTabId(s, id) ?? null,
        tabs: viewTabIds(s, id).map((tabId) => {
          const t = s.tabs[tabId]!;
          return {
            id: tabId,
            title: t.customTitle || t.title,
            url: t.url,
            loading: !!s.live[tabId]?.isLoading,
            pinned: !!t.pin };
        }) };
    }),
    profiles: s.profileOrder.map((id) => ({ id, name: s.profiles[id]!.name })) };
}

export function scriptStatePublisher(read: () => ScriptState, publish: (state: ScriptState) => Promise<unknown>): () => Promise<void> {
  let lastJson = "";
  let arriving: Promise<void> = Promise.resolve();
  return () => {
    const state = read();
    const json = JSON.stringify(state);
    if (json === lastJson) return arriving;
    lastJson = json;
    const sent = new Promise<unknown>((resolve) => resolve(publish(state))).then(
      () => {},
      () => {
        if (lastJson === json) lastJson = "";
      },
    );
    arriving = sent;
    return sent;
  };
}

export function startScripting() {
  const push = scriptStatePublisher(() => scriptState(useBrowser.getState()), setScriptState);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = Infinity;
  let scriptedAt = -Infinity;
  const pushWithin = (ms: number) => {
    const at = Date.now() + ms;
    if (at >= dueAt) return;
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(() => {
      timer = undefined;
      dueAt = Infinity;
      void push();
    }, ms);
  };
  useBrowser.subscribe((s, prev) => {
    const change = scriptChange(s, prev);
    if (change) pushWithin(change === "structure" || Date.now() - scriptedAt < SCRIPTS_RUNNING_MS ? STRUCTURE_DELAY_MS : TITLE_DELAY_MS);
  });
  void push();

  onScriptCommand((request) => {
    scriptedAt = Date.now();
    if (request.command === "reading") return void push();
    let result: Record<string, unknown> | null = null;
    Promise.resolve()
      .then(async () => {
        result = (await runScriptCommand(request)) ?? {};
      })
      .then(
        () => push().then(() => replyToScript(request.id, result)),
        (error: unknown) => push().then(() => replyToScript(request.id, null, errorText(error))),
      );
  });
}

async function runScriptCommand(request: Exclude<ScriptCommand, { command: "reading" }>): Promise<Record<string, unknown> | void> {
  const s = useBrowser.getState();
  const tabOf = (tabId: string) => {
    const tab = s.tabs[tabId];
    if (!tab) throw new Error("That tab no longer exists.");
    return tab;
  };
  const loaded = (tabId: string) => {
    const web = webviews.get(tabId);
    if (!web) throw new Error("The tab hasn't loaded yet; focus it first.");
    return web;
  };
  const scriptJavaScriptAllowed = s.settings.allowJavaScriptFromAppleEvents;
  const refusesUrl = (url: string | undefined) => !!url && !scriptJavaScriptAllowed && runsJavaScript(url, s.settings);
  switch (request.command) {
    case "newWindow": {
      if (refusesUrl(request.url)) return JAVASCRIPT_FROM_APPLE_EVENTS_REFUSED;
      const windowId = openWindow({ url: request.url, kind: request.incognito ? "private" : "main", profileId: request.profileId });
      return { windowId };
    }
    case "newTab": {
      if (refusesUrl(request.url)) return JAVASCRIPT_FROM_APPLE_EVENTS_REFUSED;
      const windowId = resolveWindowId(s, request.windowId);
      if (!windowId) {
        const created = openWindow({ url: request.url });
        return { windowId: created, tabId: activeTabId(useBrowser.getState(), created) };
      }
      const view = viewTabIds(s, windowId);
      const w = s.windows[windowId]!;
      let index: number | undefined;
      if (request.index !== undefined) {
        const pinned = view.filter((id) => s.tabs[id]!.pin).length;
        const at = Math.max(request.index, pinned);
        index = at < view.length ? w.tabIds.indexOf(view[at]!) : w.tabIds.length;
      }
      const tabId = s.newTab(windowId, { url: request.url, index });
      return { windowId, tabId };
    }
    case "setURL":
      tabOf(request.tabId);
      if (refusesUrl(request.url)) return JAVASCRIPT_FROM_APPLE_EVENTS_REFUSED;
      return s.navigate(request.tabId, request.url);
    case "closeTab":
      tabOf(request.tabId);
      return s.closeTab(request.tabId);
    case "closeWindow":
      if (!s.windows[request.windowId]) throw new Error("That window no longer exists.");
      return s.closeWindow(request.windowId);
    case "reload": {
      const tab = tabOf(request.tabId);
      const web = webviews.get(request.tabId);
      if (web) return void (await web.reload());
      if (tab.url) s.navigate(tab.id, tab.url);
      return;
    }
    case "back":
      tabOf(request.tabId);
      return void (await loaded(request.tabId).goBack());
    case "forward":
      tabOf(request.tabId);
      return void (await loaded(request.tabId).goForward());
    case "focusTab":
      tabOf(request.tabId);
      return switchToTab(request.tabId);
    case "setActiveTabIndex": {
      if (!s.windows[request.windowId]) throw new Error("That window no longer exists.");
      if (request.index < 1 || request.index > viewTabIds(s, request.windowId).length) throw new Error("There's no tab at that index.");
      return s.activateIndex(request.windowId, request.index - 1);
    }
    case "focusProfile": {
      const windowId = resolveWindowId(s, null);
      if (!s.profiles[request.profileId]) throw new Error("That profile no longer exists.");
      if (!windowId || s.windows[windowId]!.kind === "private") throw new Error("There's no window to show the profile in.");
      return switchProfile(windowId, request.profileId);
    }
    case "execute": {
      tabOf(request.tabId);
      if (!scriptJavaScriptAllowed) return JAVASCRIPT_FROM_APPLE_EVENTS_REFUSED;
      const outcome = await loaded(request.tabId).evaluate<{ value?: string; error?: string }>(executeWrapper(request.code));
      if (!outcome) throw new Error("The page didn't answer.");
      if (outcome.error) throw new Error(outcome.error);
      return { value: outcome.value ?? "" };
    }
  }
}

function executeWrapper(code: string) {
  return `
const text = (v) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try { const json = JSON.stringify(v); return json === undefined ? String(v) : json; } catch { return String(v); }
};
let value;
try { value = (0, eval)(${JSON.stringify(code)}); } catch (e) { post("result", JSON.stringify({ error: String(e) })); return; }
Promise.resolve(value).then(
  (v) => post("result", JSON.stringify({ value: text(v) })),
  (e) => post("result", JSON.stringify({ error: String(e) })),
);`;
}
