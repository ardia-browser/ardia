import type { Adapter } from "../../platform/sync";
import { inTodaysNames } from "./adapters";
import { groupLooksAdapter } from "./groupLooksAdapter";
import { applyPinned, type PinPageWrites } from "./pinnedApply";
import { extractPinned } from "./pinnedExtract";
import { pinnedHomesAdapter } from "./pinnedHomesAdapter";
import { pinnedOrderAdapter } from "./pinnedOrderAdapter";
import { pinnedRowsAdapter } from "./pinnedRowsAdapter";
import { tileFoldersAdapter } from "./tileFoldersAdapter";

export function pinnedAreaAdapters(spaceId: string, pageWrites?: PinPageWrites): Adapter[] {
  return [
    tileFoldersAdapter(spaceId),
    pinnedRowsAdapter(spaceId),
    pinnedOrderAdapter(spaceId),
    groupLooksAdapter(spaceId),
    inTodaysNames(pinnedHomesAdapter(spaceId)),
    inTodaysNames(pinnedAdapter(spaceId, pageWrites)),
  ];
}

export function pinnedAdapter(spaceId: string, pageWrites?: PinPageWrites): Adapter {
  return {
    prefix: "pin",
    extract: (base, queued, now, _known, _remote, stamp) => extractPinned(spaceId, base, queued, now, stamp),
    apply: (visible, changed, base, records) => applyPinned(spaceId, visible, changed, base, records, pageWrites),
  };
}
