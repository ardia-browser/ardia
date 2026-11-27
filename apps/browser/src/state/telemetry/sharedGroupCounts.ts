import { consentOrNow, countFor } from "./consentPeriod";

let ungrouped = 0;

export const noteSharedGroupUngroup = () => countFor(consentOrNow(undefined), () => void ungrouped++);

export function takeSharedGroupCounts() {
  const taken = { shared_groups_ungrouped: ungrouped };
  ungrouped = 0;
  return taken;
}
