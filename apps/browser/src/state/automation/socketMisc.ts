import { engineProfile } from "../browser/model";
import { mediaCommand, useMedia } from "../media/media";
import { useSync } from "../sync/engine";
import { deletePassword, listPasswords } from "../site/passwords";
import { listAddresses, listCards } from "../../platform/autofill";
import { isEligibleTab } from "./automationWindows";
import type { MethodSpec, SocketCall } from "./socketCatalog";
import { obj, oneOf, PROFILE, TAB, text } from "./socketSchema";
import { expect, now, profileArg, tabOf } from "./socketTargets";
import { OpError } from "./workspaceTargets";
import { currentManagerPlugin } from "../site/passwordManager";
import { noteSocketPasswordManagerRefused } from "../telemetry/cliCounts";
import { consentToken } from "../telemetry/client";
import { t } from "../../lib/uiLanguage";


const ACTIONS = ["play", "pause", "toggle", "next", "previous", "seekBy", "seekTo", "stop"] as const;

function mediaList() {
  const m = useMedia.getState();
  const s = now();
  return Object.entries(m.sessions)
    .filter(([tabId]) => isEligibleTab(s, tabId))
    .map(([tabId, session]) => ({
      tab: tabId,
      window: s.tabs[tabId]!.windowId,
      title: session.title,
      artist: session.artist,
      album: session.album,
      state: session.playbackState,
      position: session.position,
      duration: session.duration,
      playbackRate: session.playbackRate,
      pictureInPicture: !!m.pipOpen[tabId],
      playedAt: session.playedAt,
    }));
}

function control(params: Record<string, unknown>) {
  const t = tabOf(params.tab);
  const seeks = params.action === "seekBy" || params.action === "seekTo";
  if (seeks !== (params.seconds !== undefined)) throw new OpError("bad_request", seeks ? `${params.action} needs seconds.` : `${params.action} takes no seconds.`);
  if (params.action === "seekTo" && (params.seconds as number) < 0) throw new OpError("bad_request", t(`seekTo takes a position of 0 seconds or more.`));
  mediaCommand(t.id, params.action as (typeof ACTIONS)[number], params.seconds as number | undefined);
  return { ok: true };
}

function syncStatus() {
  const s = useSync.getState();
  return {
    status: s.status,
    enabled: s.enabled,
    folder: s.folder,
    types: s.types,
    profiles: s.profiles,
    lastSyncedAt: s.lastSyncedAt,
    error: s.error,
    pending: s.pending,
    devices: s.devices,
    remoteProfiles: s.remoteProfiles,
    remoteTabs: s.remoteTabs,
  };
}

const engineOf = (params: Record<string, unknown>) => engineProfile(now(), profileArg(params.profile));

function ardiaKeepsPasswords(params: Record<string, unknown>) {
  const plugin = currentManagerPlugin(profileArg(params.profile));
  if (!plugin) return;
  noteSocketPasswordManagerRefused(consentToken());
  throw new OpError("password_manager_plugin", `This profile's passwords are kept by ${plugin.title}; Ardia's own password store isn't used.`);
}

function passwordsList(params: Record<string, unknown>) {
  ardiaKeepsPasswords(params);
  return listPasswords(engineOf(params));
}

async function autofillList(params: Record<string, unknown>) {
  const engine = engineOf(params);
  const [addresses, cards] = await Promise.all([listAddresses(engine), listCards(engine)]);
  return { addresses, cards: cards.map((c) => ({ id: c.id, name: c.name ?? null, network: c.network, last4: c.last4, expMonth: c.expMonth ?? null, expYear: c.expYear ?? null, created: c.created, modified: c.modified })) };
}

async function removePassword(params: Record<string, unknown>, call: SocketCall) {
  ardiaKeepsPasswords(params);
  const engine = engineOf(params);
  const known = (await listPasswords(engine)).some((p) => p.origin === params.origin && p.username === params.username);
  if (!known) throw new OpError("no_window", t(`There's no saved login with that origin and username.`));
  call.stillServing();
  await deletePassword(engine, params.origin as string, params.username as string);
  expect(!(await listPasswords(engine)).some((p) => p.origin === params.origin && p.username === params.username), t(`the login is still saved.`));
  return { ok: true };
}

export const MISC_METHODS: MethodSpec[] = [
  { name: "media.list", mutates: false, description: t(`Tabs playing or paused media, with what's playing`), params: obj({}), result: t(`[{tab, window, title, artist, state, position, duration, …}]`), run: mediaList },
  {
    name: "media.control",
    mutates: true,
    description: t(`Play, pause, skip or seek a tab's media`),
    params: obj({ tab: TAB, action: oneOf(ACTIONS, t(`What to do`)), seconds: { type: "number", minimum: -86400, maximum: 864000, description: t(`For seekBy (may be negative) and seekTo`) } }, ["tab", "action"]),
    result: "{ok}",
    run: control,
  },
  { name: "sync.status", mutates: false, description: t(`Sync: on or off, its folder, what syncs, devices and their tabs`), params: obj({}), result: t(`{status, enabled, folder, types, profiles, devices, remoteTabs, …}`), run: syncStatus },
  { name: "passwords.list", mutates: false, description: t(`Saved logins: origin and username only, never the password`), params: obj({ profile: PROFILE }), result: t(`[{origin, username, created, modified}]`), run: passwordsList },
  { name: "passwords.remove", mutates: true, description: t(`Delete a saved login`), params: obj({ profile: PROFILE, origin: text(t(`Its origin, as passwords.list gives it`)), username: text(t(`Its username`)) }, ["origin", "username"]), result: "{ok}", run: removePassword },
  { name: "autofill.list", mutates: false, description: t(`Saved addresses, and cards by network, last four digits and expiry, never the number`), params: obj({ profile: PROFILE }), result: t(`{addresses, cards}`), run: autofillList },
];
