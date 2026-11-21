import { linkPluginPrograms, sweepPluginPrograms, unlinkPluginPrograms, type PluginProgramsResult } from "../../platform/plugins";
import { errorText } from "../../lib/errors";
import { useBrowser } from "../browser/store";
import { notePlugin } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { warnFor } from "../telemetry/consoleConsent";
import { programControlOn, setProgramControl, userChoseControl, userTurnedControlOff } from "../app/programControlSetting";
import { settleInstall } from "./installWaiters";
import { programsBlocked, refreshLegacyInstalls, REGISTRY_UNREADABLE } from "./programRegistry";
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

export const userRefusedControl = userTurnedControlOff;

function grantControlOnce(name: string, consent: ConsentToken | null) {
  const s = currentPlugins();
  const record = recordOf(s, name);
  if (!activeManifest(s, name)?.permissions.control) return;
  const on = programControlOn(useBrowser.getState());
  if (record.controlGranted && (on || userChoseControl())) return;
  if (!record.controlGranted) {
    const records = { ...s.records, [name]: { ...record, controlGranted: true } };
    if (!writePluginRecords(records, consent)) return;
    usePlugins.setState({ records });
  }
  if (!on && !userRefusedControl()) setProgramControl(true);
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
  if (programsBlocked()) {
    notePlugin("program_link_failures", consent);
    setPrograms(name, { state: "failed", hash, reason: REGISTRY_UNREADABLE });
    return adoptionLinked(name, { ok: false, reason: `Not on your PATH: ${REGISTRY_UNREADABLE}` });
  }
  const result = await linkPluginPrograms({ name, folderId: listing.folderId, approved: hash, version: manifest.version, programs }).catch(
    (error: unknown): PluginProgramsResult => ({ ok: false, reason: errorText(error) }),
  );
  const now = currentPlugins().programs[name];
  if (now?.state !== "linking" || now.request !== request || (!result.ok && result.stale)) return;
  if (!result.ok) {
    notePlugin("program_link_failures", consent);
    setPrograms(name, { state: "failed", hash, reason: result.reason ?? "its commands couldn't go on PATH" });
    return adoptionLinked(name, { ok: false, reason: `Not on your PATH: ${result.reason ?? "its commands couldn't go on PATH"}` });
  }
  notePlugin(Object.keys(result.refused).length ? "program_link_failures" : "program_links", consent);
  const adoption = adoptionOf(result);
  if (adoption === "adopted") notePlugin("program_adoptions", consent);
  const pending = adoption === "busy" ? retryAdoption(name, consent ?? null) : adoption === "failed" ? "failed" : undefined;
  if (adoption !== "busy") adoptionRetries.delete(name);
  setPrograms(name, { state: "linked", hash, linked: result.linked, refused: result.refused, binDir: result.binDir, ...(pending ? { adoption: pending } : {}) });
  if (pending === "retrying") return;
  if (pending === "busy") adoptionLinked(name, { ok: false, reason: "Installed, but the old install is busy updating. Try again in a moment." });
  else if (pending === "failed") adoptionLinked(name, { ok: false, reason: "Installed, but the old install couldn't be switched over to it." });
  else if (result.linked.length) adoptionLinked(name, { ok: true }, adoption === "adopted" || adoption === "already");
  else adoptionLinked(name, { ok: false, reason: `Not on your PATH: ${Object.values(result.refused)[0] ?? "nothing was linked"}` });
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

export const canRelink = (state: ProgramsState | undefined) =>
  state?.state === "failed" || (state?.state === "linked" && (Object.keys(state.refused).length > 0 || state.adoption === "busy" || state.adoption === "failed"));

export function relinkPrograms(name: string) {
  if (!canRelink(currentPlugins().programs[name])) return;
  setPrograms(name, null);
  reconcilePrograms(consentToken());
}

let adoptionChecked = false;

export const ADOPT_WITH_CONTROL_OFF = false;
export const ADOPTION_RETRY = { delayMs: 5000, tries: 6 };

const adopting = new Map<string, { consent: ConsentToken | null }>();

const asksControl = (name: string) => !!currentPlugins().listings[name]?.manifest?.permissions.control;

type AdoptionOutcome = "adopted" | "already" | "failed" | "busy" | "none";

function adoptionOf(result: { adopted?: boolean; adoptBusy?: boolean; adoption?: string }): AdoptionOutcome {
  if (result.adoption === "adopted" || result.adoption === "already" || result.adoption === "failed" || result.adoption === "busy" || result.adoption === "none") return result.adoption;
  return result.adoptBusy ? "busy" : result.adopted ? "adopted" : "none";
}

const adoptionRetries = new Map<string, number>();

function adoptionLinked(name: string, outcome: { ok: true } | { ok: false; reason: string }, confirmed = false) {
  const adoption = adopting.get(name);
  if (!adoption) return;
  adopting.delete(name);
  if (outcome.ok && confirmed) notePlugin("plugin_adoptions", adoption.consent);
  settleInstall(name, outcome);
}

function retryAdoption(name: string, consent: ConsentToken | null): "retrying" | "busy" {
  const tries = adoptionRetries.get(name) ?? 0;
  if (tries >= ADOPTION_RETRY.tries) {
    adoptionRetries.delete(name);
    return "busy";
  }
  adoptionRetries.set(name, tries + 1);
  setTimeout(() => {
    const now = currentPlugins().programs[name];
    if (now?.state !== "linked" || now.adoption !== "retrying") return;
    setPrograms(name, null);
    reconcilePrograms(adopting.get(name)?.consent ?? consent);
  }, ADOPTION_RETRY.delayMs);
  return "retrying";
}

export function resetAdoptionForTests() {
  adoptionChecked = false;
}

export async function adoptLegacyInstalls(consent: ConsentToken | null): Promise<boolean> {
  const s = currentPlugins();
  if (adoptionChecked || !s.order.length) return false;
  adoptionChecked = true;
  const found = await refreshLegacyInstalls();
  const owners = (Array.isArray(found) ? found : []).filter((name) => {
    const listing = currentPlugins().listings[name];
    return !!listing?.bundled && isAlwaysOn(listing) && !isInstalled(currentPlugins(), name);
  });
  let adopted = false;
  for (const name of owners) {
    const now = currentPlugins();
    const listing = now.listings[name];
    if (!listing?.hash || !isAlwaysOn(listing) || isInstalled(now, name)) continue;
    const controlOff = asksControl(name) && !programControlOn(useBrowser.getState());
    if (controlOff && (!ADOPT_WITH_CONTROL_OFF || userRefusedControl())) {
      notePlugin("plugin_adoptions_waiting", consent);
      continue;
    }
    const records = { ...now.records, [name]: { ...recordOf(now, name), enabled: true, approved: listing.hash, installed: true } };
    if (!writePluginRecords(records, consent)) continue;
    adopting.set(name, { consent });
    usePlugins.setState((s) => ({ records, consent: s.consent?.name === name ? null : s.consent }));
    if (controlOff) setProgramControl(true);
    adopted = true;
  }
  return adopted;
}

export type OwnProgramsStatus = { state: "none" | "linking" | "linked" | "failed"; linked: string[]; failed: { name: string; reason: string }[]; binDir: string | null };

export function programsStatus(name: string): OwnProgramsStatus {
  const s = currentPlugins();
  const names = activeManifest(s, name)?.programs.map((p) => p.name) ?? [];
  if (!names.length) return { state: "none", linked: [], failed: [], binDir: null };
  const now = s.programs[name];
  if (!now || now.state === "linking" || now.hash !== s.listings[name]?.hash) return { state: "linking", linked: [], failed: [], binDir: null };
  if (now.state === "failed") return { state: "failed", linked: [], failed: names.map((program) => ({ name: program, reason: now.reason })), binDir: null };
  const failed = Object.entries(now.refused).map(([program, reason]) => ({ name: program, reason }));
  return { state: failed.length ? "failed" : "linked", linked: [...now.linked], failed, binDir: now.binDir };
}

export function relinkOwnPrograms(name: string): { ok: true } | { ok: false; reason: string } {
  const s = currentPlugins();
  if (!activeManifest(s, name)?.programs.length) return { ok: false, reason: "This plugin has no programs." };
  if (s.programs[name]?.state === "linking") return { ok: false, reason: "Its programs are being put on PATH now." };
  setPrograms(name, null);
  reconcilePrograms(consentToken());
  return { ok: true };
}

export const removePrograms = (name: string, consent?: ConsentToken | null) => withdraw(name, true, consent);
