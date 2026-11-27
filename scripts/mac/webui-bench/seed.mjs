#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const HELP = `The seeded sessions both sides of the shootout load, in the Mac app's current on-disk format (version 11).

  node scripts/mac/webui-bench/seed.mjs [large|small|multi] [--origin http://127.0.0.1:9600] [--table]

large: 3 profiles with 150, 15 and 5 tabs in one 1360x820 window, Personal's selected tab 130 rows down.
small: the same 3 profiles with one tab each.
multi: large plus a second window of 8 Work tabs, for the multi-window and peek footprint.
--table prints the desktop table format instead. The session is validated before it prints; a bad one exits 1.`;

export const PROFILES = [
  { name: "Personal", id: "default", tabs: 150, selected: 130 },
  { name: "Work", id: "work", tabs: 15, selected: 12 },
  { name: "Play", id: "play", tabs: 5, selected: 2 },
];
export const WINDOW_FRAME = [60, 60, 1360, 820];
export const SECOND_WINDOW_FRAME = [140, 120, 1100, 760];
export const SECOND_WINDOW_TABS = 8;
export const DEFAULT_ORIGIN = "http://127.0.0.1:9600";
export const SESSION_VERSION = 11;
export const COLORS = ["plum", "blue", "green"];
export const SIDEBAR_WIDTH = 260;
export const SETTINGS = { sidebarWidth: SIDEBAR_WIDTH, searchSuggestions: false, warnBeforeClosingLastTab: false, warnBeforeClosingWindow: false, restoreSession: true };

const tabsOf = (origin, profile, count, windowId = "main", prefix = "t") =>
  Array.from({ length: count }, (_, n) => ({
    id: `${profile.id}-${prefix}${n}`,
    windowId,
    profileId: profile.id,
    url: `${origin}/${profile.id}/${prefix}${n}`,
    title: `${profile.name} ${prefix === "t" ? "tab" : "window tab"} ${n + 1}`,
    favicon: null,
    pinned: false,
    muted: false,
    zoom: 1,
    customTitle: null,
    customIcon: null,
    pinnedUrl: null,
    openerId: null,
    createdAt: 1,
    lastActiveAt: n + 1,
    page: { kind: "idle" },
    pin: null,
  }));

function build(origin, counts, extraWindow = false) {
  const tabs = PROFILES.flatMap((p) => tabsOf(origin, p, counts(p)));
  const windows = [{ id: "main", frame: WINDOW_FRAME, sidebarOpen: true, profileId: PROFILES[0].id }];
  const work = PROFILES[1];
  if (extraWindow) {
    windows.push({ id: "second", frame: SECOND_WINDOW_FRAME, sidebarOpen: true, profileId: work.id });
    tabs.push(...tabsOf(origin, work, SECOND_WINDOW_TABS, "second", "w"));
  }
  const s = {
    version: SESSION_VERSION,
    profiles: Object.fromEntries(PROFILES.map(({ name, id }, i) => [id, { id, name, color: COLORS[i], icon: null, createdAt: i }])),
    profileOrder: PROFILES.map((p) => p.id),
    windows: windows.map((w, i) => ({ incognito: false, createdAt: i + 1, ...w })),
    windowOrder: windows.map((w) => w.id),
    focusedWindowId: windows[0].id,
    tabs,
    groups: [],
    splits: [],
    closedTabs: [],
    closedWindows: [],
    closedGroups: [],
    cleanedTabs: [],
    settingsMeta: { chosen: [], inferred: [] },
  };
  const selectedIn = (p) => Math.min(p.selected, counts(p) - 1);
  s.windows[0].tabIds = tabs.filter((t) => t.windowId === "main").map((t) => t.id);
  s.windows[0].activeTabIds = Object.fromEntries(PROFILES.map((p) => [p.id, `${p.id}-t${selectedIn(p)}`]));
  if (extraWindow) {
    s.windows[1].tabIds = tabs.filter((t) => t.windowId === "second").map((t) => t.id);
    s.windows[1].activeTabIds = { [work.id]: `${work.id}-w${SECOND_WINDOW_TABS - 1}` };
  }
  s.settings = { ...SETTINGS };
  return s;
}

export const benchSession = (origin = DEFAULT_ORIGIN) => build(origin, (p) => p.tabs);
export const smallSession = (origin = DEFAULT_ORIGIN) => build(origin, () => 1);
export const multiSession = (origin = DEFAULT_ORIGIN) => build(origin, (p) => p.tabs, true);
export const SESSIONS = { large: benchSession, small: smallSession, multi: multiSession };

export function selectedUrl(s, windowIndex = 0) {
  const w = s.windows[windowIndex];
  const tab = s.tabs.find((t) => t.id === w.activeTabIds[w.profileId]);
  return tab?.url ?? null;
}

export function tableSession(s) {
  return {
    ...s,
    windows: Object.fromEntries(s.windows.map((w) => [w.id, { ...w, kind: "main" }])),
    tabs: Object.fromEntries(s.tabs.map((t) => [t.id, { ...t, pin: null, page: { kind: "idle" } }])),
    groups: {},
    splits: {},
  };
}

export function expectedFixture(s) {
  return { profiles: s.profileOrder.length, tabs: s.tabs.length, windows: s.windows.length };
}

export function validateSession(s) {
  const problems = [];
  if (s.version !== SESSION_VERSION) problems.push(`version is ${s.version}, not ${SESSION_VERSION}`);
  for (const t of s.tabs ?? []) if (t.page?.kind !== "idle" || !("pin" in t)) problems.push(`tab ${t.id} lacks the version ${SESSION_VERSION} page and pin fields`);
  if (!s.settingsMeta) problems.push("settingsMeta is missing");
  const profileIds = new Set(s.profileOrder ?? []);
  for (const id of profileIds) if (!s.profiles?.[id]) problems.push(`profile ${id} is ordered but missing`);
  const tabs = new Map();
  for (const t of s.tabs ?? []) {
    if (tabs.has(t.id)) problems.push(`tab id ${t.id} repeats`);
    tabs.set(t.id, t);
    if (!profileIds.has(t.profileId)) problems.push(`tab ${t.id} has unknown profile ${t.profileId}`);
    if (!/^https?:\/\//.test(t.url)) problems.push(`tab ${t.id} has no http url`);
  }
  const windowIds = new Set((s.windows ?? []).map((w) => w.id));
  if (JSON.stringify(s.windowOrder) !== JSON.stringify([...windowIds])) problems.push("windowOrder does not list the windows in order");
  if (!windowIds.has(s.focusedWindowId)) problems.push("focusedWindowId is not a window");
  const placed = new Set();
  for (const w of s.windows ?? []) {
    if (!profileIds.has(w.profileId)) problems.push(`window ${w.id} has unknown profile ${w.profileId}`);
    if (!Array.isArray(w.frame) || w.frame.length !== 4 || w.frame.some((v) => typeof v !== "number")) problems.push(`window ${w.id} has a bad frame`);
    for (const id of w.tabIds ?? []) {
      if (!tabs.has(id)) problems.push(`window ${w.id} lists missing tab ${id}`);
      else if (tabs.get(id).windowId !== w.id) problems.push(`tab ${id} is listed in ${w.id} but belongs to ${tabs.get(id).windowId}`);
      if (placed.has(id)) problems.push(`tab ${id} is listed twice`);
      placed.add(id);
    }
    for (const [profile, id] of Object.entries(w.activeTabIds ?? {})) {
      const tab = tabs.get(id);
      if (!tab) problems.push(`window ${w.id} selects missing tab ${id}`);
      else if (tab.profileId !== profile) problems.push(`window ${w.id} selects ${id} for ${profile}, but it is ${tab.profileId}'s`);
      else if (!(w.tabIds ?? []).includes(id)) problems.push(`window ${w.id} selects ${id}, which it does not list`);
    }
    if (!w.activeTabIds?.[w.profileId]) problems.push(`window ${w.id} has no selected tab for its profile`);
  }
  for (const id of tabs.keys()) if (!placed.has(id)) problems.push(`tab ${id} is in no window`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }
  const kind = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--origin") ?? "large";
  if (!SESSIONS[kind]) {
    console.error(`unknown session ${kind}; one of ${Object.keys(SESSIONS).join(", ")}`);
    process.exit(64);
  }
  const origin = argv.includes("--origin") ? argv[argv.indexOf("--origin") + 1] : DEFAULT_ORIGIN;
  const s = SESSIONS[kind](origin);
  const problems = validateSession(s);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(JSON.stringify(argv.includes("--table") ? tableSession(s) : s));
}
