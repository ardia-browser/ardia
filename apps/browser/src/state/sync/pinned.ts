import type { Adapter } from "../../platform/sync";
import { inTodaysNames } from "./adapters";
import { groupLooksAdapter } from "./groupLooksAdapter";
import { applyPinned, type PinPageWrites } from "./pinnedApply";
import { extractPinned } from "./pinnedExtract";
import { pinnedHomesAdapter } from "./pinnedHomesAdapter";
import { pinnedLettersAdapter } from "./pinnedLettersAdapter";
import { pinnedOrderAdapter } from "./pinnedOrderAdapter";
import { pinnedRowsAdapter } from "./pinnedRowsAdapter";
import { tileFoldersAdapter } from "./tileFoldersAdapter";

export function pinnedAreaAdapters(profileId: string, pageWrites?: PinPageWrites): Adapter[] {
  return [
    tileFoldersAdapter(profileId),
    pinnedRowsAdapter(profileId),
    pinnedOrderAdapter(profileId),
    groupLooksAdapter(profileId),
    inTodaysNames(pinnedHomesAdapter(profileId)),
    inTodaysNames(pinnedAdapter(profileId, pageWrites)),
    pinnedLettersAdapter(profileId),
  ];
}

export function pinnedAdapter(profileId: string, pageWrites?: PinPageWrites): Adapter {
  return {
    prefix: "pin",
    extract: (base, queued, now, _known, _remote, stamp) => extractPinned(profileId, base, queued, now, stamp),
    apply: (visible, changed, base, records) => applyPinned(profileId, visible, changed, base, records, pageWrites),
  };
}
