import { addRemoteProfileAndWait, removeRemoteProfileAndWait, sendTab, SYNC_WRITES_CLOSED, sendTargets, setOpenTabsSynced, setProfileSynced, setTypeSynced, syncNow, syncWritesOpen, useSync } from "../sync/engine";
import { confirmRemoveRemoteProfile } from "../sync/remoteProfileRemoval";
import { DATA_TYPES, type DataType, type RemoteProfile } from "../sync/syncDoc";
import { askWhereSeen, shownWindowId } from "./socketAsk";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, TAB } from "./socketSchema";
import { expect, now, profileArg, tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { useBrowser } from "../browser/store";

const TYPES = DATA_TYPES.map((t) => t.id);

export const SETTLE_MS = 3000;

export function settles(check: () => boolean, ms = SETTLE_MS): Promise<boolean> {
  if (check()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      stops.forEach((stop) => stop());
      resolve(ok);
    };
    const timer = setTimeout(() => finish(check()), ms);
    const watch = () => void (check() && finish(true));
    const stops = [useSync.subscribe(watch), useBrowser.subscribe(watch)];
  });
}

function syncing(what: string) {
  const s = useSync.getState();
  if (s.status === "unavailable") throw new OpError("refused", "Sync isn't available in this build of Ardia.");
  if (!s.enabled) throw new OpError("refused", `Sync is off; turn it on in Settings › General before ${what}.`);
  if (s.status === "locked") throw new OpError("refused", "Sync is locked; enter the recovery phrase in Settings › General first.");
  return s;
}

function writable(what: string) {
  const s = syncing(what);
  if (!syncWritesOpen()) throw new OpError("refused", `Sync is ${s.enabled && s.status !== "starting" ? "turning off" : "starting"}; try again once Settings › General shows it running.`);
  return s;
}

const summary = () => {
  const s = useSync.getState();
  return { status: s.status, lastSyncedAt: s.lastSyncedAt, pending: s.pending, error: s.error, types: s.types, profiles: s.profiles };
};

async function runNow(_params: Record<string, unknown>, call: SocketCall) {
  writable("syncing now");
  if (!(await syncNow(() => call.stillServing()))) throw new OpError("refused", "Sync turned off while the last cycle finished, so no new one started.");
  return summary();
}

async function setType(params: Record<string, unknown>) {
  writable("choosing what syncs");
  const type = params.type as DataType;
  setTypeSynced(type, params.on as boolean);
  expect(await settles(() => useSync.getState().types[type] === params.on), `${type} didn't turn ${params.on ? "on" : "off"}.`);
  return summary();
}

function linkOf(profileId: string) {
  const link = writable("choosing which profiles sync").profiles[profileId];
  if (!link) throw new OpError("refused", `Profile ${profileId} isn't linked to sync yet; it links on the next sync after it opens.`);
  return link;
}

async function setProfile(params: Record<string, unknown>) {
  const profileId = profileArg(params.profile);
  linkOf(profileId);
  setProfileSynced(profileId, params.on as boolean);
  expect(await settles(() => !!useSync.getState().profiles[profileId]?.enabled === params.on), `profile ${profileId} didn't turn ${params.on ? "on" : "off"}.`);
  return summary();
}

async function setOpenTabs(params: Record<string, unknown>) {
  const profileId = profileArg(params.profile);
  if (!linkOf(profileId).enabled) throw new OpError("refused", `Profile ${profileId} doesn't sync; turn it on with sync.setProfile first.`);
  if (!useSync.getState().types.tabs) throw new OpError("refused", "Open Tabs don't sync; turn them on with sync.setType first.");
  setOpenTabsSynced(profileId, params.on as boolean);
  expect(await settles(() => !!now().profiles[profileId]?.syncTabs === params.on), `profile ${profileId}'s open tabs didn't turn ${params.on ? "on" : "off"}.`);
  return summary();
}

const remoteRow = (syncId: string) => useSync.getState().remoteProfiles.find((p) => p.syncId === syncId);

function remoteProfileOf(params: Record<string, unknown>, what: string) {
  writable(what);
  const profile = remoteRow(params.syncId as string);
  if (!profile) throw new OpError("no_window", `There's no profile ${String(params.syncId)} on your other devices that isn't on this one (sync.status lists remoteProfiles).`);
  return profile;
}

function refuseUnaddable(profile: RemoteProfile) {
  if (profile.waiting) throw new OpError("refused", `${profile.name} shares data with a profile that hasn't synced yet; try again after the next sync.`);
}

function refuseUnremovable(profile: RemoteProfile) {
  if (profile.sharedByOthers) throw new OpError("refused", `Other profiles share ${profile.name}'s data; remove them first.`);
}

