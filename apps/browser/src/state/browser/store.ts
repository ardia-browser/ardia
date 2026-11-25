import { create, type StateCreator, type StoreApi, type UseBoundStore } from "zustand";
import { withRetiredDefaults } from "../settings/retiredDefaults";
import { setHeldReportsTransaction } from "../../platform/nativeEvents";
import { createBookmarksSlice, ensureRoots, type BookmarksSlice } from "../bookmarks/bookmarks";
import { changedIds } from "./changes";
import { createGroupsSlice, type GroupsSlice } from "../groups/groups";
import { createHistorySlice, type HistorySlice } from "../history/history";
import { engineProfile, isIncognitoProfile } from "./model";
import { createOrganizeSlice, type OrganizeSlice } from "../pins/organize";
import { createMuteSlice, type MuteSlice } from "../tabs/mute";
import { createCleanUpSlice, type CleanUpSlice } from "../pins/tabCleanup";
import { keptCleanedTabs, keptDeletedGroups } from "../pins/closedTabs";
import { notePinChoices } from "../pins/pinChoices";
import { createPeekSlice, type PeekSlice } from "../peek/peek";
import { hydratedLayout } from "./hydratedLayout";
import { createProfilesSlice, type ProfilesSlice } from "../profiles/profiles";
import { engineProfiles } from "../profiles/engineProfiles";
import { createSettingsSlice, parseSettings, parseSettingsMeta, type SettingsSlice } from "../settings/settings";
import { createSplitsSlice, type SplitsSlice } from "../splits/splits";
import { activated, apply } from "../tabs/tabs";
import { createTabsSlice, type TabsSlice } from "../tabs/tabsSlice";
import { bindLiveToBrowser, forgetAllLive } from "../tabs/tabLive";
import { settle, SettleDidNotConverge } from "./settle";
import { transactional, type SubscribeTo } from "./transaction";
import { actionsApart } from "./actionsApart";
import { createUiSlice, type UiSlice } from "../windows/ui";
import { createDownloadsSlice, type DownloadsSlice } from "../downloads/downloadsSlice";
import { createWindowsSlice, type WindowsSlice } from "../windows/windows";

export type BrowserState = ProfilesSlice &
  WindowsSlice &
  TabsSlice &
  GroupsSlice &
  OrganizeSlice &
  MuteSlice &
  CleanUpSlice &
  SplitsSlice &
  HistorySlice &
  BookmarksSlice &
  SettingsSlice &
  UiSlice &
  DownloadsSlice &
  PeekSlice & {
    hydrate(data: HydrateData): void;
  };

export type HydrateData = Partial<
  Pick<
    BrowserState,
    | "profiles"
    | "profileOrder"
    | "orphanedProfileData"
    | "windows"
    | "windowOrder"
    | "tabs"
    | "groups"
    | "splits"
    | "closedTabs"
    | "closedWindows"
    | "parkedPins"
    | "pinChoices"
    | "pinSync"
    | "topAppsMerged"
    | "closedGroups"
    | "deletedGroups"
    | "cleanedTabs"
    | "downloads"
    | "settings"
    | "settingsMeta"
  >
> & { focusedWindowId?: string | null; lastProfileId?: string | null; retiredDefaultsWaitForSync?: boolean };

let batch = (update: () => void) => update();
export function setStoreBatching(batchedUpdates: (update: () => void) => void) {
  batch = batchedUpdates;
}
export const batchStoreUpdates = (update: () => void) => batch(update);

const batched =
  <T,>(creator: StateCreator<T>): StateCreator<T> =>
  (set, get, api) => {
    const batchedSet = ((...args: Parameters<typeof set>) => batch(() => (set as (...a: typeof args) => void)(...args))) as typeof set;
    api.setState = batchedSet;
    return creator(batchedSet, get, api);
  };

const pageMoved = (s: BrowserState, prev: BrowserState) =>
  s.tabs !== prev.tabs && changedIds(s.tabs, prev.tabs).some((id) => s.tabs[id]?.url !== prev.tabs[id]?.url);
