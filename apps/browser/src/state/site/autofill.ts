import { showAutofillSuggestions, type CardNetwork } from "../../platform/autofill";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isTabReady } from "../tabs/pageState";
import { openSettings, SETTINGS_DETAIL } from "../settings/settingsWindows";
import { currentManagerPlugin, openSystemPanel } from "./passwordManager";
import { t } from "../../lib/uiLanguage";


export { deleteAddress, deleteCard, revealCardNumber, saveAddress, saveCard, setAutofillSettings, type SavedAddress, type SavedCard } from "../../platform/autofill";

export type { CardNetwork };

const NETWORK_NAMES: Record<CardNetwork, string> = {
  visa: t(`Visa`),
  mastercard: t(`Mastercard`),
  amex: t(`American Express`),
  discover: t(`Discover`),
  diners: t(`Diners Club`),
  jcb: t(`JCB`),
  unionpay: t(`UnionPay`),
  card: t(`Card`),
};

export const cardNetworkName = (network: CardNetwork) => NETWORK_NAMES[network];

export async function requestAutofill(windowId: string, arg: string | null, tabId = activeTabId(useBrowser.getState(), windowId)) {
  const passwords = arg === "passwords";
  const tab = tabId ? useBrowser.getState().tabs[tabId] : undefined;
  const systemPanel = passwords && !!tab && currentManagerPlugin(tab.profileId)?.spec.fill === "system";
  if (isTabReady(tabId) && (await (systemPanel ? openSystemPanel(tabId!) : showAutofillSuggestions(tabId, passwords ? "passwords" : "field")))) return;
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  const profileId = w && w.kind !== "private" && s.profiles[w.profileId] ? w.profileId : null;
  openSettings("profiles", profileId, passwords ? SETTINGS_DETAIL.passwords : null);
}
