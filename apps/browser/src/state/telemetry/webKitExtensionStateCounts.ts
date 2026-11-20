import { counted, onConsentPeriodChange, type ConsentToken } from "./choice";

const WIRE = {
  extensionSharedCall: "webkit_extension_shared_calls",
  extensionSharedFallback: "webkit_extension_shared_fallbacks",
  extensionGrantsLive: "webkit_extension_grants_live",
  extensionGrantsFallback: "webkit_extension_grants_fallbacks",
  extensionGrantWritten: "webkit_extension_grants_written",
  extensionGrantsChanged: "webkit_extension_grants_changed",
  extensionDnrMirrored: "webkit_extension_dnr_mirrors",
  extensionDnrApplyFailed: "webkit_extension_dnr_apply_failures",
  extensionChromeBookmarkIds: "webkit_extension_chrome_bookmark_ids",
  extensionAlarmMirrored: "webkit_extension_alarms_mirrored",
  extensionAlarmUndelivered: "webkit_extension_alarms_undelivered",
  extensionAlarmKept: "webkit_extension_alarms_kept",
} as const;

export type WebKitExtensionStateCount = keyof typeof WIRE;
type Wire = (typeof WIRE)[WebKitExtensionStateCount];

const none = () => Object.fromEntries(Object.values(WIRE).map((wire) => [wire, 0])) as Record<Wire, number>;
let tally = none();

onConsentPeriodChange(() => (tally = none()));

export const isWebKitExtensionStateCount = (name: string): name is WebKitExtensionStateCount => Object.hasOwn(WIRE, name);

export function noteWebKitExtensionStateCount(name: WebKitExtensionStateCount, consent: ConsentToken | null) {
  counted(consent, () => void tally[WIRE[name]]++);
}

export function takeWebKitExtensionStateCounts(): Record<Wire, number> {
  const taken = tally;
  tally = none();
  return taken;
}
