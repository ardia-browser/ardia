import { useMemo } from "react";
import { COMING_SOON, OFFICIAL_CATALOGUE, OFFICIAL_EXAMPLES } from "./officialPin";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_TERMS } from "../../lib/platformTerms";
import { experimentOn } from "../../platform/killSwitches";
import { cancelOfficialPluginFetch, fetchOfficialPlugin, onOfficialFetchProgress, type OfficialFetchResult } from "../../platform/plugins";
import { notePlugin, type PluginCount } from "../telemetry/pluginCounts";
import { updateWithin, type UpdatePromptReason, type UpdateVerdict } from "./officialUpdate";
import { MAX_UPDATE_LINES } from "./savedState";
import { consentToken, type ConsentToken } from "../telemetry/consentPeriod";
import { warnFor } from "../telemetry/consoleConsent";
import { openSettings } from "../settings/settingsWindows";
import { waitForInstall, type InstallResult } from "./installWaiters";
import { releaseOrphanedConsent } from "./consentSurface";
import { afterPluginScan } from "./scanListeners";
import { adoptExactApproval, ALREADY_ASKING, consentTarget, isRemoving, updateRecord, promoteCandidate, requestPluginConsent, rescanPlugins } from "./lifecycle";
import { relinkPrograms } from "./programs";
import { activeManifest, approvalMatches, currentPlugins, recordOf, setOfficialFetch, usePlugins, type PluginListing, type PluginsStore } from "./store";
import { ownValue } from "../../lib/decode";

export { COMING_SOON, OFFICIAL_CATALOGUE, PRESELECTED_PLUGINS, officialCatalogue } from "./officialPin";

type OfficialPluginState = "available" | "installed" | "comingSoon" | "unsupported";
export type OfficialPlugin = { name: string; title: string; blurb: string; icon: string; version: string | null; example: string | null; state: OfficialPluginState; update: string | null };
type ComingSoon = (typeof COMING_SOON)[number];
type OfficialView = Pick<PluginsStore, "listings" | "records" | "order"> & Partial<Pick<PluginsStore, "pinned" | "candidates">>;

const officialListing = (s: Pick<PluginsStore, "listings">, name: string): PluginListing | undefined => {
  const listing = ownValue(s.listings, name);
  return listing?.official && listing.manifest?.official ? listing : undefined;
};

const pinnedOf = (s: Partial<Pick<PluginsStore, "pinned">>, name: string) => s.pinned?.find((p) => p.name === name);

const candidateOf = (s: Partial<Pick<PluginsStore, "candidates">>, name: string): PluginListing | undefined =>
  ownValue(s.candidates, name);

const installedOf = (s: Pick<PluginsStore, "listings" | "records">, listing: PluginListing): boolean => !!activeManifest(s, listing.name);

export function officialPlugins(
  s: OfficialView,
  supported: boolean = PLATFORM_FEATURES.plugins,
  showComingSoon: (experiment: ComingSoon["experiment"]) => boolean = experimentOn,
): OfficialPlugin[] {
  const listed = [...s.order.filter((name) => officialListing(s, name)), ...(s.pinned ?? []).map((p) => p.name)].map((name) => ({ name, title: "", blurb: "", icon: "" }));
  const entries = [...OFFICIAL_CATALOGUE];
  for (const extra of listed) if (!entries.some((e) => e.name === extra.name)) entries.push(extra);
  const out: OfficialPlugin[] = entries.map((entry) => {
    const listing = officialListing(s, entry.name);
    const pinned = pinnedOf(s, entry.name);
    const candidate = candidateOf(s, entry.name);
    const m = listing?.manifest ?? candidate?.manifest;
    const offered = !!listing || !!pinned;
    const shown = {
      name: entry.name,
      title: m?.title ?? entry.title,
      blurb: m?.description || entry.blurb,
      icon: m?.icon ?? m?.page?.icon ?? (entry.icon || "puzzlepiece"),
      version: m?.version ?? pinned?.version ?? null,
      example: m?.programs.find((p) => p.example)?.example ?? (offered && Object.hasOwn(OFFICIAL_EXAMPLES, entry.name) ? OFFICIAL_EXAMPLES[entry.name]! : null),
      update: null as string | null,
    };
    if (!supported || !offered) return { ...shown, state: "unsupported" };
    if (!listing || !installedOf(s, listing)) return { ...shown, state: "available" };
    const update = candidate?.manifest && candidate.hash !== listing.hash ? candidate.manifest.version : null;
    return { ...shown, update, state: "installed" };
  });
  for (const soon of COMING_SOON) {
    if (!showComingSoon(soon.experiment) || out.some((o) => o.name === soon.name)) continue;
    out.push({ name: soon.name, title: soon.title, blurb: soon.blurb, icon: soon.icon, version: null, example: null, state: supported ? "comingSoon" : "unsupported", update: null });
  }
  return out;
}

