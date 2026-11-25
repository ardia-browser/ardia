import { create } from "zustand";
import { pages } from "../../platform/pages";
import { settled } from "../pages/store";

export const usePageSummariesSwitch = create<{ enabled: boolean }>()(() => ({ enabled: false }));

export const usePageSummariesEnabled = () => usePageSummariesSwitch((state) => state.enabled);

export const pageSummariesEnabled = () => usePageSummariesSwitch.getState().enabled;

export function pageSummariesSwitchable(): boolean {
  try {
    return pages.switchesSummaries();
  } catch {
    return false;
  }
}

let change = 0;

export const pageSummariesRevision = () => change;

export async function refreshPageSummariesEnabled() {
  if (!pageSummariesSwitchable()) return;
  const asked = change;
  const enabled = await settled(() => pages.summariesEnabled(), false);
  if (asked === change) usePageSummariesSwitch.setState({ enabled });
}

export async function setPageSummariesEnabled(enabled: boolean): Promise<boolean> {
  if (!pageSummariesSwitchable()) return false;
  const asked = ++change;
  usePageSummariesSwitch.setState({ enabled });
  const saved = await settled<boolean | null>(() => pages.setSummariesEnabled(enabled), null);
  if (asked !== change) return false;
  const stored = saved ?? (await settled(() => pages.summariesEnabled(), false));
  if (asked !== change) return false;
  usePageSummariesSwitch.setState({ enabled: stored });
  return stored === enabled;
}
