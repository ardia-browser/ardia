import { isSharing, onConsentPeriodChange, type ConsentToken } from "./choice";
import { consentOrNow, countFor } from "./countFor";

let inWebKit = 0;

export function noteTabSwitcherOpenedInWebKit() {
  inWebKit++;
}

export function takeTabSwitcherOpensInWebKit(): number {
  const taken = inWebKit;
  inWebKit = 0;
  return taken;
}

let rowCloses = 0;

export function noteTabSwitcherRowClosed(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void rowCloses++);
}

export function takeTabSwitcherRowCloses(): number {
  const taken = rowCloses;
  rowCloses = 0;
  return taken;
}

let menuReleases = 0;

onConsentPeriodChange(() => (menuReleases = 0));

export function noteTabSwitcherReleasedInMenu() {
  if (isSharing()) menuReleases++;
}

export function takeTabSwitcherMenuReleases(): number {
  const taken = menuReleases;
  menuReleases = 0;
  return taken;
}

const scrollCounts = { overflowOpens: 0, overflowClicks: 0, wheelScrolls: 0, picturesLate: 0 };

export function noteTabSwitcherOverflowOpened() {
  scrollCounts.overflowOpens++;
}

export function noteTabSwitcherOverflowClick() {
  scrollCounts.overflowClicks++;
}

export function noteTabSwitcherWheelScrolled() {
  scrollCounts.wheelScrolls++;
}

export function noteTabSwitcherPictureLate() {
  scrollCounts.picturesLate++;
}

export function takeTabSwitcherScrollCounts() {
  const taken = {
    tab_switcher_overflow_opens: scrollCounts.overflowOpens,
    tab_switcher_overflow_clicks: scrollCounts.overflowClicks,
    tab_switcher_wheel_scrolls: scrollCounts.wheelScrolls,
    tab_switcher_pictures_late: scrollCounts.picturesLate,
  };
  scrollCounts.overflowOpens = scrollCounts.overflowClicks = scrollCounts.wheelScrolls = scrollCounts.picturesLate = 0;
  return taken;
}

const modeCounts = { recent: 0, inOrder: 0, thumbnails: 0, compactList: 0, none: 0, shownThumbnails: 0, shownCompactList: 0, quickSwitches: 0 };

type Order = "recent" | "inOrder";
type View = "thumbnails" | "compactList" | "none";

export function noteTabSwitcherMode(order: Order, view: View, consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void (modeCounts[order]++, modeCounts[view]++));
}

export function noteTabSwitcherShown(view: View, consent?: ConsentToken | null) {
  if (view === "none") return;
  countFor(consentOrNow(consent), () => void modeCounts[view === "thumbnails" ? "shownThumbnails" : "shownCompactList"]++);
}

export function noteTabSwitcherQuickSwitch(consent?: ConsentToken | null) {
  countFor(consentOrNow(consent), () => void modeCounts.quickSwitches++);
}

export function takeTabSwitcherModeCounts() {
  const taken = {
    tab_switcher_uses_recent: modeCounts.recent,
    tab_switcher_uses_in_order: modeCounts.inOrder,
    tab_switcher_uses_thumbnails: modeCounts.thumbnails,
    tab_switcher_uses_compact_list: modeCounts.compactList,
    tab_switcher_uses_no_view: modeCounts.none,
    tab_switcher_shown_thumbnails: modeCounts.shownThumbnails,
    tab_switcher_shown_compact_list: modeCounts.shownCompactList,
    tab_switcher_quick_switches: modeCounts.quickSwitches,
  };
  for (const key of Object.keys(modeCounts) as (keyof typeof modeCounts)[]) modeCounts[key] = 0;
  return taken;
}