export function officialKeywords(s: Pick<PluginsStore, "listings" | "order">): Record<string, string[]> {
  return Object.fromEntries(s.order.flatMap((name) => {
    const keywords = officialListing(s, name)?.manifest?.keywords ?? [];
    return keywords.length ? [[`plugins.${name}`, keywords]] : [];
  }));
}

export function useOfficialPlugins(): OfficialPlugin[] {
  const key = usePlugins((s) => JSON.stringify(officialPlugins(s)));
  return useMemo(() => JSON.parse(key) as OfficialPlugin[], [key]);
}

function linkOutcome(name: string): InstallResult | null {
  const s = currentPlugins();
  const fetch = ownValue(s.fetches, name);
  if (fetch?.state === "promoting") return null;
  if (fetch?.state === "failed") return { ok: false, reason: `Couldn't switch to the download: ${fetch.reason}` };
  const manifest = activeManifest(s, name);
  if (!manifest) return { ok: false, reason: "It changed while installing. Try again." };
  if (!manifest.programs.length) return { ok: true };
  const programs = s.programs[name];
  if (!programs || programs.state === "linking" || programs.hash !== s.listings[name]?.hash) return null;
  if (programs.state === "failed") return { ok: false, reason: `Installed, but not on your PATH: ${programs.reason}` };
  if (programs.adoption === "retrying") return null;
  if (programs.adoption === "busy") return { ok: false, reason: "Installed, but the old install is busy updating. Try again in a moment." };
  if (programs.adoption === "failed") return { ok: false, reason: "Installed, but the old install couldn't be switched over to it." };
  const refused = Object.values(programs.refused);
  return refused.length ? { ok: false, reason: `Installed, but ${refused[0]}` } : { ok: true };
}

function linked(name: string): Promise<InstallResult> {
  return new Promise((resolve) => {
    const now = linkOutcome(name);
    if (now) return resolve(now);
    const stop = usePlugins.subscribe(() => {
      const outcome = linkOutcome(name);
      if (!outcome) return;
      stop();
      resolve(outcome);
    });
  });
}

export const FETCH_REASONS: Record<Exclude<OfficialFetchResult, { ok: true }>["code"], string> = {
  offline: "Couldn't download it. Check your internet connection, then try again.",
  failed: "Couldn't download it. Try again.",
  verify: "The download didn't match the copy this version of Ardia trusts, so it wasn't installed.",
  cancelled: "Cancelled.",
  unsupported: `Not available in this version of Ardia.`,
};

let progressWatched = false;

function watchProgress() {
  if (progressWatched) return;
  progressWatched = true;
  try {
    onOfficialFetchProgress((e) => {
      const now = currentPlugins().fetches[e.name];
      if (now?.state === "fetching") setOfficialFetch(e.name, { state: "fetching", received: e.received, total: e.total });
    });
  } catch {
    progressWatched = false;
  }
}

const inFlight = new Map<string, Promise<InstallResult & { code?: string }>>();

function needsFetch(name: string): boolean {
  const s = currentPlugins();
  const pinned = pinnedOf(s, name);
  if (!pinned) return false;
  if (candidateOf(s, name)?.folderId === pinned.folderId) return false;
  return officialListing(s, name)?.folderId !== pinned.folderId;
}

function fetchOfficialCandidate(name: string, consent: ConsentToken | null, quiet = false): Promise<InstallResult & { code?: string }> {
  if (!needsFetch(name)) return Promise.resolve({ ok: true });
  const running = inFlight.get(name);
  if (running) return running;
  watchProgress();
  if (!quiet) setOfficialFetch(name, { state: "fetching", received: 0, total: 0 });
  notePlugin("official_fetches", consent);
  const task = fetchOfficialPlugin(name)
    .catch((error: unknown): OfficialFetchResult => ({ ok: false, code: "failed", reason: String(error) }))
    .then(async (result): Promise<InstallResult & { code?: string }> => {
      if (!result.ok) {
        notePlugin(result.code === "offline" ? "official_fetch_offline" : result.code === "verify" ? "official_verify_failures" : "official_fetch_failures", consent);
        warnFor(consent, `[plugins] ${name} wasn't downloaded (${result.code}): ${result.reason}`);
        const reason = FETCH_REASONS[result.code];
        if (!quiet) setOfficialFetch(name, result.code === "cancelled" ? null : { state: "failed", code: result.code, reason });
        return result.code === "cancelled" ? { ok: false, reason, cancelled: true, code: result.code } : { ok: false, reason, code: result.code };
      }
      await rescanPlugins(consent);
      if (!quiet) setOfficialFetch(name, null);
      return { ok: true };
    })
    .finally(() => inFlight.delete(name));
  inFlight.set(name, task);
  return task;
}

