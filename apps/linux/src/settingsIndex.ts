import * as shared from "../../browser/src/components/settings/settingsIndex.ts";
import { linuxCapabilities, unavailableSettingIds } from "./hostCapabilities.ts";
import { hostSupports } from "./host.ts";

export * from "../../browser/src/components/settings/settingsIndex.ts";

const capabilities = linuxCapabilities();
const hiddenSettings = unavailableSettingIds(capabilities, shared.SETTINGS.map((entry) => entry.id));
if (!hostSupports("ArdiaApp.postNotification")) hiddenSettings.add("automations.meetingAlertCondition");
if (!hostSupports("ArdiaApp.setInterfaceScale")) hiddenSettings.add("appearance.interfaceScale");

export const settingUnavailable = (id: string | undefined) => !!id && hiddenSettings.has(id);
export const sectionUnavailable = (pane: string | null | undefined, section: string | undefined) => {
  if (!pane || !section) return false;
  const entries = shared.sectionEntries(pane as Parameters<typeof shared.sectionEntries>[0], section);
  return entries.length > 0 && entries.every((entry) => hiddenSettings.has(entry.id));
};
export const SETTINGS_INDEX: typeof shared.SETTINGS_INDEX = shared.SETTINGS_INDEX.filter((item) => !settingUnavailable(item.entry.id));
