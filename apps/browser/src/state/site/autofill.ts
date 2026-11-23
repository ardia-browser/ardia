import { consentToken } from "../telemetry/choice";
import { showAutofillSuggestions, type CardNetwork } from "../../platform/autofill";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isTabReady } from "../tabs/pageState";
import { openSettings, SETTINGS_DETAIL } from "../settings/settingsWindows";
import { runVaultAction } from "../vaults/barActions";
import { anyVaultConnectedForTab } from "../vaults/store";
import { ardiaFillsInTab } from "../vaults/ardiaSources";
import { currentManagerPlugin, openSystemPanel } from "./passwordManager";

export { setAutofillSettings, type CardNumberSummary, type SavedAddress, type SavedCard } from "../../platform/autofill";
export { cardNetworkName } from "../autofill/cards";

export type { CardNetwork };

export async function requestAutofill(windowId: string, arg: string | null, tabId = activeTabId(useBrowser.getState(), windowId)) {
  const consent = consentToken();
  const passwords = arg === "passwords";
  const tab = tabId ? useBrowser.getState().tabs[tabId] : undefined;
  const ready = !!tab && isTabReady(tab.id);
  const systemPanel = passwords && ready && currentManagerPlugin(tab.profileId)?.spec.fill === "system";
  if (passwords && ready && !systemPanel && anyVaultConnectedForTab(tab.id) && ardiaFillsInTab(tab.id)) return runVaultAction("vault:fill", useBrowser.getState(), windowId, consent);
  if (isTabReady(tabId) && (await (systemPanel ? openSystemPanel(tabId!) : showAutofillSuggestions(tabId, passwords ? "passwords" : "field")))) return;
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  const profileId = w && w.kind !== "private" && s.profiles[w.profileId] ? w.profileId : null;
  openSettings("profiles", profileId, passwords ? SETTINGS_DETAIL.passwords : null);
}
