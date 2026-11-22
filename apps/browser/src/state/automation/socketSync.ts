import { sendTab, sendTargets, setOpenTabsSynced, setProfileSynced, setTypeSynced, syncNow, syncWritesOpen, useSync } from "../sync/engine";
import { DATA_TYPES, type DataType } from "../sync/syncDoc";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { bool, id, obj, oneOf, PROFILE, TAB } from "./socketSchema";
import { expect, now, profileArg, tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { useBrowser } from "../browser/store";
import { t } from "../../lib/uiLanguage";


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
  if (s.status === "unavailable") throw new OpError("refused", t(`Sync isn't available in this build of Ardia.`));
  if (!s.enabled) throw new OpError("refused", `Sync is off; turn it on in Settings › General before ${what}.`);
  if (s.status === "locked") throw new OpError("refused", t(`Sync is locked; enter the recovery phrase in Settings › General first.`));
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
  writable(t(`syncing now`));
  if (!(await syncNow(() => call.stillServing()))) throw new OpError("refused", t(`Sync turned off while the last cycle finished, so no new one started.`));
  return summary();
}

async function setType(params: Record<string, unknown>) {
  writable(t(`choosing what syncs`));
  const type = params.type as DataType;
  setTypeSynced(type, params.on as boolean);
  expect(await settles(() => useSync.getState().types[type] === params.on), `${type} didn't turn ${params.on ? "on" : "off"}.`);
  return summary();
}

function linkOf(profileId: string) {
  const link = writable(t(`choosing which profiles sync`)).profiles[profileId];
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
  if (!useSync.getState().types.tabs) throw new OpError("refused", t(`Open Tabs don't sync; turn them on with sync.setType first.`));
  setOpenTabsSynced(profileId, params.on as boolean);
  expect(await settles(() => !!now().profiles[profileId]?.syncTabs === params.on), `profile ${profileId}'s open tabs didn't turn ${params.on ? "on" : "off"}.`);
  return summary();
}

function devicesFor(params: Record<string, unknown>) {
  syncing(t(`listing devices`));
  return sendTargets(profileArg(params.profile));
}

function send(params: Record<string, unknown>) {
  writable(t(`sending a tab`));
  const tab = tabOf(params.tab);
  if (!/^https?:/i.test(tab.url)) throw new OpError("refused", t(`Only http and https pages can be sent to another device.`));
  const device = sendTargets(tab.profileId).find((d) => d.id === params.device);
  if (!device) throw new OpError("no_window", `There's no device ${String(params.device)} that takes tabs from this profile (sync.devices lists them).`);
  expect(sendTab(tab.id, device.id), t(`the tab wasn't queued for the device.`));
  return { ok: true, device };
}

const ON = bool(t(`On or off`));

export const SYNC_METHODS: MethodSpec[] = [
  { name: "sync.now", mutates: true, description: t(`Sync now, as Settings › General › Advanced › Sync Now does; answers when the cycle ends`), params: obj({}), result: t(`{status, lastSyncedAt, pending, error, types, profiles}`), run: runNow },
  { name: "sync.setType", mutates: true, description: t(`Choose whether a kind of data syncs, as the checklist in Settings › General does`), params: obj({ type: oneOf(TYPES, t(`The kind of data`)), on: ON }, ["type", "on"]), result: t(`{status, types, profiles, …}`), run: setType },
  { name: "sync.setProfile", mutates: true, description: t(`Choose whether a profile syncs, as Settings › Profiles › Sync This Profile does`), params: obj({ profile: PROFILE, on: ON }, ["profile", "on"]), result: t(`{status, types, profiles, …}`), run: setProfile },
  { name: "sync.setOpenTabs", mutates: true, description: t(`Sync every open tab of a profile, not just pinned ones`), params: obj({ profile: PROFILE, on: ON }, ["profile", "on"]), result: t(`{status, types, profiles, …}`), run: setOpenTabs },
  { name: "sync.devices", mutates: false, description: t(`The devices a profile's tabs can be sent to`), params: obj({ profile: PROFILE }), result: t(`[{id, name, kind}]`), run: devicesFor },
  { name: "sync.sendTab", mutates: true, description: t(`Send a tab to another device, as the tab menu's Send to Device does`), params: obj({ tab: TAB, device: id(t(`A device id from sync.devices`)) }, ["tab", "device"]), result: t(`{ok, device}`), run: send },
];
