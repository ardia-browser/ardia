import { DARK, PERSONAL, TITLES, hostOf, writeSession } from "./sessions-lib.mjs";

const TITLES_HERE = { ...TITLES, forum: "Threadly · The best sourdough starter?", trails: "Ridge Trail Map", ferry: "Ferry times — Harbor Line", eats: "Eats — Dinner near you", library: "City Library — Holds", hostel: "Hostel by the pier", groceries: "Groceries — This week", tunes: "Tunes — Road trip mix", roadmap: "Roadmap — Q1", changelog: "Changelog", fieldnotes: "Field notes — Day 3", canopy: "Canopy — Tree walks", cinema: "Cinema — Tonight", course: "Course — Week 4", survey: "Survey — Trail users" };
const T = (id, url, extra = {}) => ({ id, profileId: "default", url, title: url ? TITLES_HERE[hostOf(url)] ?? hostOf(url) : "", ...extra });
const tile = (id, url, extra = {}) => T(id, url, { pinned: true, pinnedUrl: url, ...extra });
const row = (id, url, extra = {}) => tile(id, url, { pinnedAsRow: true, ...extra });
const FRAME = [80, 60, 1100, 720];
const SETTINGS_FRAME = [206, 196, 1100, 720];
const TABS = [T("t1", "http://docpad.example/"), T("t2", "http://lexicon.example/"), T("t3", "http://crumbs.example/"), T("t4", "http://dailyledger.example/"), T("t5", "http://forum.example/")];
const PINS = [tile("p1", "http://moodwall.example/"), tile("p2", "http://trails.example/", { favicon: "http://trails.example/favicon.svg" }), row("r1", "http://docpad.example/", { url: "http://docpad.example/packing", title: "Packing list — Docpad" })];
const NOW = Date.now();
const MORE = ["ferry", "eats", "library", "hostel", "groceries", "tunes", "roadmap", "changelog", "fieldnotes", "canopy", "cinema", "course", "survey", "moodwall", "trails", "docpad", "lexicon", "crumbs", "dailyledger"].map((host, i) => T(`m${i + 1}`, `http://${host}.example/`, { lastActiveAt: NOW }));

function build(file, { tabs, active, frame = FRAME, settings = {}, extra = {} }) {
  writeSession(file, { profiles: [PERSONAL], tabs, active, frame, settings: { ...DARK, ...settings }, extra });
}

build("session-0247n6-tabs.json", { tabs: [...PINS, ...TABS], active: "t1" });

build("session-0247n6-settings.json", { tabs: [...PINS, ...TABS], active: "t1", frame: SETTINGS_FRAME });

build("session-0247n6-many.json", { tabs: [...TABS.map((t) => ({ ...t, lastActiveAt: NOW })), ...MORE], active: "t2" });

build("session-0247n6-sleep.json", { tabs: [...PINS, ...TABS], active: "t1", settings: { strikeSleepingTabs: true } });
