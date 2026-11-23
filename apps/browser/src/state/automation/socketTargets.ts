import { useBrowser, type BrowserState } from "../browser/store";
import { isIncognitoProfile } from "../browser/model";
import type { BrowserWindow, Tab } from "../browser/types";
import { eligibleKind, isEligibleTab, lastFocusedEligibleWindow, ownEntry, type AutomationWindowKind } from "./automationWindows";
import { OpError } from "./workspaceTargets";
import { withinBudget } from "./socketWire";

export const now = (): BrowserState => useBrowser.getState();

export function tabOf(id: unknown): Tab {
  const s = now();
  if (typeof id !== "string" || !isEligibleTab(s, id)) throw new OpError("no_window", `There's no tab ${String(id)} the ardia command can use.`);
  return s.tabs[id]!;
}

export function windowOf(id: unknown, kinds: readonly AutomationWindowKind[] = ["normal", "little"]): BrowserWindow {
  const s = now();
  const kind = eligibleKind(s, typeof id === "string" ? id : null);
  if (!kind || !kinds.includes(kind)) throw new OpError("no_window", `There's no window ${String(id)} the ardia command can use.`);
  return s.windows[id as string]!;
}

export function windowOrFocused(id: unknown, kinds: readonly AutomationWindowKind[] = ["normal"]): BrowserWindow {
  if (id !== undefined && id !== null) return windowOf(id, kinds);
  const s = now();
  const focused = lastFocusedEligibleWindow(s);
  if (focused && kinds.includes(eligibleKind(s, focused)!)) return s.windows[focused]!;
  const any = s.windowOrder.find((w) => kinds.includes(eligibleKind(s, w) as AutomationWindowKind));
  if (!any) throw new OpError("no_window", "No window the ardia command can use is open.");
  return s.windows[any]!;
}

export function profileArg(id: unknown): string {
  const s = now();
  if (id === undefined || id === null) return s.settings.defaultProfileId;
  if (!ownEntry(s.profiles, id) || isIncognitoProfile(id as string)) throw new OpError("no_window", `There's no profile ${String(id)}.`);
  return id as string;
}

export function page<T, R = T>(items: readonly T[], params: Record<string, unknown>, row: (item: T) => R = (item) => item as unknown as R) {
  const offset = (params.offset as number | undefined) ?? 0;
  const limit = (params.limit as number | undefined) ?? 100;
  const shown = withinBudget(items.slice(offset, offset + limit).map(row));
  const next = offset + shown.length;
  return { items: shown, total: items.length, nextOffset: next < items.length ? next : null };
}

export function expect(ok: boolean, message: string) {
  if (!ok) throw new OpError("failed", `Ardia didn't do that: ${message}`);
}
