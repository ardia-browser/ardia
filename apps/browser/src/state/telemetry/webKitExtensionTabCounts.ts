import { isWebKitExtensionStateCount, noteWebKitExtensionStateCount, takeWebKitExtensionStateCounts, type WebKitExtensionStateCount } from "./webKitExtensionStateCounts";
import { counted, onConsentPeriodChange, type ConsentToken } from "./choice";

const WIRE = {
  extensionTabCreate: "webkit_extension_tab_creates",
  extensionTabClose: "webkit_extension_tab_closes",
  extensionTabActivate: "webkit_extension_tab_activations",
  extensionTabPin: "webkit_extension_tab_pins",
  extensionTabDuplicate: "webkit_extension_tab_duplicates",
  extensionTabZoom: "webkit_extension_tab_zooms",
  extensionWindowCreate: "webkit_extension_window_creates",
  extensionWindowUpdate: "webkit_extension_window_updates",
  extensionWindowRemove: "webkit_extension_window_removes",
  extensionTabRequestFailed: "webkit_extension_tab_request_failures",
  extensionPopup: "webkit_extension_popups",
  extensionUnavailable: "webkit_extension_unavailable",
} as const;

export type WebKitExtensionTabCount = keyof typeof WIRE | WebKitExtensionStateCount;
type Wire = (typeof WIRE)[keyof typeof WIRE];

const none = () => Object.fromEntries(Object.values(WIRE).map((wire) => [wire, 0])) as Record<Wire, number>;
let tally = none();

onConsentPeriodChange(() => (tally = none()));

export const isWebKitExtensionTabCount = (name: string): name is WebKitExtensionTabCount => Object.hasOwn(WIRE, name) || isWebKitExtensionStateCount(name);

export function noteWebKitExtensionTabCount(name: WebKitExtensionTabCount, consent: ConsentToken | null) {
  if (isWebKitExtensionStateCount(name)) return noteWebKitExtensionStateCount(name, consent);
  counted(consent, () => void tally[WIRE[name]]++);
}

export function takeWebKitExtensionTabCounts() {
  const taken = tally;
  tally = none();
  return { ...taken, ...takeWebKitExtensionStateCounts() };
}
