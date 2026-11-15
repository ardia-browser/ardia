import { symbolIcon } from "../../lib/customIcon";
import { isPinnedRow } from "../browser/model";
import type { Tab } from "../browser/types";
import { awayFromPin } from "./organize";

export const NO_ROW_ICON = symbolIcon("ardia:no-icon");

export const drawnIcon = (icon: string | null | undefined): string | null => (icon && icon !== NO_ROW_ICON ? icon : null);

export const isTextOnlyRow = (t: Pick<Tab, "pin" | "customIcon"> | undefined): boolean => !!t && isPinnedRow(t) && t.customIcon === NO_ROW_ICON;

export const hidesRowIcon = (t: Pick<Tab, "pin" | "customIcon" | "url" | "pinnedUrl"> | undefined, badged = false): boolean => !!t && !badged && isTextOnlyRow(t) && !awayFromPin(t);

export const ghostIcon = (groupIcon: string | null, tab: Pick<Tab, "pin" | "customIcon" | "url" | "pinnedUrl"> | undefined, draggingRow: boolean): { icon: string | null } | null =>
  groupIcon ? { icon: groupIcon } : tab && !(draggingRow && hidesRowIcon(tab)) ? { icon: tab.customIcon } : null;

export const ownIcon = (t: Pick<Tab, "pin" | "customIcon"> | undefined): string | null => (t && (isPinnedRow(t) ? t.customIcon : drawnIcon(t.customIcon))) ?? null;
