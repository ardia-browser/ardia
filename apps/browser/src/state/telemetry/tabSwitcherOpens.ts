import { isSharing, onConsentPeriodChange, type ConsentToken } from "./choice";
import { countFor } from "./countFor";

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
  countFor(consent, () => void rowCloses++, { tab_switcher_row_closes: 1 });
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

const scrollCounts = { overflowOpens: 0, overflowClicks: 0, wheelScrolls: 0 };

export function noteTabSwitcherOverflowOpened() {
  scrollCounts.overflowOpens++;
}

export function noteTabSwitcherOverflowClick() {
  scrollCounts.overflowClicks++;
}

export function noteTabSwitcherWheelScrolled() {
  scrollCounts.wheelScrolls++;
}

export function takeTabSwitcherScrollCounts() {
  const taken = {
    tab_switcher_overflow_opens: scrollCounts.overflowOpens,
    tab_switcher_overflow_clicks: scrollCounts.overflowClicks,
    tab_switcher_wheel_scrolls: scrollCounts.wheelScrolls,
  };
  scrollCounts.overflowOpens = scrollCounts.overflowClicks = scrollCounts.wheelScrolls = 0;
  return taken;
}
