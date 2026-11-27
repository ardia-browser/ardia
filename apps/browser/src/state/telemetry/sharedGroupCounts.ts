import { consentOrNow, countFor } from "./consentPeriod";

let ungrouped = 0;
let unpinned = 0;

export const noteSharedGroupUngroup = () => countFor(consentOrNow(undefined), () => void ungrouped++);

export const noteSharedGroupUnpin = () => countFor(consentOrNow(undefined), () => void unpinned++);

export function takeSharedGroupCounts() {
  const taken = { shared_groups_ungrouped: ungrouped, shared_groups_unpinned: unpinned };
  ungrouped = 0;
  unpinned = 0;
  return taken;
}