export function cancelOfficialInstall(name: string) {
  if (inFlight.has(name)) cancelOfficialPluginFetch(name);
}

type InstallOptions = { showSheet?: boolean; onConsent?: (id: number) => void; alive?: () => boolean };

export const isOfficialName = (s: Pick<PluginsStore, "listings" | "candidates" | "pinned">, name: string) =>
  !!officialListing(s, name) || !!candidateOf(s, name) || !!pinnedOf(s, name);

export function installOfficialPlugin(name: string, options: InstallOptions = {}): Promise<InstallResult> {
  if (!PLATFORM_FEATURES.plugins) return Promise.resolve({ ok: false, reason: `Not available on ${PLATFORM_TERMS.os} yet.` });
  const plugin = officialPlugins(currentPlugins()).find((p) => p.name === name);
  if (!plugin || plugin.state === "unsupported" || plugin.state === "comingSoon") return Promise.resolve({ ok: false, reason: "Not an official plugin." });
  if (plugin.state === "installed" && !plugin.update) {
    relinkPrograms(name);
    return linked(name);
  }
  releaseOrphanedConsent();
  if (currentPlugins().consent) return Promise.resolve({ ok: false, reason: ALREADY_ASKING });
  const approvedCandidate = candidateOf(currentPlugins(), name);
  const record = ownValue(currentPlugins().records, name);
  if (approvedCandidate?.hash && record?.enabled && approvalMatches(approvedCandidate, record.approved)) {
    if (currentPlugins().fetches[name]?.state === "promoting") return linked(name);
    const consent = consentToken();
    return promoteCandidate(name, approvedCandidate, consent).then((ok) => {
      if (ok) noteAutoUpdate(name, approvedCandidate, consent);
      return linked(name);
    });
  }
  if (!needsFetch(name)) return askToInstall(name, options);
  return fetchOfficialCandidate(name, consentToken()).then((fetched) => {
    if (!fetched.ok) return fetched;
    if (options.alive && !options.alive()) return { ok: false, reason: "Cancelled.", cancelled: true };
    return askToInstall(name, options);
  });
}

function askToInstall(name: string, options: InstallOptions): Promise<InstallResult> {
  releaseOrphanedConsent();
  if (currentPlugins().consent) return Promise.resolve({ ok: false, reason: ALREADY_ASKING });
  const target = consentTarget(name, true);
  if (!target?.manifest || !target.hash) {
    const listing = candidateOf(currentPlugins(), name) ?? currentPlugins().listings[name];
    return Promise.resolve({ ok: false, reason: listing?.problems[0] ?? "It can't load." });
  }
  if (!requestPluginConsent(name, true)) return Promise.resolve({ ok: false, reason: "Can't install it right now." });
  options.onConsent?.(currentPlugins().consent!.id);
  const done = waitForInstall(name);
  if (options.showSheet !== false) openSettings("plugins", null, name);
  return done.then((result) => (result.ok ? linked(name) : result));
}

const retryAt = new Map<string, { at: number; wait: number }>();
const FIRST_RETRY_MS = 10 * 60 * 1000;
const LAST_RETRY_MS = 6 * 60 * 60 * 1000;
const waitingNoted = new Set<string>();
const autoNoted = new Set<string>();

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function retryLater(key: string, wait: number, consent: ConsentToken | null) {
  const earlier = retryTimers.get(key);
  if (earlier) clearTimeout(earlier);
  const timer = setTimeout(() => {
    retryTimers.delete(key);
    reconcileOfficial(consent);
  }, wait + 1000);
  (timer as { unref?: () => void }).unref?.();
  retryTimers.set(key, timer);
}

export const pendingOfficialRetries = () => [...retryTimers.keys()];

export function resetOfficialUpdatesForTests() {
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  retryAt.clear();
  waitingNoted.clear();
  autoNoted.clear();
  inFlight.clear();
}

const PROMPT_COUNTS: Record<UpdatePromptReason, PluginCount> = {
  baseline: "official_update_prompts_baseline",
  permissions: "official_update_prompts_permissions",
  network: "official_update_prompts_network",
  runtime: "official_update_prompts_runtime",
  activation: "official_update_prompts_activation",
  programs: "official_update_prompts_programs",
  hooks: "official_update_prompts_hooks",
  settings: "official_update_prompts_settings",
  contributions: "official_update_prompts_contributions",
  unknown: "official_update_prompts_unknown",
};

