import { DARK, PERSONAL, TITLES, WORK, hostOf, writeSession } from "./sessions-lib.mjs";

const TITLES_HERE = { ...TITLES, forum: "Threadly · The best sourdough starter?", trails: "Ridge Trail Map", ferry: "Ferry times — Harbor Line", eats: "Eats — Dinner near you", library: "City Library — Holds", hostel: "Hostel by the pier", groceries: "Groceries — This week", roadmap: "Roadmap — Q1", changelog: "Changelog" };
const T = (id, url, extra = {}) => ({ id, profileId: "default", url, title: url ? TITLES_HERE[hostOf(url)] ?? hostOf(url) : "", ...extra });
const tile = (id, url, extra = {}) => T(id, url, { pinned: true, pinnedUrl: url, ...extra });
const row = (id, url, extra = {}) => tile(id, url, { pinnedAsRow: true, ...extra });
const FRAME = [80, 60, 1100, 720];
const SETTINGS_FRAME = [206, 196, 1100, 720];
const LITTLE_FRAME = [80, 60, 1200, 820];
const PINS = [tile("p1", "http://moodwall.example/"), tile("p2", "http://trails.example/", { favicon: "http://trails.example/favicon.svg" }), tile("p3", "http://forum.example/"), row("r1", "http://docpad.example/", { url: "http://docpad.example/packing", title: "Packing list — Docpad" })];
const TABS = [T("t1", "http://docpad.example/"), T("t2", "http://lexicon.example/"), T("t3", "http://crumbs.example/"), T("t4", "http://dailyledger.example/")];
const IN_FOLDERS = [T("f1", "http://ferry.example/", { groupId: "gtrip" }), T("f2", "http://hostel.example/", { groupId: "gtrip" }), T("f3", "http://eats.example/", { groupId: "gfood" }), T("f4", "http://groceries.example/", { groupId: "gfood" })];
const folder = (id, name, tabIds, extra = {}) => ({ id, windowId: "w1", profileId: "default", name, icon: null, color: null, collapsed: true, pinned: false, tabIds, createdAt: 1, ...extra });
const GROUPS = [folder("gtrip", "Trip", ["f1", "f2"]), folder("gfood", "Food", ["f3", "f4"], { color: "green" })];

function build(file, { profiles = [PERSONAL], tabs, groups, active, frame = FRAME, settings = {}, extra = {} }) {
  writeSession(file, { profiles, tabs, groups, active, frame, settings: { ...DARK, ...settings }, extra });
}

build("session-0247n7-press.json", { tabs: [...PINS, ...TABS, ...IN_FOLDERS], groups: GROUPS, active: "t1" });

build("session-0247n7-settings.json", { tabs: [...PINS, ...TABS], active: "t1", frame: SETTINGS_FRAME });

build("session-0247n7-little.json", { profiles: [PERSONAL, WORK], tabs: [...PINS, ...TABS], active: "t1", frame: LITTLE_FRAME, settings: { showProfileDots: false } });
