import { create } from "zustand";
import { sync, type SyncedView, type SyncEvent, type SyncStatus } from "../../platform/sync";

export type { PinnedTile, SyncedProfile } from "../../platform/sync";
import { settled } from "../pages/store";
import { applyTabSpaces, setTabProfile } from "../tabs/store";
import { tabSpacesFor } from "../tabs/spaces";
import type { Design } from "../../lib/design";
import { pinKey, pinsStillOnTheirWay } from "./spaces";
import { pickAfterView, shownProfile, startupPatch, syncViewLoaded } from "./syncRules";

export const notePinSent = (profileSyncId: string | null, url: string) =>
  useSync.setState((state) => ({ pinsOnTheirWay: [...state.pinsOnTheirWay, pinKey(profileSyncId, url)] }));

export const OFF_STATUS: SyncStatus = {
  phase: "off",
  statusText: "Off",
  stalledMessage: null,
  attention: "none",
  isEnabled: false,
  isSyncing: false,
  isDemo: false,
  pendingDownloads: 0,
  lastSynced: null,
  folderName: null,
  deviceName: "",
  selectedProfileId: null,
  showsResetNotice: false,
  inboxProblem: null,
};

export const EMPTY_VIEW: SyncedView = { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] };

type SyncData = {
  available: boolean;
  loaded: boolean;
  status: SyncStatus;
  view: SyncedView;
  revision: number;
  pinsOnTheirWay: string[];
  pickedProfileId: string | null;
};

export const useSync = create<SyncData>()(() => ({
  available: false,
  loaded: false,
  status: OFF_STATUS,
  view: EMPTY_VIEW,
  revision: 0,
  pinsOnTheirWay: [],
  pickedProfileId: null,
}));

export const syncData = () => useSync.getState();

const LOCAL_CHANGE_DELAY_MS = 1000;

let started = false;
let fetched = false;
const seen = { status: false, view: false };
let localTimer: ReturnType<typeof setTimeout> | null = null;
const inboxListeners = new Set<() => void>();

export function selectedProfileId(): string | null {
  const { status, view } = syncData();
  return shownProfile(view, status)?.syncId ?? null;
}

export const selectedProfile = () => {
  const { status, view } = syncData();
  return shownProfile(view, status);
};

let spacesDesign: Design = "original";

function followSpaces() {
  const { status, view } = syncData();
  setTabProfile(selectedProfileId());
  applyTabSpaces(tabSpacesFor(spacesDesign, status.isEnabled, view.profiles, shownProfile(view, status)?.syncId ?? null));
}

useSync.subscribe(followSpaces);

export function setSpacesDesign(design: Design) {
  spacesDesign = design;
  followSpaces();
}

export function pickSpace(profileSyncId: string) {
  useSync.setState({ pickedProfileId: profileSyncId });
  void settled(() => sync.selectProfile(profileSyncId).then(() => true), false).then((done) => {
    if (!done && syncData().pickedProfileId === profileSyncId) useSync.setState({ pickedProfileId: null });
  });
}

function publish(patch: Partial<SyncData>) {
  useSync.setState((state) => ({ ...patch, revision: state.revision + 1 }));
}

function onEvent(event: SyncEvent) {
  if (event.name === "sync.status") {
    seen.status = true;
    publish({ status: event.status });
  } else if (event.name === "sync.view") {
    seen.view = true;
    publish({
      view: event.view,
      pinsOnTheirWay: pinsStillOnTheirWay(syncData().pinsOnTheirWay, event.view),
      pickedProfileId: pickAfterView(syncData().pickedProfileId, event.view),
      loaded: fetched && syncViewLoaded(event.view, true),
    });
  }
  else if (event.name === "sync.inbox" && event.count > 0) for (const listener of inboxListeners) listener();
}

export function startSyncSources(onInbox: () => void) {
  inboxListeners.add(onInbox);
  if (started) return;
  started = true;
  try {
    sync.addListener(onEvent);
  } catch {
    useSync.setState({ loaded: true });
    return;
  }
  useSync.setState({ available: true });
  void Promise.all([settled(() => sync.status(), null), settled(() => sync.view(), null)]).then(([status, view]) => {
    fetched = true;
    const patch = startupPatch(status, view, seen);
    publish({ ...patch, loaded: syncViewLoaded(patch.view ?? syncData().view, seen.view || view !== null) });
    onInbox();
  });
}

export function noteLocalChange() {
  if (!syncData().status.isEnabled) return;
  if (localTimer) clearTimeout(localTimer);
  localTimer = setTimeout(() => {
    localTimer = null;
    try {
      sync.localDidChange();
    } catch {
      return;
    }
  }, LOCAL_CHANGE_DELAY_MS);
}

export const setStatus = (status: SyncStatus) => publish({ status });
