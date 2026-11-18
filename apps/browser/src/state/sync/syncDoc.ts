import type { HLC, ScopeState } from "../../platform/sync";
import type { Space } from "../browser/types";
import { unchanged, type Migrations } from "../../lib/savedDocument";
import type { DeviceKind, SendRecord } from "./records";
import type { SendLedger } from "./sentTabsAdapter";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../lib/platformTerms";

type SyncTypeSpec = { title: string; description: string; profileData?: true };

const SYNC_TYPES = {
  bookmarks: { title: "Bookmarks", description: "Each synced profile’s bookmarks bar and other bookmarks.", profileData: true },
  history: { title: "History", description: "The last 90 days.", profileData: true },
  tabs: { title: "Open Tabs", description: "Your other devices’ tabs in the tab overflow menu. All Open Tabs needs it on." },
  pinned: { title: "Pinned Tabs and Groups", description: "Pinned tabs and pinned tab groups." },
  passwords: { title: "Passwords", description: `Saved passwords. Turning sync off never removes them from this ${PLATFORM_TERMS.computer}.`, profileData: true },
  extensions: {
    title: "Extensions",
    description: "Extensions from the Chrome Web Store, whether they’re on, and whether they’re pinned.",
    profileData: true,
  },
  settings: { title: "Settings", description: "Search engine, appearance, tab and keyboard settings." },
} as const satisfies Record<string, SyncTypeSpec>;

export type DataType = keyof typeof SYNC_TYPES;

const SPECS: Readonly<Record<DataType, SyncTypeSpec>> = SYNC_TYPES;
const TYPE_IDS = Object.keys(SYNC_TYPES) as DataType[];

const offered = (id: DataType) => id !== "passwords" || PLATFORM_FEATURES.syncsPasswords;

export const SYNCED_KINDS = `bookmarks, history, open tabs, pinned tabs, groups, ${PLATFORM_FEATURES.syncsPasswords ? "passwords, " : ""}extensions and settings`;

export const DATA_TYPES = TYPE_IDS.filter(offered).map((id) => ({ id, title: SPECS[id].title, description: SPECS[id].description }));

export const typeSyncedFor = (types: Record<DataType, boolean>, type: DataType, ownsData: boolean) =>
  offered(type) && types[type] && (ownsData || !SPECS[type].profileData);

export type SpaceLink = {
  syncId: string;
  enabled: boolean;
  ownerSyncId?: string;
  adopting?: true;
  retire?: boolean;
  themeAdopting?: true;
  keepPairingColor?: true;
  tabsRetire?: true;
};

export type ProfileLink = { syncId: string; enabled: boolean; retire?: boolean; adopting?: true };

export { profileScope, spaceScope } from "./records";

export type SyncDoc = {
  v: 3;
  preview?: true;
  initialized?: true;
  profiles: Record<string, ProfileLink>;
  enabled: boolean;
  folder: string | null;
  deviceId: string | null;
  clock: string | null;
  types: Record<DataType, boolean>;
  spaces: Record<string, SpaceLink>;
  scopes: Record<string, ScopeState>;
  lastSyncedAt: number | null;
  setupAt: number | null;
  joining: boolean;
  joiningThemeChoices?: string[];
  seqs?: Record<string, number>;
  sends?: Record<string, SendLedger>;
  tabCloses?: Record<string, string[]>;
  removing?: string[] | Record<string, ProfileRemoval>;
  removingDevices?: string[] | Record<string, HLC>;
};

export type ProfileRemoval = { keys: Record<string, HLC>; returned?: boolean };

export const DOC = "sync.json";
export const DOC_VERSION = 3;
export const DOC_MIGRATIONS: Migrations = { 0: unchanged, 1: unchanged, 2: unchanged };
export const STATE = "sync-state.nns";
export const JOURNAL = "sync-journal.nns";
export const journalPartName = (n: number) => `sync-journal-${n}.nns`;
export const APP_SCOPE = "app";

export const defaultTypes = (): Record<DataType, boolean> => Object.fromEntries(TYPE_IDS.map((id) => [id, true])) as Record<DataType, boolean>;

export const emptyDoc = (): SyncDoc => ({
  v: 3,
  profiles: {},
  enabled: false,
  folder: null,
  deviceId: null,
  clock: null,
  types: defaultTypes(),
  spaces: {},
  scopes: {},
  lastSyncedAt: null,
  setupAt: null,
  joining: false,
});

export type SyncStatus = "off" | "preview" | "starting" | "updating" | "updated" | "stalled" | "offline" | "locked" | "reset" | "unavailable";

export type SyncedDevice = { id: string; name: string; kind: DeviceKind; receivesTabs: boolean; lastSeen: number | null; current: boolean; version?: string; os?: string };
export type RemoteTabs = { deviceId: string; name: string; kind: DeviceKind; tabs: { url: string; title: string }[] };
export type SendTarget = { id: string; name: string; kind: DeviceKind };
export type ReceivedTab = { windowId: string; tabId: string; send: SendRecord; from: { name: string; kind: DeviceKind } };
export type RemoteSpace = { syncId: string; name: string; color: Space["color"]; icon: string | null; sharesWith?: { name: string; added: boolean }; waiting?: true; sharedByOthers?: true };

export type SyncUi = {
  profiles: Record<string, ProfileLink>;
  status: SyncStatus;
  enabled: boolean;
  joining: boolean;
  folder: string | null;
  types: Record<DataType, boolean>;
  spaces: Record<string, SpaceLink>;
  lastSyncedAt: number | null;
  error: string | null;
  pending: number;
  devices: SyncedDevice[];
  remoteTabs: Record<string, RemoteTabs[]>;
  remoteSpaces: RemoteSpace[];
};
