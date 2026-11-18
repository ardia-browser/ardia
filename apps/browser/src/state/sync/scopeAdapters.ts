import { emptyScope, SyncNative, type Adapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { deviceAdapter, deviceTabsAdapter, inTodaysNames } from "./adapters";
import { profilesAdapter } from "./identityAdapters";
import { spacesAdapter, spaceThemesAdapter } from "./spaceAdapters";
import { settingsAdapter } from "./settingsAdapter";
import { pinnedAreaAdapters } from "./pinned";
import { APP_SCOPE, spaceScope, type SyncDoc } from "./syncDoc";
import { openTabsAdapters, type OpenTabCloses, type OpenTabsMode } from "./openTabs";
import { PROFILE_OPEN_TABS } from "./records";
import { deliverSentTabs, sendLedger } from "./sentTabs";
import { sentTabsAdapter } from "./sentTabsAdapter";
import { alsoDeleting, removedDeviceKeys } from "./deviceRemoval";
import { removedRecordKeys } from "./profileRemoval";
import { spaceOpenTabsAdapter, spaceTopAppsAdapter } from "./profileAdapters";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

export const deviceName = () => SyncNative?.deviceName() ?? `This ${PLATFORM_TERMS.computerTitle}`;
export function appAdapters(doc: SyncDoc, retiring: boolean): Adapter[] {
  const id = doc.deviceId!;
  if (retiring) return [deviceAdapter(id, deviceName, true)];
  const app = doc.scopes[APP_SCOPE];
  if (app) app.unapplied = [...new Set([...app.unapplied, ...Object.values(doc.spaces).filter((link) => link.enabled && link.adopting).map((link) => `prof:${link.syncId}`)])];
  const enabledLinks = () => Object.fromEntries(Object.entries(doc.spaces).filter(([, l]) => l.enabled));
  const removed = () => removedRecordKeys(doc);
  const spaceOrder = () => useBrowser.getState().spaceOrder.flatMap((key) => enabledLinks()[key]?.syncId ?? []);
  return [
    ...(doc.types.settings ? [inTodaysNames(settingsAdapter)] : []),
    profilesAdapter(() => doc.profiles),
    alsoDeleting(spacesAdapter(enabledLinks, () => doc.profiles), removed),
    alsoDeleting(spaceThemesAdapter(enabledLinks, () => doc.scopes[APP_SCOPE]?.records), removed),
    spaceTopAppsAdapter(enabledLinks, removed),
    spaceOpenTabsAdapter(enabledLinks, removed),
    alsoDeleting(deviceAdapter(id, deviceName, false, spaceOrder), () => removedDeviceKeys(doc)),
  ];
}

function openTabsMode(doc: SyncDoc, spaceId: string): OpenTabsMode {
  const link = doc.spaces[spaceId]!;
  if (useBrowser.getState().spaces[spaceId]?.syncTabs) {
    delete link.tabsRetire;
    return doc.types.tabs ? "on" : "off";
  }
  return link.tabsRetire ? "retire" : "off";
}

export function openTabCloses(doc: SyncDoc, scope: string): OpenTabCloses {
  return {
    keys: () => doc.tabCloses?.[scope] ?? [],
    settle: (keys) => {
      const left = (doc.tabCloses?.[scope] ?? []).filter((key) => !keys.includes(key));
      if (left.length) (doc.tabCloses ??= {})[scope] = left;
      else if (doc.tabCloses) delete doc.tabCloses[scope];
    },
  };
}

export function spaceAdapters(doc: SyncDoc, spaceId: string, retiring: boolean): Adapter[] {
  const id = doc.deviceId!;
  const link = doc.spaces[spaceId]!;
  const scope = spaceScope(link.syncId);
  const flag = () => doc.scopes[APP_SCOPE]?.records[`${PROFILE_OPEN_TABS}${link.syncId}`]?.h;
  if (retiring) return [deviceTabsAdapter(spaceId, id, deviceName, true)];
  return [
    ...(doc.types.pinned ? pinnedAreaAdapters(spaceId, !!useBrowser.getState().spaces[spaceId]?.shareTopApps) : []),
    ...openTabsAdapters(spaceId, (doc.scopes[scope] ??= emptyScope()), openTabsMode(doc, spaceId), openTabCloses(doc, scope), flag),
    inTodaysNames(deviceTabsAdapter(spaceId, id, deviceName, !doc.types.tabs)),
    sentTabsAdapter(id, () => sendLedger(doc, scope), (arrived) => deliverSentTabs(doc, spaceId, arrived)),
  ];
}
