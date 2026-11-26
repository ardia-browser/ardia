import { linkPluginPrograms, setAfterUpdateQuitConsent, sweepPluginPrograms, takeAfterUpdateQuitStops, unlinkPluginPrograms, type PluginProgramsResult } from "../../platform/plugins";
import { errorText } from "../../lib/errors";
import { notePlugin, notePluginTimes, programLinkCause } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { onConsentPeriodChange } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { programsBlocked, refreshLegacyInstalls, REGISTRY_UNREADABLE } from "./programRegistry";
import { activeManifest, currentPlugins, usePlugins, type ProgramsState } from "./store";

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

async function link(name: string, consent?: ConsentToken | null) {
  const s = currentPlugins();
  const listing = s.listings[name]!;
  const manifest = activeManifest(s, name)!;
  const hash = listing.hash!;
  const builtIn = !!listing.official && !listing.legacy;
  const request = ++requests;
  requested.set(name, manifest.programs.map((p) => p.name));
  setPrograms(name, { state: "linking", hash, request });
  const programs = manifest.programs.map((p) => (builtIn && p.afterUpdate.length ? { name: p.name, path: p.path, afterUpdate: p.afterUpdate } : { name: p.name, path: p.path }));
  if (programsBlocked()) {
    notePlugin("program_link_failures", consent);
    setPrograms(name, { state: "failed", hash, reason: REGISTRY_UNREADABLE });
    return;
  }
  const result = await linkPluginPrograms({ name, folderId: listing.folderId, approved: hash, version: manifest.version, programs }).catch(
    (error: unknown): PluginProgramsResult => ({ ok: false, reason: errorText(error) }),
  );
  const now = currentPlugins().programs[name];
  if (now?.state !== "linking" || now.request !== request || (!result.ok && result.stale)) return;
  if (!result.ok) {
    notePlugin("program_link_failures", consent);
    notePlugin(programLinkCause(null), consent);
    setPrograms(name, { state: "failed", hash, reason: result.reason ?? "its commands couldn't go on PATH" });
    return;
  }
  notePlugin(Object.keys(result.refused).length ? "program_link_failures" : "program_links", consent);
  for (const program of Object.keys(result.refused)) notePlugin(programLinkCause(result.causes?.[program]), consent);
  if (result.kept && Object.keys(result.refused).length) notePlugin("program_links_kept", consent);
  const adoption = adoptionOf(result);
  if (adoption === "adopted") notePlugin("program_adoptions", consent);
  const pending = adoption === "busy" ? retryAdoption(name, consent ?? null) : adoption === "failed" ? "failed" : undefined;
  if (adoption !== "busy") adoptionRetries.delete(name);
  setPrograms(name, { state: "linked", hash, linked: result.linked, refused: result.refused, binDir: result.binDir, ...(pending ? { adoption: pending } : {}) });
}

function withdraw(name: string, remove: boolean, consent?: ConsentToken | null): Promise<unknown> {
  const programs = programNames(name);
  requested.delete(name);
  if (currentPlugins().programs[name]) notePlugin("program_unlinks", consent);
  setPrograms(name, null);
  return unlinkPluginPrograms(name, programs, remove).catch((error: unknown) => warnFor(consent ?? null, `[plugins] couldn't take ${name}'s programs off PATH`, error));
}

export const programsKeptAtLaunch = (s: Pick<ReturnType<typeof currentPlugins>, "order" | "listings" | "records">): string[] =>
  s.order.filter((name) => activeManifest(s, name)?.programs.length).sort();

function sweepAtLaunch(consent: ConsentToken | null) {
  const s = currentPlugins();
  if (sweptAtLaunch || !s.loaded) return;
  sweptAtLaunch = true;
  void sweepPluginPrograms(programsKeptAtLaunch(s)).catch(() => {});
  void countAfterUpdateQuitStops(consent);
  tellQuitStopsConsent();
  onConsentPeriodChange(tellQuitStopsConsent);
}

function tellQuitStopsConsent() {
  try {
    setAfterUpdateQuitConsent(consentToken() ?? "");
  } catch {}
}

async function countAfterUpdateQuitStops(consent: ConsentToken | null) {
  const stops = await Promise.resolve()
    .then(takeAfterUpdateQuitStops)
    .catch(() => null);
  if (!stops || !consent || stops.consent !== consent) return;
  notePluginTimes("program_after_update_quit_exits", stops.exitedOnTerm, consent);
  notePluginTimes("program_after_update_quit_kills", stops.killed, consent);
}

export function reconcilePrograms(consent?: ConsentToken | null) {
  sweepAtLaunch(consent ?? null);
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

export const ADOPTION_RETRY = { delayMs: 5000, tries: 6 };

type AdoptionOutcome = "adopted" | "already" | "failed" | "busy" | "none";

function adoptionOf(result: { adopted?: boolean; adoptBusy?: boolean; adoption?: string }): AdoptionOutcome {
  if (result.adoption === "adopted" || result.adoption === "already" || result.adoption === "failed" || result.adoption === "busy" || result.adoption === "none") return result.adoption;
  return result.adoptBusy ? "busy" : result.adopted ? "adopted" : "none";
}

const adoptionRetries = new Map<string, number>();

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
    reconcilePrograms(consent);
  }, ADOPTION_RETRY.delayMs);
  return "retrying";
}

export async function adoptLegacyInstalls(consent: ConsentToken | null): Promise<boolean> {
  const s = currentPlugins();
  if (adoptionChecked || !s.order.length) return false;
  adoptionChecked = true;
  const found = await refreshLegacyInstalls();
  for (const name of Array.isArray(found) ? found : []) {
    if (!activeManifest(currentPlugins(), name)) notePlugin("plugin_adoptions_waiting", consent);
  }
  return false;
}

type OwnProgramsStatus = { state: "none" | "linking" | "linked" | "failed"; linked: string[]; failed: { name: string; reason: string }[]; binDir: string | null };

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
