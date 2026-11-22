import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import type { HistoryEntry } from "../browser/types";
import { hostOf } from "@ardia/core";
import { t } from "../../lib/uiLanguage";


type PinnableSite = { id: string; title: string; url: string };

export const PINNABLE_SITES: PinnableSite[] = [
  { id: "gmail", title: t(`Gmail`), url: "https://mail.google.com/" },
  { id: "calendar", title: t(`Calendar`), url: "https://calendar.google.com/" },
  { id: "slack", title: t(`Slack`), url: "https://app.slack.com/" },
  { id: "notion", title: t(`Notion`), url: "https://www.notion.so/" },
  { id: "figma", title: t(`Figma`), url: "https://www.figma.com/" },
  { id: "github", title: t(`GitHub`), url: "https://github.com/" },
  { id: "linear", title: t(`Linear`), url: "https://linear.app/" },
  { id: "docs", title: t(`Docs`), url: "https://docs.google.com/" },
  { id: "drive", title: t(`Drive`), url: "https://drive.google.com/" },
  { id: "outlook", title: t(`Outlook`), url: "https://outlook.office.com/mail/" },
  { id: "youtube", title: t(`YouTube`), url: "https://www.youtube.com/" },
  { id: "spotify", title: t(`Spotify`), url: "https://open.spotify.com/" },
];

export function pinnedHosts(windowId: string): Set<string> {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w) return new Set();
  const inPinnedGroup = new Set(Object.values(s.groups).filter((g) => g.pinned && g.profileId === w.profileId).flatMap((g) => g.tabIds));
  const pinned = Object.values(s.tabs).filter((t) => t.profileId === w.profileId && (t.pin || inPinnedGroup.has(t.id)));
  const parked = s.parkedPins[w.profileId]?.tabs ?? [];
  return new Set([...pinned, ...parked].map((t) => hostOf(t.pinnedUrl || t.url)).filter(Boolean));
}

export function preselectedSites(history: HistoryEntry[], alreadyPinned: Set<string> = new Set()): string[] {
  const visits = new Map<string, number>();
  for (const entry of history) {
    const host = hostOf(entry.url);
    if (host) visits.set(host, (visits.get(host) ?? 0) + entry.visits);
  }
  return PINNABLE_SITES.filter((site) => !alreadyPinned.has(hostOf(site.url)))
    .map((site) => ({ id: site.id, visits: visits.get(hostOf(site.url)) ?? 0 }))
    .filter((s) => s.visits >= 3)
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 4)
    .map((s) => s.id);
}

export function pinSites(windowId: string, ids: string[]) {
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  if (!w) return;
  const pinned = pinnedHosts(windowId);
  const selectedTab = activeTabId(s, w.id);
  for (const site of PINNABLE_SITES) {
    if (ids.includes(site.id) && !pinned.has(hostOf(site.url))) {
      useBrowser.getState().newTab(w.id, { url: site.url, pinned: true, background: true, snapshot: { title: site.title } });
    }
  }
  if (selectedTab) useBrowser.getState().activate(selectedTab);
}
