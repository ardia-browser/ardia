import { legacyProgramsInstalled, linkPluginPrograms, sweepPluginPrograms, unlinkPluginPrograms, type PluginProgramsResult } from "../../platform/plugins";
import { errorText } from "../../lib/errors";
import { useBrowser } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { warnFor } from "../telemetry/consoleConsent";
import { RESERVED_PROGRAMS } from "./appChecks";
import { settleInstall } from "./installWaiters";
import { writePluginRecords } from "./savedState";
import { activeManifest, currentPlugins, isAlwaysOn, isInstalled, recordOf, usePlugins, type ProgramsState } from "./store";

const requested = new Map<string, string[]>();
let requests = 0;
let sweptAtLaunch = false;

function setPrograms(name: string, state: ProgramsState | null) {
  usePlugins.setState((s) => {
    const programs = { ...s.programs };
    if (state) programs[name] = state;
    else delete programs[name];
    return { programs };
  });
}

function programNames(name: string): string[] {
  return requested.get(name) ?? currentPlugins().listings[name]?.manifest?.programs.map((p) => p.name) ?? [];
}

export function userRefusedControl(): boolean {
  const { settings, settingsMeta } = useBrowser.getState();
  return !settings.cliControl && settingsMeta.chosen.includes("cliControl") && !settingsMeta.inferred.includes("cliControl");
}

function grantControlOnce(name: string, consent: ConsentToken | null) {
  const s = currentPlugins();
  const record = recordOf(s, name);
  if (!activeManifest(s, name)?.permissions.includes("control")) return;
  const { settings, settingsMeta } = useBrowser.getState();
  const userChose = settingsMeta.chosen.includes("cliControl") && !settingsMeta.inferred.includes("cliControl");
  if (record.controlGranted && (settings.cliControl || userChose)) return;
  if (!record.controlGranted) {
    const records = { ...s.records, [name]: { ...record, controlGranted: true } };
    if (!writePluginRecords(records, consent)) return;
    usePlugins.setState({ records });
  }
  if (!settings.cliControl && !userRefusedControl()) useBrowser.getState().updateSettings({ cliControl: true });
}

async function link(name: string, consent?: ConsentToken | null) {
  const s = currentPlugins();
  const listing = s.listings[name]!;
  const manifest = activeManifest(s, name)!;
  const hash = listing.hash!;
  const builtIn = !!listing.bundled;
  const request = ++requests;
  requested.set(name, manifest.programs.map((p) => p.name));
  setPrograms(name, { state: "linking", hash, request });
  const programs = manifest.programs.map((p) => (builtIn && p.afterUpdate.length ? { name: p.name, path: p.path, afterUpdate: p.afterUpdate } : { name: p.name, path: p.path }));
  const adopt = builtIn && manifest.programs.some((p) => RESERVED_PROGRAMS[p.name] === name);
  const result = await linkPluginPrograms({ name, folderId: listing.folderId, approved: hash, version: manifest.version, programs, adopt }).catch(
    (error: unknown): PluginProgramsResult => ({ ok: false, reason: errorText(error) }),
  );
  const now = currentPlugins().programs[name];
  if (now?.state !== "linking" || now.request !== request || (!result.ok && result.stale)) return;
  if (!result.ok) {
    notePlugin("program_link_failures", consent);
    return setPrograms(name, { state: "failed", hash, reason: result.reason ?? "its commands couldn't go on PATH" });
  }
  notePlugin(Object.keys(result.refused).length ? "program_link_failures" : "program_links", consent);
  if (result.adopted) notePlugin("program_adoptions", consent);
  setPrograms(name, { state: "linked", hash, linked: result.linked, refused: result.refused, binDir: result.binDir });
  if (result.linked.length && isAlwaysOn(currentPlugins().listings[name]) && currentPlugins().listings[name]!.manifest!.autoInstall) grantControlOnce(name, consent ?? null);
}

