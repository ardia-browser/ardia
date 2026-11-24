import { emptyScope, SyncNative, type Adapter, type ExtensionsAdapter } from "../../platform/sync";
import { useBrowser } from "../browser/store";
import { bookmarksAdapter, deviceAdapter, deviceTabsAdapter, inTodaysNames, passwordsAdapter, sharedDataAdapter } from "./adapters";
import { historyAdapter } from "./historyAdapter";
import { profileOpenTabsAdapter, profilesAdapter, profileThemesAdapter, profileTopAppsAdapter } from "./profileAdapters";
import { settingsAdapter } from "./settingsAdapter";
import { pinnedAreaAdapters } from "./pinned";
import { extensionsAdapterFor } from "./extensions";
import { APP_SCOPE, typeSyncedFor, type DataType, type SyncDoc } from "./syncDoc";
import { sentTabsAdapter } from "./sentTabsAdapter";
import { deliverSentTabs, sendLedger } from "./sentTabs";
import { PROFILE_OPEN_TABS, profileScope } from "./records";
import { openTabsAdapters, openTabsPinPageWrites, type OpenTabCloses, type OpenTabsMode } from "./openTabs";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { removedRecordKeys } from "./profileRemoval";
import { alsoDeleting, removedDeviceKeys } from "./deviceRemoval";

export const deviceName = () => SyncNative?.deviceName() ?? `This ${PLATFORM_TERMS.computerTitle}`;

const passwordAdapters = new Map<string, (forced: boolean) => Adapter>();
const extensionAdapters = new Map<string, ExtensionsAdapter>();

export function forgetScopeAdapters() {
  passwordAdapters.clear();
  extensionAdapters.clear();
}

export const typeSynced = (doc: SyncDoc, type: DataType, profileId: string) =>
  typeSyncedFor(doc.types, type, !useBrowser.getState().profiles[profileId]?.dataId);

export function extensionsOf(profileId: string): ExtensionsAdapter {
  let adapter = extensionAdapters.get(profileId);
  if (!adapter) extensionAdapters.set(profileId, (adapter = extensionsAdapterFor(profileId)));
  return adapter;
}

const syncedProfileOrder = (links: SyncDoc["profiles"]) =>
  useBrowser.getState().profileOrder.flatMap((id) => (links[id] ? [links[id].syncId] : []));

const withSharedOwners = (doc: SyncDoc, links: () => SyncDoc["profiles"]) => (): SyncDoc["profiles"] => {
  const shown = links();
  const profiles = useBrowser.getState().profiles;
  const owners = Object.keys(shown).flatMap((id) => {
    const owner = profiles[id]?.dataId;
    return owner && owner !== id && doc.profiles[owner] && !shown[owner] ? [[owner, doc.profiles[owner]] as const] : [];
  });
  return owners.length ? { ...shown, ...Object.fromEntries(owners) } : shown;
};

export function appAdapters(doc: SyncDoc, retiring: boolean): Adapter[] {
  const id = doc.deviceId!;
  if (retiring) return [deviceAdapter(id, deviceName, true)];
  const enabledLinks = () => Object.fromEntries(Object.entries(doc.profiles).filter(([, l]) => l.enabled));
  const removed = () => removedRecordKeys(doc);
  return [
    ...(doc.types.settings ? [inTodaysNames(settingsAdapter)] : []),
    sharedDataAdapter(() => doc.profiles, removed),
    profilesAdapter(withSharedOwners(doc, enabledLinks), removed, () => doc.scopes[APP_SCOPE]?.records, enabledLinks),
    profileThemesAdapter(enabledLinks, () => doc.scopes[APP_SCOPE]?.records, removed),
    profileTopAppsAdapter(enabledLinks, removed),
    profileOpenTabsAdapter(enabledLinks, removed),
    alsoDeleting(deviceAdapter(id, deviceName, false, () => syncedProfileOrder(enabledLinks())), () => removedDeviceKeys(doc)),
  ];
}

function openTabsMode(doc: SyncDoc, profileId: string): OpenTabsMode {
  const link = doc.profiles[profileId]!;
  if (useBrowser.getState().profiles[profileId]?.syncTabs) {
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

export function profileAdapters(doc: SyncDoc, profileId: string, retiring: boolean, forcePasswords: boolean): Adapter[] {
  const id = doc.deviceId!;
  if (retiring) return [deviceTabsAdapter(profileId, id, deviceName, true)];
  const synced = (type: DataType) => typeSynced(doc, type, profileId);
  let passwords = passwordAdapters.get(profileId);
  if (!passwords) passwordAdapters.set(profileId, (passwords = passwordsAdapter(profileId)));
  const scope = profileScope(doc.profiles[profileId]!.syncId);
  const flag = () => doc.scopes[APP_SCOPE]?.records[`${PROFILE_OPEN_TABS}${doc.profiles[profileId]!.syncId}`]?.h;
  const state = (doc.scopes[scope] ??= emptyScope());
  const mode = openTabsMode(doc, profileId);
  const openTabs = openTabsAdapters(profileId, state, mode, openTabCloses(doc, scope), flag);
  return [
    ...(synced("pinned") ? pinnedAreaAdapters(profileId, openTabsPinPageWrites(profileId, state, mode, flag)) : []),
    ...openTabs,
    ...(synced("bookmarks") ? [inTodaysNames(bookmarksAdapter(profileId))] : []),
    ...(synced("history") ? [inTodaysNames(historyAdapter(profileId))] : []),
    inTodaysNames(deviceTabsAdapter(profileId, id, deviceName, !synced("tabs"))),
    sentTabsAdapter(id, () => sendLedger(doc, profileScope(doc.profiles[profileId]!.syncId)), (arrived) => deliverSentTabs(doc, profileId, arrived)),
    ...(synced("passwords") ? [passwords(forcePasswords)] : []),
    ...(synced("extensions") ? [extensionsOf(profileId)] : []),
  ];
}
