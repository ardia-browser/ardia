import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DARK, PERSONAL, sites, writeSession } from "./sessions-lib.mjs";

const FRAME = [60, 60, 1280, 800];
const PAGES = ["", "notes", "archive", "week-2", "drafts"];

const SITES = readdirSync(sites)
  .filter((host) => host.endsWith(".example") && existsSync(join(sites, host, "index.html")))
  .sort()
  .map((host) => {
    const title = /<title>([^<]*)<\/title>/.exec(readFileSync(join(sites, host, "index.html"), "utf8"))?.[1] ?? host;
    const icon = ["favicon.ico", "favicon.svg", "favicon.png"].find((f) => existsSync(join(sites, host, f)));
    return { host, title: title.replace(/&amp;/g, "&"), icon };
  });

function tabsFor(n, prefix = "t") {
  return Array.from({ length: n }, (_, i) => {
    const site = SITES[(i * 7) % SITES.length];
    const round = Math.floor(i / SITES.length);
    const page = PAGES[round % PAGES.length];
    const base = `http://${site.host}/`;
    return {
      id: `${prefix}${i + 1}`,
      profileId: "default",
      url: `${base}${page}`,
      title: page ? `${site.title} · ${page.replace("-", " ")}` : site.title,
      favicon: site.icon ? `${base}${site.icon}` : null,
      lastActiveAt: i + 2,
    };
  });
}

const TILE_HOSTS = ["moodwall.example", "docpad.example", "tunes.example", "chat.example"];
const tiles = TILE_HOSTS.map((host, i) => {
  const site = SITES.find((s) => s.host === host);
  const url = `http://${host}/`;
  return { id: `p${i + 1}`, profileId: "default", url, pinnedUrl: url, pinned: true, title: site.title, favicon: site.icon ? `${url}${site.icon}` : null, lastActiveAt: 1 };
});

const group = (id, name, color, tabIds) => ({ id, windowId: "w1", profileId: "default", name, icon: null, color, collapsed: false, pinned: false, tabIds, createdAt: 1 });

function build(file, { count, tabLayout, groups = [] }) {
  const tabs = [...tiles, ...tabsFor(count)];
  writeSession(file, {
    profiles: [PERSONAL],
    tabs,
    groups,
    active: "t1",
    frame: FRAME,
    windowExtra: { tabLayout },
    settings: { ...DARK, tabLayout, revealTabsOnHover: false },
  });
}

build("session-scroll-perf-strip.json", {
  count: 60,
  tabLayout: "top",
  groups: [group("g1", "Trip", "blue", ["t4", "t5", "t6"]), group("g2", "Research", "green", ["t18", "t19", "t20", "t21"])],
});
build("session-scroll-perf-swipe.json", { count: 60, tabLayout: "sidebar" });
build("session-scroll-perf-sidebar.json", { count: 200, tabLayout: "sidebar" });