function withdraw(name: string, remove: boolean, consent?: ConsentToken | null): Promise<unknown> {
  const programs = programNames(name);
  requested.delete(name);
  if (currentPlugins().programs[name]) notePlugin("program_unlinks", consent);
  setPrograms(name, null);
  return unlinkPluginPrograms(name, programs, remove).catch((error: unknown) => warnFor(consent ?? null, `[plugins] couldn't take ${name}'s programs off PATH`, error));
}

function sweepAtLaunch() {
  const s = currentPlugins();
  if (sweptAtLaunch || !s.loaded) return;
  sweptAtLaunch = true;
  void sweepPluginPrograms(s.order.filter((name) => activeManifest(s, name)?.programs.length)).catch(() => {});
}

export function reconcilePrograms(consent?: ConsentToken | null) {
  sweepAtLaunch();
  keepControlWhileInstalled();
  const s = currentPlugins();
  for (const name of s.order) {
    const manifest = activeManifest(s, name);
    if (!manifest?.programs.length) continue;
    const now = s.programs[name];
    if (now && now.hash === s.listings[name]!.hash) continue;
    void link(name, consent);
  }
  for (const name of Object.keys(s.programs)) if (!activeManifest(s, name)?.programs.length) void withdraw(name, false, consent);
}

export const canRelink = (state: ProgramsState | undefined) => state?.state === "failed" || (state?.state === "linked" && Object.keys(state.refused).length > 0);

export function relinkPrograms(name: string) {
  if (!canRelink(currentPlugins().programs[name])) return;
  setPrograms(name, null);
  reconcilePrograms(consentToken());
}

let adoptionChecked = false;
let controlKept = false;

export const ADOPT_WITH_CONTROL_OFF = false;

const asksControl = (name: string) => !!currentPlugins().listings[name]?.manifest?.permissions.includes("control");

function keepControlWhileInstalled() {
  const s = currentPlugins();
  if (controlKept || !s.loaded) return;
  controlKept = true;
  if (useBrowser.getState().settings.cliControl) return;
  if (s.order.some((name) => isAlwaysOn(s.listings[name]) && isInstalled(s, name) && asksControl(name))) useBrowser.getState().updateSettings({ cliControl: true });
}

const ownsReservedProgram = (name: string) => !!currentPlugins().listings[name]?.manifest?.programs.some((p) => RESERVED_PROGRAMS[p.name] === name);

export const olderProgramsInstalled = () => legacyProgramsInstalled().catch(() => false);

export async function adoptLegacyInstalls(consent: ConsentToken | null): Promise<boolean> {
  const s = currentPlugins();
  if (adoptionChecked || !s.order.length) return false;
  adoptionChecked = true;
  const owners = s.order.filter((name) => isAlwaysOn(s.listings[name]) && !isInstalled(s, name) && ownsReservedProgram(name));
  if (!owners.length || !(await legacyProgramsInstalled().catch(() => false))) return false;
  let adopted = false;
  for (const name of owners) {
    const now = currentPlugins();
    const listing = now.listings[name];
    if (!listing?.hash || !isAlwaysOn(listing) || isInstalled(now, name)) continue;
    const controlOff = asksControl(name) && !useBrowser.getState().settings.cliControl;
    if (controlOff && !ADOPT_WITH_CONTROL_OFF) {
      notePlugin("plugin_adoptions_waiting", consent);
      continue;
    }
    const records = { ...now.records, [name]: { ...recordOf(now, name), enabled: true, approved: listing.hash, installed: true } };
    if (!writePluginRecords(records, consent)) continue;
    usePlugins.setState((s) => ({ records, consent: s.consent?.name === name ? null : s.consent }));
    settleInstall(name, { ok: true });
    if (controlOff) useBrowser.getState().updateSettings({ cliControl: true });
    notePlugin("plugin_adoptions", consent);
    adopted = true;
  }
  return adopted;
}

export const removePrograms = (name: string, consent?: ConsentToken | null) => withdraw(name, true, consent);
