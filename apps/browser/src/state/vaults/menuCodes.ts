import type { VaultFieldKind } from "../../platform/vaults";
import type { ConsentToken } from "../telemetry/choice";
import { noteDeliveredCodeOffered } from "../telemetry/vaultCounts";
import { prefetchVaultCodes } from "./codes";
import { anyFillsOnSite, fillsOnSite, isDeliveredItem } from "./deliveredCodesModel";
import { currentDeliveredItems, refreshDeliveredCodes, useDeliveredCodes } from "./deliveredCodes";
import { vaultsOnForTab } from "./enabled";
import { rowsOfMenu } from "./menuRowsOf";

type CodeMenu = Parameters<typeof rowsOfMenu>[0];

export function prefetchCodesOf(menu: CodeMenu) {
  if (menu.field !== "otp") return;
  void refreshDeliveredCodes();
  const items = rowsOfMenu(menu).flatMap((row) => (row.kind === "otp" ? [row.item] : []));
  prefetchVaultCodes(items);
}

export function noteOfferedCodes(menus: Record<string, CodeMenu & { seq: number } | null>, before: Record<string, { seq: number } | null>, consent: ConsentToken | null) {
  for (const [tabId, menu] of Object.entries(menus)) {
    if (!menu || menu.field !== "otp" || before[tabId]?.seq === menu.seq) continue;
    for (const row of rowsOfMenu(menu)) if (row.kind === "otp" && isDeliveredItem(row.item)) noteDeliveredCodeOffered(row.item.delivered.source, consent);
  }
}

export const loadingFor = (kind: VaultFieldKind, loadItems: () => Promise<unknown>) => (kind === "otp" ? Promise.all([loadItems(), refreshDeliveredCodes()]) : loadItems());

export const codesAloneOffer = (tabId: string, field: { kind: VaultFieldKind; origin: string }, asked = false) =>
  field.kind === "otp" && vaultsOnForTab(tabId) && (asked ? currentDeliveredItems().length > 0 : anyFillsOnSite(currentDeliveredItems(), field.origin));

export function watchDeliveredCodes(restOpenMenus: () => void, fields: () => Record<string, { kind: VaultFieldKind; origin: string } | null | undefined>, offerAt: (tabId: string) => void) {
  return useDeliveredCodes.subscribe((s, prev) => {
    if (s.items === prev.items) return;
    restOpenMenus();
    const arrived = s.items.filter((item) => !prev.items.includes(item));
    for (const [tabId, field] of Object.entries(fields())) if (field?.kind === "otp" && arrived.some((item) => fillsOnSite(item.delivered, field.origin))) offerAt(tabId);
  });
}