function answered<T>(write: Promise<T>, outcome: string): Promise<T> {
  return write.catch((error: unknown) => {
    if (error instanceof OpError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpError(reason === SYNC_WRITES_CLOSED ? "refused" : "failed", `${outcome}: ${reason}`);
  });
}

function refuseAfterNo(call: SocketCall, what: string, syncId: string, refuse: (row: RemoteProfile) => void) {
  call.stillServing();
  writable(what);
  const row = remoteRow(syncId);
  if (row) refuse(row);
}

async function addRemote(params: Record<string, unknown>, call: SocketCall) {
  const what = "adding a profile from your other devices";
  const profile = remoteProfileOf(params, what);
  refuseUnaddable(profile);
  const added = await answered(addRemoteProfileAndWait(profile.syncId), `${profile.name} wasn't added`);
  if (!added) refuseAfterNo(call, what, profile.syncId, refuseUnaddable);
  expect(!!added, `${profile.name} wasn't added.`);
  await settles(() => !!now().profiles[added!] && !remoteRow(profile.syncId));
  return { profile: added, ...summary() };
}

async function removeRemote(params: Record<string, unknown>, call: SocketCall) {
  const what = "removing a profile from sync";
  const profile = remoteProfileOf(params, what);
  refuseUnremovable(profile);
  const outcome = `${profile.name} wasn't removed from sync`;
  const stillRemovable = () => call.serving() && syncWritesOpen() && !!remoteRow(profile.syncId) && !remoteRow(profile.syncId)!.sharedByOthers;
  const { confirmed, removed } = await answered(confirmRemoveRemoteProfile(profile, { windowId: shownWindowId(), ask: askWhereSeen(outcome, call), mayRemove: stillRemovable, remove: removeRemoteProfileAndWait }), outcome);
  if (!confirmed) return { removed: false, remoteProfiles: useSync.getState().remoteProfiles };
  if (!removed) refuseAfterNo(call, what, profile.syncId, refuseUnremovable);
  expect(removed, `${profile.name} wasn't removed.`);
  await settles(() => !remoteRow(profile.syncId));
  return { removed: true, remoteProfiles: useSync.getState().remoteProfiles.filter((p) => p.syncId !== profile.syncId) };
}

function devicesFor(params: Record<string, unknown>) {
  syncing("listing devices");
  return sendTargets(profileArg(params.profile));
}

function send(params: Record<string, unknown>) {
  writable("sending a tab");
  const tab = tabOf(params.tab);
  if (!/^https?:/i.test(tab.url)) throw new OpError("refused", "Only http and https pages can be sent to another device.");
  const device = sendTargets(tab.profileId).find((d) => d.id === params.device);
  if (!device) throw new OpError("no_window", `There's no device ${String(params.device)} that takes tabs from this profile (sync.devices lists them).`);
  expect(sendTab(tab.id, device.id), "the tab wasn't queued for the device.");
  return { ok: true, device };
}

const ON = bool("On or off");
const SYNC_ID = id("A profile's syncId from sync.status remoteProfiles");

export const SYNC_METHODS: MethodSpec[] = [
  { name: "sync.now", mutates: true, description: "Sync now, as Settings › General › Advanced › Sync Now does; answers when the cycle ends", params: obj({}), result: "{status, lastSyncedAt, pending, error, types, profiles}", run: runNow },
  { name: "sync.setType", mutates: true, description: "Choose whether a kind of data syncs, as the checklist in Settings › General does", params: obj({ type: oneOf(TYPES, "The kind of data"), on: ON }, ["type", "on"]), result: "{status, types, profiles, …}", run: setType },
  { name: "sync.setProfile", mutates: true, description: "Choose whether a profile syncs, as Settings › Profiles › Sync This Profile does", params: obj({ profile: PROFILE, on: ON }, ["profile", "on"]), result: "{status, types, profiles, …}", run: setProfile },
  { name: "sync.setOpenTabs", mutates: true, description: "Sync every open tab of a profile, not just pinned ones", params: obj({ profile: PROFILE, on: ON }, ["profile", "on"]), result: "{status, types, profiles, …}", run: setOpenTabs },
  { name: "sync.addRemoteProfile", mutates: true, description: "Add a profile from your other devices to this one, as Add beside it under Settings › General › Profiles on your other devices does", params: obj({ syncId: SYNC_ID }, ["syncId"]), result: "{profile, status, types, profiles, …}", run: addRemote },
  { name: "sync.removeRemoteProfile", mutates: true, description: "Remove a profile that's only on your other devices from sync, as Remove… beside it under Settings › General › Profiles on your other devices does; Ardia asks the user to confirm first", params: obj({ syncId: SYNC_ID }, ["syncId"]), result: "{removed, remoteProfiles}", run: removeRemote },
  { name: "sync.devices", mutates: false, description: "The devices a profile's tabs can be sent to", params: obj({ profile: PROFILE }), result: "[{id, name, kind}]", run: devicesFor },
  { name: "sync.sendTab", mutates: true, description: "Send a tab to another device, as the tab menu's Send to Device does", params: obj({ tab: TAB, device: id("A device id from sync.devices") }, ["tab", "device"]), result: "{ok, device}", run: send },
];