const reportsUnsettled = !__DEV__ && !(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_TEST_CONTEXT;
const settled = (s: BrowserState, prev: BrowserState) => {
  try {
    return settle(s, prev);
  } catch (error) {
    if (!(error instanceof SettleDidNotConverge) || !reportsUnsettled) throw error;
    console.error(error);
    return error.settled;
  }
};
const transactions = transactional<BrowserState>(pageMoved, settled);
export const storeTransaction = transactions.transaction;
export const afterStoreTransactionIdempotent = transactions.afterTransactionIdempotent;
export const inStoreTransaction = transactions.inTransaction;
setHeldReportsTransaction(storeTransaction);

const createdBrowser = create<BrowserState>()(actionsApart(transactions.middleware(batched((...a) => ({
  ...createProfilesSlice(...a),
  ...createWindowsSlice(...a),
  ...createTabsSlice(...a),
  ...createGroupsSlice(...a),
  ...createOrganizeSlice(...a),
  ...createMuteSlice(...a),
  ...createCleanUpSlice(...a),
  ...createSplitsSlice(...a),
  ...createHistorySlice(...a),
  ...createBookmarksSlice(...a),
  ...createSettingsSlice(...a),
  ...createUiSlice(...a),
  ...createDownloadsSlice(...a),
  ...createPeekSlice(...a),

  hydrate(data) {
    const [set, get] = a;
    const s = get();
    const { profiles, windows, windowOrder, tabs, groups, splits } = hydratedLayout(data);
    const profileOrder = [
      ...(data.profileOrder ?? []).filter((id) => profiles[id]),
      ...Object.keys(profiles).filter((id) => !data.profileOrder?.includes(id)),
    ];
    const kept = withRetiredDefaults(data.settings, parseSettingsMeta(data.settingsMeta), { waitForSync: data.retiredDefaultsWaitForSync });
    const settings = parseSettings(kept.settings);
    if (!profiles[settings.defaultProfileId]) settings.defaultProfileId = profileOrder[0]!;

    notePinChoices(data.pinChoices ?? {});
    let bookmarks = s.bookmarks;
    for (const engine of engineProfiles({ profiles })) bookmarks = ensureRoots(bookmarks, engine)[0];
    const focused = data.focusedWindowId && windows[data.focusedWindowId] ? data.focusedWindowId : (windowOrder.at(-1) ?? null);

    const engines = new Set(Object.keys(profiles).map((id) => engineProfile({ profiles }, id)));
    let next: BrowserState = {
      ...s,
      profiles,
      profileOrder,
      orphanedProfileData: (data.orphanedProfileData ?? []).filter((e) => !engines.has(e)),
      settings,
      settingsMeta: kept.settingsMeta,
      windows,
      windowOrder,
      tabs,
      groups,
      splits,
      closedTabs: data.closedTabs ?? [],
      closedWindows: data.closedWindows ?? [],
      parkedPins: Object.fromEntries(Object.entries(data.parkedPins ?? {}).filter(([p]) => profiles[p])),
      pinChoices: Object.fromEntries(Object.entries(data.pinChoices ?? {}).filter(([p]) => profiles[p])),
      pinSync: Object.fromEntries(Object.entries(data.pinSync ?? {}).filter(([p]) => profiles[p])),
      topAppsMerged: data.topAppsMerged ?? "",
      closedGroups: data.closedGroups ?? [],
      deletedGroups: keptDeletedGroups(data.deletedGroups ?? []),
      cleanedTabs: keptCleanedTabs((data.cleanedTabs ?? []).filter((c) => !isIncognitoProfile(c.tab.profileId))),
      privateCleanedTabs: {},
      privateSiteMutes: {},
      selection: {},
      selectionAnchors: {},
      history: {},
      bookmarks,
      bookmarksReady: {},
      downloads: data.downloads ?? [],
      windowUi: {},
      peeks: {},
      find: {},
      ui: {
        ...s.ui,
        focusOrder: focused ? [focused, ...windowOrder.filter((id) => id !== focused).reverse()] : [],
        lastProfileId: data.lastProfileId && profiles[data.lastProfileId] ? data.lastProfileId : null,
      },
    };
    for (const id of next.ui.focusOrder) next = apply(next, activated(next, windows[id]!.activeTabIds[windows[id]!.profileId]!));
    forgetAllLive();
    set(next);
  },
})))));
export const useBrowser = createdBrowser as UseBoundStore<StoreApi<BrowserState>> & { subscribeTo: SubscribeTo<BrowserState> };
bindLiveToBrowser(useBrowser, transactions.afterTransactionIdempotent);


type StoreActions = { [K in keyof BrowserState as BrowserState[K] extends (...args: never[]) => unknown ? K : never]: BrowserState[K] };

export const storeAction =
  <K extends keyof StoreActions>(name: K): StoreActions[K] =>
  ((...args: unknown[]) => (useBrowser.getState()[name] as (...a: unknown[]) => unknown)(...args)) as StoreActions[K];
