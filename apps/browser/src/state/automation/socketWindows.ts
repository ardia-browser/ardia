import type { BrowserState } from "../browser/store";
import { activeTabId, sidebarSideOf, tabLayoutOf, tabsShownIn } from "../browser/model";
import { openInMainWindow, openLittleArdia } from "../littleArdia/actions";
import { focusWindow } from "../windows/nativeWindow";
import { focusedWindowOf } from "../windows/ui";
import { eligibleKind, windowTabIds, type AutomationWindowKind } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { closeWindowAsked } from "../windows/windowClose";
import { askWhereSeen } from "./socketAsk";
import { bool, obj, oneOf, PROFILE, text, WINDOW } from "./socketSchema";
import { expect, now, profileArg, windowOf } from "./socketTargets";
import { openableUrl } from "./workspaceOps";
import { OpError } from "./workspaceTargets";

export function windowRow(s: BrowserState, id: string) {
  const w = s.windows[id]!;
  return {
    id,
    kind: eligibleKind(s, id),
    profile: w.profileId,
    profileName: s.profiles[w.profileId]?.name ?? "",
    focused: focusedWindowOf(s) === id,
    activeTab: activeTabId(s, id) ?? null,
    tabs: windowTabIds(s, id).length,
    layout: tabLayoutOf(s, id),
    sidebarSide: sidebarSideOf(s, id),
    tabsShown: tabsShownIn(s, id),
    frame: w.frame,
    maximized: !!w.maximized,
    fullScreen: !!w.fullScreen,
    createdAt: w.createdAt,
  };
}

function url(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const given = openableUrl(value as string);
  if (typeof given !== "string") throw new OpError("refused", given.error);
  return given || undefined;
}

function createWindow(params: Record<string, unknown>) {
  const profileId = profileArg(params.profile);
  const id = now().createWindow({ profileId, url: url(params.url) });
  expect(!!id && !!now().windows[id], "the window didn't open.");
  if (params.layout !== undefined && tabLayoutOf(now(), id) !== params.layout) now().toggleTabLayout(id);
  return windowRow(now(), id);
}

function setLayout(params: Record<string, unknown>) {
  const w = windowOf(params.window, ["normal"]);
  if (params.layout === undefined && params.tabsShown === undefined) throw new OpError("bad_request", "windows.setLayout needs layout or tabsShown.");
  if (params.layout !== undefined && tabLayoutOf(now(), w.id) !== params.layout) now().toggleTabLayout(w.id);
  if (params.tabsShown !== undefined && tabsShownIn(now(), w.id) !== params.tabsShown) now().toggleSidebar(w.id);
  const row = windowRow(now(), w.id);
  expect((params.layout === undefined || row.layout === params.layout) && (params.tabsShown === undefined || row.tabsShown === params.tabsShown), "the layout didn't change.");
  return row;
}

function switchProfile(params: Record<string, unknown>) {
  const w = windowOf(params.window, ["normal"]);
  const profileId = profileArg(params.profile);
  now().switchProfile(w.id, profileId);
  expect(now().windows[w.id]?.profileId === profileId, `window ${w.id} didn't switch to ${profileId}.`);
  return windowRow(now(), w.id);
}

async function closeWindow(params: Record<string, unknown>, call: SocketCall, kinds: readonly AutomationWindowKind[] = ["normal", "little"]) {
  const w = windowOf(params.window, kinds);
  const outcome = await closeWindowAsked(w.id, { mayClose: call.serving, ask: askWhereSeen(`Window ${w.id} stayed open`, call) });
  if (outcome === "busy") throw new OpError("refused", `Window ${w.id} is already closing or asking whether to close.`);
  if (outcome === "cancelled") throw new OpError("refused", `Window ${w.id} stayed open: closing it was cancelled.`);
  if (outcome === "stopped") call.stillServing();
  return { ok: true };
}

function openLittle(params: Record<string, unknown>) {
  const profileId = params.profile !== undefined ? profileArg(params.profile) : undefined;
  const id = openLittleArdia(url(params.url), profileId);
  expect(!!id && eligibleKind(now(), id) === "little", "Little Ardia didn't open.");
  return windowRow(now(), id);
}

function littleToMain(params: Record<string, unknown>) {
  const w = windowOf(params.window, ["little"]);
  const tab = activeTabId(now(), w.id);
  openInMainWindow(w.id);
  const moved = tab ? now().tabs[tab] : undefined;
  return { tab: moved ? tab : null, window: moved?.windowId ?? null };
}

export const WINDOW_METHODS: MethodSpec[] = [
  { name: "windows.get", mutates: false, description: "One window: kind, profile, layout, frame, focus and its active tab", params: obj({ window: WINDOW }, ["window"]), result: "window", run: (p) => windowRow(now(), windowOf(p.window).id) },
  {
    name: "windows.create",
    mutates: true,
    description: "Open a new window",
    params: obj({ profile: PROFILE, url: text("The first tab's URL; a New Tab when left out"), layout: oneOf(["sidebar", "top"], "Tabs in a sidebar or along the top") }),
    result: "window",
    run: createWindow,
  },
  {
    name: "windows.close",
    mutates: true,
    description: "Close a window as its close button does: Ardia asks first when the user set it to (refused when nobody can see the question), and the last window is kept to reopen (its tabs go to recently closed)",
    params: obj({ window: WINDOW }, ["window"]),
    result: "{ok}",
    run: closeWindow,
  },
  {
    name: "windows.focus",
    mutates: true,
    description: "Bring a window to the front and make it key",
    params: obj({ window: WINDOW }, ["window"]),
    result: "{ok}",
    run: (p) => {
      const w = windowOf(p.window);
      focusWindow(w.id);
      return { ok: true };
    },
  },
  {
    name: "windows.setLayout",
    mutates: true,
    description: "Put a window's tabs in the sidebar or along the top, and show or hide them",
    params: obj({ window: WINDOW, layout: oneOf(["sidebar", "top"], "Tabs in a sidebar or along the top"), tabsShown: bool("false hides the tabs until the pointer reaches the edge") }, ["window"]),
    result: "window",
    run: setLayout,
  },
  { name: "windows.switchProfile", mutates: true, description: "Show another profile (space) in a window", params: obj({ window: WINDOW, profile: PROFILE }, ["window", "profile"]), result: "window", run: switchProfile },
  {
    name: "windows.merge",
    mutates: true,
    description: "Move every other window's tabs into this one",
    params: obj({ window: WINDOW }, ["window"]),
    result: "window",
    run: (p) => {
      const w = windowOf(p.window, ["normal"]);
      now().mergeAllWindows(w.id);
      return windowRow(now(), w.id);
    },
  },
  { name: "littleArdia.open", mutates: true, description: "Open a Little Ardia window", params: obj({ url: text("Its page; a New Tab when left out"), profile: PROFILE }), result: "window", run: openLittle },
  { name: "littleArdia.close", mutates: true, description: "Close a Little Ardia window; the reply comes once it's closed", params: obj({ window: WINDOW }, ["window"]), result: "{ok}", run: (p, call) => closeWindow(p, call, ["little"]) },
  { name: "littleArdia.toMain", mutates: true, description: "Move a Little Ardia's page into a main window as a tab", params: obj({ window: WINDOW }, ["window"]), result: "{tab, window}", run: littleToMain },
];
