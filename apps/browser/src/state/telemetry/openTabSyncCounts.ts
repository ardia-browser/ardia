import { counted, type ConsentToken } from "./consentPeriod";

let published = 0;
let opened = 0;
let closed = 0;
let updated = 0;
let wakes = 0;
let massCloses = 0;
let massCloseSends = 0;
let largestCycle = 0;

const MASS_CLOSE = 5;

export const noteOpenTabsPublished = (n: number) => void (published += n);

export const noteOpenTabsWoke = () => void wakes++;

export const noteOpenTabClosesSent = (consent: ConsentToken | null, n: number) => counted(consent, () => void (n >= MASS_CLOSE && massCloseSends++));

export function noteOpenTabsApplied(counts: { opened: number; closed: number; updated: number }) {
  opened += counts.opened;
  closed += counts.closed;
  updated += counts.updated;
  if (counts.closed >= MASS_CLOSE) massCloses++;
  largestCycle = Math.max(largestCycle, counts.opened + counts.closed);
}

export function takeOpenTabSyncCounts() {
  const taken = {
    sync_open_tabs_published: published,
    sync_open_tabs_opened: opened,
    sync_open_tabs_closed: closed,
    sync_open_tabs_updated: updated,
    sync_open_tabs_wakes: wakes,
    sync_open_tabs_mass_closes: massCloses,
    sync_open_tabs_mass_close_sends: massCloseSends,
    sync_open_tabs_cycle_max: largestCycle,
  };
  published = opened = closed = updated = wakes = massCloses = massCloseSends = largestCycle = 0;
  return taken;
}
