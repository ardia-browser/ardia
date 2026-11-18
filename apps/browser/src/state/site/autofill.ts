import { showAutofillSuggestions, type CardNetwork } from "../../platform/autofill";
import { useBrowser } from "../browser/store";
import { activeTabId } from "../browser/model";
import { isTabReady } from "../tabs/pageState";
import { openSettings, SETTINGS_DETAIL } from "../settings/settingsWindows";
import { currentManagerPlugin, openSystemPanel } from "./passwordManager";

export { deleteAddress, deleteCard, revealCardNumber, saveAddress, saveCard, setAutofillSettings, type SavedAddress, type SavedCard } from "../../platform/autofill";

export type { CardNetwork };

const NETWORK_NAMES: Record<CardNetwork, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  card: "Card",
};

export const cardNetworkName = (network: CardNetwork) => NETWORK_NAMES[network];

export async function requestAutofill(windowId: string, arg: string | null, tabId = activeTabId(useBrowser.getState(), windowId)) {
  const passwords = arg === "passwords";
  const tab = tabId ? useBrowser.getState().tabs[tabId] : undefined;
  const systemPanel = passwords && !!tab && currentManagerPlugin(tab.profileId)?.spec.fill === "system";
  if (isTabReady(tabId) && (await (systemPanel ? openSystemPanel(tabId!) : showAutofillSuggestions(tabId, passwords ? "passwords" : "field")))) return;
  const s = useBrowser.getState();
  const w = s.windows[windowId];
  const spaceId = w && w.kind !== "private" && s.spaces[w.spaceId] ? w.spaceId : null;
  openSettings("spaces", spaceId, passwords ? SETTINGS_DETAIL.passwords : null);
}
