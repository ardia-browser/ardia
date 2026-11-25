import { DARK, PERSONAL, TITLES, hostOf, writeSession } from "./sessions-lib.mjs";

const TITLES_HERE = {
  ...TITLES,
  forum: "Threadly · The best sourdough starter?",
  trails: "Ridge Trail Map",
  ferry: "Ferry times — Harbor Line",
  eats: "Eats — Dinner near you",
  library: "City Library — Holds",
  hostel: "Hostel by the pier",
  groceries: "Groceries — This week",
  roadmap: "Roadmap — Q1",
  changelog: "Changelog",
  tunes: "Tunes — Weekend mix",
  chat: "Chat — Team",
};
const NOW = Date.now();
const T = (id, url, extra = {}) => ({ id, profileId: "default", url, lastActiveAt: NOW, createdAt: NOW, title: url ? TITLES_HERE[hostOf(url)] ?? hostOf(url) : "", ...extra });
const tile = (id, url, extra = {}) => T(id, url, { pinned: true, pinnedUrl: url, ...extra });
const FRAME = [80, 60, 1100, 720];
const SETTINGS_FRAME = [206, 196, 1100, 720];
const WIDE = [80, 60, 1180, 560];
const PINS = [tile("p1", "http://tunes.example/"), tile("p2", "http://chat.example/"), tile("p3", "http://trails.example/", { favicon: "http://trails.example/favicon.svg" })];
const TABS = [T("t1", "http://docpad.example/"), T("t2", "http://lexicon.example/"), T("t3", "http://crumbs.example/"), T("t4", "http://dailyledger.example/")];
const folder = (id, name, tabIds, extra = {}) => ({ id, windowId: "w1", profileId: "default", name, icon: null, color: null, collapsed: false, pinned: false, tabIds, createdAt: 1, ...extra });

function build(file, { tabs, groups, active, frame = FRAME, settings = {}, windowExtra = {} }) {
  writeSession(file, { profiles: [PERSONAL], tabs, groups, active, frame, windowExtra, settings: { ...DARK, ...settings } });
}

build("session-0247n8-topapps.json", { tabs: [...PINS, T("n1", "")], active: "n1", settings: { keepTopAppsRunning: true } });

build("session-0247n8-settings.json", { tabs: [...PINS, ...TABS], active: "t1", frame: SETTINGS_FRAME });

const TRIP = [T("g1", "http://ferry.example/", { groupId: "gtrip" }), T("g2", "http://hostel.example/", { groupId: "gtrip" }), T("g3", "http://eats.example/", { groupId: "gtrip" }), T("g4", "http://trails.example/", { groupId: "gtrip" }), T("g5", "http://library.example/", { groupId: "gtrip" })];
build("session-0247n8-strip.json", {
  tabs: [...TABS.slice(0, 3), ...TRIP, T("t5", "http://roadmap.example/"), T("t6", "http://changelog.example/")],
  groups: [folder("gtrip", "Trip", TRIP.map((t) => t.id), { color: "green" })],
  active: "t1",
  frame: WIDE,
  windowExtra: { tabLayout: "top" },
  settings: { tabLayout: "top" },
});