export function officialUpdateVerdict(s: Pick<PluginsStore, "listings" | "records" | "pinned">, name: string, candidate: PluginListing): UpdateVerdict {
  const pinned = pinnedOf(s, name);
  const record = ownValue(s.records, name);
  const listing = ownValue(s.listings, name);
  const baseline = listing?.manifest;
  const next = candidate.manifest;
  if (!pinned || !record?.enabled || !record.approved || !listing?.official || !baseline?.official || !listing.hash) return { ok: false, reason: "baseline" };
  if (listing.hash !== record.approved && listing.legacyHash !== record.approved) return { ok: false, reason: "baseline" };
  if (!candidate.official || !next?.official || !candidate.hash || candidate.problems.length || candidate.folderId !== pinned.folderId) return { ok: false, reason: "baseline" };
  if (candidate.name !== name || next.name !== name || baseline.name !== name || candidate.hash === listing.hash) return { ok: false, reason: "baseline" };
  return updateWithin(baseline, next, Object.hasOwn(OFFICIAL_EXAMPLES, name) ? OFFICIAL_EXAMPLES[name]! : null);
}

function noteAutoUpdate(name: string, candidate: PluginListing, consent: ConsentToken | null) {
  const record = recordOf(currentPlugins(), name);
  if (!candidate.hash || autoNoted.has(candidate.hash) || !record.updated || record.approved !== candidate.hash || currentPlugins().listings[name]?.hash !== candidate.hash) return;
  autoNoted.add(candidate.hash);
  notePlugin("official_updates_auto", consent);
}

function approveOfficialUpdate(name: string, candidate: PluginListing, verdict: { added: string[]; runtime: boolean }, consent: ConsentToken | null): boolean {
  const s = currentPlugins();
  const before = recordOf(s, name);
  const approved = before.approved;
  if (!candidate.hash || !before.enabled || !approved || approved === candidate.hash || isRemoving(name) || s.consent?.name === name) return false;
  const updated = { from: s.listings[name]?.manifest?.version ?? null, to: candidate.manifest?.version ?? null, added: verdict.added.slice(0, MAX_UPDATE_LINES), ...(verdict.runtime ? { runtime: true as const } : {}) };
  return updateRecord(name, () => ({ ...before, approved: candidate.hash, previous: approved, updated }), consent);
}

function promoteWithRetry(name: string, candidate: PluginListing, consent: ConsentToken | null) {
  void promoteCandidate(name, candidate, consent).then((ok) => {
    if (ok) return void (retryAt.delete(`promote:${name}`), noteAutoUpdate(name, candidate, consent));
    retryAt.set(`promote:${name}`, { at: Date.now() + FIRST_RETRY_MS, wait: FIRST_RETRY_MS });
    retryLater(`promote:${name}`, FIRST_RETRY_MS, consent);
  });
}

function reconcileOfficial(consent: ConsentToken | null, now = Date.now()) {
  if (!PLATFORM_FEATURES.plugins) return;
  const s = currentPlugins();
  for (const pinned of s.pinned ?? []) {
    const name = pinned.name;
    const record = ownValue(s.records, name);
    if (!record?.approved || !record.enabled) continue;
    const listing = ownValue(s.listings, name);
    if (listing && !listing.official) continue;
    const candidate = candidateOf(s, name);
    const fetch = ownValue(s.fetches, name);
    if (fetch?.state === "fetching" || fetch?.state === "promoting") continue;
    if (candidate?.manifest && candidate.hash) {
      if (approvalMatches(candidate, record.approved)) {
        const backoff = retryAt.get(`promote:${name}`);
        if (fetch?.state === "failed" && backoff && now < backoff.at) continue;
        if (candidate.legacyHash === record.approved) {
          notePlugin("official_migrations_kept", consent);
          if (!adoptExactApproval(name, candidate, consent)) continue;
        }
        promoteWithRetry(name, candidate, consent);
      } else if (s.consent?.name !== name) {
        const verdict = officialUpdateVerdict(s, name, candidate);
        if (verdict.ok) {
          if (approveOfficialUpdate(name, candidate, verdict, consent)) promoteWithRetry(name, candidate, consent);
          else retryLater(`approve:${name}`, FIRST_RETRY_MS, consent);
        } else if (!waitingNoted.has(candidate.hash)) {
          waitingNoted.add(candidate.hash);
          notePlugin("official_updates_waiting", consent);
          notePlugin(PROMPT_COUNTS[verdict.reason], consent);
        }
      }
      continue;
    }
    if (!needsFetch(name) || inFlight.has(name)) continue;
    const backoff = retryAt.get(name);
    if (backoff && now < backoff.at) continue;
    void fetchOfficialCandidate(name, consent, true).then((result) => {
      if (result.ok) retryAt.delete(name);
      else {
        const wait = Math.min((backoff?.wait ?? FIRST_RETRY_MS / 2) * 2, LAST_RETRY_MS);
        retryAt.set(name, { at: Date.now() + wait, wait });
        retryLater(name, wait, consent);
      }
    });
  }
}

let watching = false;

export function watchOfficialUpdates() {
  if (watching) return;
  watching = true;
  afterPluginScan(reconcileOfficial);
}
